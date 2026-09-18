import os from "node:os";
import path from "node:path";

export const SDK_VERSION = "0.149.0-alpha.4.1";
export const MAX_PROMPT_BYTES = 8 * 1024 * 1024;
// JSON escaping can expand a string by up to 6x. Keep the serialized event under
// the Rust bridge's 12 MiB bounded-line ceiling without silently truncating text.
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

// The Codex runtime is used as a text-only model transport. Explicitly disable
// every pinned-runtime feature that can read host data, execute actions, load
// extensions, prompt for authority, or mutate external/local state. The shell
// wrapper repeats this denylist so an SDK serialization change fails closed.
export const DISABLED_CODEX_FEATURES = Object.freeze([
  "apps",
  "artifact",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode",
  "code_mode_host",
  "code_mode_interrupt",
  "code_mode_only",
  "computer_use",
  "current_time_reminder",
  "default_mode_request_user_input",
  "deferred_executor",
  "deferred_tool_world_state",
  "enable_mcp_apps",
  "exec_permission_approvals",
  "executed_tool_call_metadata",
  "executor_capability_discovery",
  "external_agent_memory_import",
  "goals",
  "guardian_approval",
  "hooks",
  "image_generation",
  "in_app_browser",
  "in_app_updates",
  "memories",
  "mentions_v2",
  "multi_agent",
  "multi_agent_v2",
  "network_proxy",
  "plugins",
  "plugin_sharing",
  "prevent_idle_sleep",
  "psp",
  "realtime_conversation",
  "recommended_plugins",
  "remote_plugin",
  "request_permissions_tool",
  "shell_snapshot",
  "shell_tool",
  "skill_mcp_dependency_install",
  "skill_search",
  "standalone_web_search",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unavailable_dummy_tools",
  "unified_exec",
  "view_image",
  "workspace_dependencies",
]);

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SUPPORTED_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const START_FIELDS = new Set([
  "type",
  "requestId",
  "prompt",
  "model",
  "reasoningEffort",
  "outputSchema",
]);

function assertPlainObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactFields(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Unsupported request field: ${key}`);
    }
  }
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} must be an absolute path`);
  }
}

export function validateRequest(value) {
  assertPlainObject(value, "Request");
  assertExactFields(value, START_FIELDS);
  if (value.type !== "start") {
    throw new Error("Request type must be start");
  }
  if (typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId)) {
    throw new Error("Invalid request id");
  }
  if (typeof value.prompt !== "string" || value.prompt.trim().length === 0) {
    throw new Error("Prompt must not be empty");
  }
  if (Buffer.byteLength(value.prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error("Prompt exceeds the supported context transfer size");
  }
  if (typeof value.model !== "string" || !SUPPORTED_MODELS.has(value.model)) {
    throw new Error("Unsupported model");
  }
  if (
    value.reasoningEffort !== undefined &&
    (typeof value.reasoningEffort !== "string" || !REASONING_EFFORTS.has(value.reasoningEffort))
  ) {
    throw new Error("Invalid reasoning effort");
  }
  if (value.outputSchema !== undefined) {
    assertPlainObject(value.outputSchema, "Output schema");
    if (Buffer.byteLength(JSON.stringify(value.outputSchema), "utf8") > 256 * 1024) {
      throw new Error("Output schema exceeds the supported size");
    }
  }
  return Object.freeze({
    type: "start",
    requestId: value.requestId,
    prompt: value.prompt,
    model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
    ...(value.outputSchema === undefined ? {} : { outputSchema: value.outputSchema }),
  });
}

export function validateCancel(value, expectedRequestId) {
  assertPlainObject(value, "Control message");
  assertExactFields(value, new Set(["type", "requestId"]));
  if (value.type !== "cancel" || value.requestId !== expectedRequestId) {
    throw new Error("Invalid cancel message");
  }
  return Object.freeze({ type: "cancel", requestId: value.requestId });
}

export function buildCodexOptions({
  codexPath,
  codexBinary,
  workingDirectory,
  homeDirectory,
  codexHome,
  nodeDirectory,
}) {
  assertAbsolutePath(codexPath, "Codex wrapper");
  assertAbsolutePath(codexBinary, "Codex binary");
  assertAbsolutePath(workingDirectory, "Working directory");
  assertAbsolutePath(homeDirectory, "Home directory");
  assertAbsolutePath(codexHome, "Codex home");
  assertAbsolutePath(nodeDirectory, "Node directory");

  return Object.freeze({
    codexBinary,
    client: {
      codexPathOverride: codexPath,
      config: {
        cli_auth_credentials_store: "file",
        forced_login_method: "chatgpt",
        include_environment_context: false,
        include_permissions_instructions: false,
        include_apps_instructions: false,
        include_collaboration_mode_instructions: false,
        features: Object.fromEntries(
          DISABLED_CODEX_FEATURES.map((feature) => [feature, false]),
        ),
      },
      env: {
        PATH: [nodeDirectory, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter),
        HOME: homeDirectory,
        CODEX_HOME: codexHome,
        TMPDIR: os.tmpdir(),
        PAPERCANVAS_CODEX_BINARY: codexBinary,
      },
    },
    thread: {
      sandboxMode: "read-only",
      workingDirectory,
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
    },
  });
}

export function sanitizeDiagnostic(value, homeDirectory = "") {
  let text = String(value ?? "");
  if (homeDirectory) {
    text = text.split(homeDirectory).join("[redacted-home]");
  }
  return text
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted-token]")
    .replace(/\bsk-[A-Za-z0-9._-]+/g, "[redacted-key]")
    .replace(/\b(?:CODEX_API_KEY|OPENAI_API_KEY)\s*=\s*[^\s]+/gi, "$1=[redacted-secret]")
    .replace(/(?:auth\.json|config\.toml)/gi, "[redacted-auth-file]")
    .slice(0, 2_000);
}

export function publicErrorMessage(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  if (message.includes("not logged in") || message.includes("login")) {
    return "Codex is not signed in with ChatGPT.";
  }
  if (message.includes("model") && (message.includes("not found") || message.includes("unsupported"))) {
    return "The selected Codex model is not available for this account.";
  }
  if (message.includes("abort")) {
    return "The Codex turn was interrupted.";
  }
  return "The local Codex runtime could not complete this turn.";
}

export function emitEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function projectUsage(usage) {
  const number = (value) =>
    Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return {
    inputTokens: number(usage?.input_tokens),
    cachedInputTokens: number(usage?.cached_input_tokens),
    cacheWriteInputTokens: number(usage?.cache_write_input_tokens),
    outputTokens: number(usage?.output_tokens),
    reasoningOutputTokens: number(usage?.reasoning_output_tokens),
  };
}

export function projectMessage(item) {
  if (item?.type !== "agent_message" || typeof item.text !== "string") {
    return null;
  }
  if (Buffer.byteLength(item.text, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("Agent message exceeds the supported transfer size");
  }
  if (typeof item.id !== "string" || item.id.length === 0 || item.id.length > 256) {
    throw new Error("Agent message has an invalid item id");
  }
  return { type: "message", itemId: item.id, text: item.text };
}
