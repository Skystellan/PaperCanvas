import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexOptions,
  DISABLED_CODEX_FEATURES,
  sanitizeDiagnostic,
  validateRequest,
} from "../protocol.mjs";

test("validateRequest accepts the bounded turn protocol", () => {
  const request = validateRequest({
    type: "start",
    requestId: "turn-01",
    prompt: "Explain the selected paragraph.",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    outputSchema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
  });

  assert.equal(request.requestId, "turn-01");
  assert.equal(request.model, "gpt-5.6-luna");
  assert.equal(request.outputSchema.type, "object");
});

test("validateRequest allowlists every selectable Codex model and reasoning effort", () => {
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    for (const reasoningEffort of ["low", "medium", "high", "xhigh", "max"]) {
      const request = validateRequest({
        type: "start",
        requestId: "safe-id",
        prompt: "hello",
        model,
        reasoningEffort,
      });
      assert.equal(request.model, model);
      assert.equal(request.reasoningEffort, reasoningEffort);
    }
  }
});

test("validateRequest rejects paths, argv and oversized identifiers", () => {
  assert.throws(
    () =>
      validateRequest({
        type: "start",
        requestId: "../escape",
        prompt: "hello",
        model: "gpt-5.6-luna",
      }),
    /request/i,
  );
  assert.throws(
    () =>
      validateRequest({
        type: "start",
        requestId: "safe-id",
        prompt: "hello",
        model: "gpt-5.6-luna",
        workingDirectory: "/tmp/attacker-controlled",
      }),
    /field/i,
  );
  assert.throws(
    () =>
      validateRequest({
        type: "start",
        requestId: "safe-id",
        prompt: "hello",
        model: "gpt-5.6-luna --dangerously-bypass-approvals-and-sandbox",
      }),
    /model/i,
  );
  assert.throws(
    () =>
      validateRequest({
        type: "start",
        requestId: "safe-id",
        prompt: "hello",
        model: "gpt-5.6-luna",
        outputSchema: [],
      }),
    /schema/i,
  );
  assert.throws(
    () =>
      validateRequest({
        type: "start",
        requestId: "safe-id",
        prompt: "hello",
        model: "gpt-5.6-luna",
        threadId: "0198f4f0-42b6-7000-8000-000000000001",
      }),
    /field/i,
  );
  assert.throws(
    () =>
      validateRequest({
        type: "start",
        requestId: "safe-id",
        prompt: "hello",
        model: "gpt-5.6-unknown",
      }),
    /model/i,
  );
  assert.throws(
    () =>
      validateRequest({
        type: "start",
        requestId: "safe-id",
        prompt: "hello",
        model: "gpt-5.6-luna",
        reasoningEffort: "minimal",
      }),
    /reasoning/i,
  );
});

test("buildCodexOptions pins the non-agentic safety policy", () => {
  const options = buildCodexOptions({
    codexPath: "/app/runtime/codex-wrapper.sh",
    codexBinary: "/Applications/ChatGPT.app/Contents/Resources/codex",
    workingDirectory: "/app/data/runtime/empty",
    homeDirectory: "/private/tmp/papercanvas-turn/home",
    codexHome: "/private/tmp/papercanvas-turn/home/.codex",
    nodeDirectory: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin",
  });

  assert.equal(options.client.codexPathOverride, "/app/runtime/codex-wrapper.sh");
  assert.deepEqual(options.thread, {
    sandboxMode: "read-only",
    workingDirectory: "/app/data/runtime/empty",
    skipGitRepoCheck: true,
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
  });
  assert.deepEqual(
    Object.keys(options.client.config.features).sort(),
    [...DISABLED_CODEX_FEATURES].sort(),
  );
  for (const feature of DISABLED_CODEX_FEATURES) {
    assert.equal(options.client.config.features[feature], false);
  }
  for (const setting of [
    "include_environment_context",
    "include_permissions_instructions",
    "include_apps_instructions",
    "include_collaboration_mode_instructions",
  ]) {
    assert.equal(options.client.config[setting], false);
  }
  assert.equal(options.client.config.cli_auth_credentials_store, "file");
  assert.equal(options.client.config.forced_login_method, "chatgpt");
  assert.equal(options.client.env.PAPERCANVAS_CODEX_BINARY, options.codexBinary);
  assert.equal(options.client.env.HOME, "/private/tmp/papercanvas-turn/home");
  assert.equal(options.client.env.CODEX_HOME, "/private/tmp/papercanvas-turn/home/.codex");
  assert.equal(options.client.env.OPENAI_API_KEY, undefined);
  assert.doesNotMatch(JSON.stringify(options), /\/Users\/example/);
});

test("sanitizeDiagnostic removes credentials and absolute home paths", () => {
  const diagnostic = sanitizeDiagnostic(
    "Bearer abc.def.ghi sk-proj-supersecret /Users/alice/.codex/auth.json CODEX_API_KEY=value",
    "/Users/alice",
  );

  assert.doesNotMatch(diagnostic, /abc\.def|sk-proj|\/Users\/alice|value/);
  assert.match(diagnostic, /\[redacted/);
});
