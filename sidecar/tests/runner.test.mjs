import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DISABLED_CODEX_FEATURES } from "../protocol.mjs";

const sidecarDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = path.join(sidecarDirectory, "runner.mjs");
const wrapperPath = path.join(sidecarDirectory, "codex-wrapper.sh");

async function makeFakeCodex(directory) {
  const fakePath = path.join(directory, "fake-codex.mjs");
  await writeFile(
    fakePath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const cdIndex = args.indexOf("--cd");
const workDir = cdIndex >= 0 ? args[cdIndex + 1] : process.cwd();
writeFileSync(path.join(workDir, "argv.json"), JSON.stringify(args));
writeFileSync(path.join(workDir, "env.json"), JSON.stringify({
  HOME: process.env.HOME,
  CODEX_HOME: process.env.CODEX_HOME,
  cwd: process.cwd(),
}));

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
writeFileSync(path.join(workDir, "stdin.txt"), prompt);

if (prompt.includes("__FAIL_ONCE_TEST__")) {
  process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "model is unsupported" } }) + "\\n");
  process.exit(1);
}

if (prompt.includes("__HANG_FOR_CANCEL_TEST__")) {
  await new Promise(() => {});
}

process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "0198f4f0-42b6-7000-8000-000000000001" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.updated", item: { id: "message-1", type: "agent_message", text: "partial" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "message-1", type: "agent_message", text: "final answer" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } }) + "\\n");
`,
    "utf8",
  );
  await chmod(fakePath, 0o700);
  return fakePath;
}

function startRunner({ fakeCodex, workDirectory, homeDirectory }) {
  return spawn(process.execPath, [runnerPath], {
    cwd: workDirectory,
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: homeDirectory,
      CODEX_HOME: path.join(homeDirectory, ".codex"),
      TMPDIR: os.tmpdir(),
      PAPERCANVAS_CODEX_BINARY: fakeCodex,
      PAPERCANVAS_CODEX_WRAPPER: wrapperPath,
      PAPERCANVAS_WORK_DIR: workDirectory,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function collectLines(stream) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
  });
  return () => buffer.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("runner streams only the allow-listed event projection and keeps prompt out of argv", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "papercanvas-sidecar-"));
  const workDirectory = path.join(root, "work");
  const homeDirectory = path.join(root, "home");
  await Promise.all([
    import("node:fs/promises").then(({ mkdir }) => mkdir(workDirectory)),
    import("node:fs/promises").then(({ mkdir }) => mkdir(homeDirectory)),
  ]);
  const fakeCodex = await makeFakeCodex(root);
  const child = startRunner({ fakeCodex, workDirectory, homeDirectory });
  const lines = collectLines(child.stdout);
  const maliciousPrompt = "Explain this; $(touch /tmp/never) --dangerously-bypass-approvals-and-sandbox";

  child.stdin.write(`${JSON.stringify({
    type: "start",
    requestId: "safe-request",
    prompt: maliciousPrompt,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
  })}\n`);

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  assert.equal(exitCode, 0);
  const argv = JSON.parse(await readFile(path.join(workDirectory, "argv.json"), "utf8"));
  assert.equal(argv.some((argument) => argument.includes(maliciousPrompt)), false);
  assert.equal(await readFile(path.join(workDirectory, "stdin.txt"), "utf8"), maliciousPrompt);
  assert.deepEqual(
    ["--ignore-user-config", "--ignore-rules", "--sandbox", "read-only"].every((argument) =>
      argv.includes(argument),
    ),
    true,
  );
  assert.equal(argv.includes("--ephemeral"), true);
  for (const setting of [
    "include_environment_context=false",
    "include_permissions_instructions=false",
    "include_apps_instructions=false",
    "include_collaboration_mode_instructions=false",
  ]) {
    assert.equal(argv.includes(setting), true, `${setting} reaches the pinned runtime`);
  }
  for (const setting of [
    'cli_auth_credentials_store="file"',
    'forced_login_method="chatgpt"',
  ]) {
    assert.ok(
      argv.filter((argument) => argument === setting).length >= 2,
      `${setting} is pinned by both wrapper and SDK config`,
    );
  }
  const wrapperDisabledFeatures = argv.flatMap((argument, index) =>
    argument === "--disable" ? [argv[index + 1]] : [],
  );
  assert.deepEqual(
    [...new Set(wrapperDisabledFeatures)].sort(),
    [...DISABLED_CODEX_FEATURES].sort(),
  );
  assert.equal(argv.includes("resume"), false);
  assert.deepEqual(
    lines().map((event) => event.type),
    ["thread", "message", "message", "completed"],
  );
});

test("runner exposes only the isolated home and never injects host instructions or paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "papercanvas-sidecar-privacy-"));
  const hostHome = path.join(root, "host-home-private-marker");
  const hostCodexHome = path.join(hostHome, ".codex");
  const workDirectory = path.join(root, "work");
  const homeDirectory = path.join(root, "isolated-home");
  const isolatedCodexHome = path.join(homeDirectory, ".codex");
  await Promise.all([
    mkdir(hostCodexHome, { recursive: true }),
    mkdir(workDirectory),
    mkdir(isolatedCodexHome, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(hostHome, "AGENTS.md"), "HOST_AGENT_SENTINEL", "utf8"),
    mkdir(path.join(hostCodexHome, "skills")),
    mkdir(path.join(hostCodexHome, "plugins")),
    writeFile(path.join(hostCodexHome, "auth.json"), "{}", { mode: 0o600 }),
  ]);
  await symlink(
    path.join(hostCodexHome, "auth.json"),
    path.join(isolatedCodexHome, "auth.json"),
  );
  const fakeCodex = await makeFakeCodex(root);
  const child = startRunner({ fakeCodex, workDirectory, homeDirectory });
  collectLines(child.stdout);
  const prompt = "Synthetic outbound privacy probe";

  child.stdin.end(`${JSON.stringify({
    type: "start",
    requestId: "privacy-probe",
    prompt,
    model: "gpt-5.6-luna",
  })}\n`);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  assert.equal(exitCode, 0);
  const environment = JSON.parse(await readFile(path.join(workDirectory, "env.json"), "utf8"));
  const argv = await readFile(path.join(workDirectory, "argv.json"), "utf8");
  const stdin = await readFile(path.join(workDirectory, "stdin.txt"), "utf8");
  assert.deepEqual(environment, {
    HOME: homeDirectory,
    CODEX_HOME: isolatedCodexHome,
    cwd: await realpath(workDirectory),
  });
  assert.deepEqual(await readdir(homeDirectory), [".codex"]);
  assert.deepEqual(await readdir(isolatedCodexHome), ["auth.json"]);
  assert.equal((await lstat(path.join(isolatedCodexHome, "auth.json"))).isSymbolicLink(), true);
  assert.doesNotMatch(`${argv}\n${stdin}`, /HOST_AGENT_SENTINEL|AGENTS\.md/);
  assert.doesNotMatch(stdin, /skills|plugins/);
  assert.equal(argv.includes(hostHome), false);
  assert.equal(stdin, prompt);
});

test("runner aborts a turn when it receives the bounded cancel control message", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "papercanvas-sidecar-cancel-"));
  const workDirectory = path.join(root, "work");
  const homeDirectory = path.join(root, "home");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workDirectory);
  await mkdir(homeDirectory);
  const fakeCodex = await makeFakeCodex(root);
  const child = startRunner({ fakeCodex, workDirectory, homeDirectory });
  const lines = collectLines(child.stdout);

  const start = JSON.stringify({
    type: "start",
    requestId: "cancel-request",
    prompt: "__HANG_FOR_CANCEL_TEST__",
    model: "gpt-5.6-luna",
  });
  const cancel = JSON.stringify({ type: "cancel", requestId: "cancel-request" });
  // Coalesce start + cancel to cover the stdin/readline race seen when Rust cancels
  // while the SDK sidecar is still parsing its first request.
  child.stdin.write(`${start}\n${cancel}\n`);

  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  let timeoutId;
  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("runner did not observe the coalesced cancel message"));
    }, 2_000);
  });
  const exitCode = await Promise.race([exit, deadline]);
  clearTimeout(timeoutId);

  assert.equal(exitCode, 0);
  assert.deepEqual(lines().map((event) => event.type), ["interrupted"]);
});

test("runner emits one terminal error when Codex reports a failed turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "papercanvas-sidecar-failure-"));
  const workDirectory = path.join(root, "work");
  const homeDirectory = path.join(root, "home");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workDirectory);
  await mkdir(homeDirectory);
  const fakeCodex = await makeFakeCodex(root);
  const child = startRunner({ fakeCodex, workDirectory, homeDirectory });
  const lines = collectLines(child.stdout);

  child.stdin.write(`${JSON.stringify({
    type: "start",
    requestId: "failure-request",
    prompt: "__FAIL_ONCE_TEST__",
    model: "gpt-5.6-luna",
  })}\n`);

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(lines(), [
    { type: "error", message: "The selected Codex model is not available for this account." },
  ]);
});
