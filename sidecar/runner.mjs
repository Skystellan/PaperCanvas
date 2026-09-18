import readline from "node:readline";

import { Codex } from "./vendor/codex-sdk.mjs";
import {
  buildCodexOptions,
  emitEvent,
  projectMessage,
  projectUsage,
  publicErrorMessage,
  sanitizeDiagnostic,
  validateCancel,
  validateRequest,
} from "./protocol.mjs";

function createInputQueue(interface_) {
  let receivedStart = false;
  let controlHandler;
  const pendingControls = [];
  let resolveStart;
  let rejectStart;
  const start = new Promise((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });

  interface_.on("line", (line) => {
    if (!receivedStart) {
      receivedStart = true;
      resolveStart(line);
    } else if (controlHandler) {
      controlHandler(line);
    } else {
      pendingControls.push(line);
    }
  });
  interface_.once("close", () => {
    if (!receivedStart) {
      rejectStart(new Error("Runtime input closed before a request was received"));
    }
  });

  return {
    start,
    setControlHandler(handler) {
      controlHandler = handler;
      for (const line of pendingControls.splice(0)) handler(line);
    },
  };
}

async function streamTurn(request, abortController) {
  const homeDirectory = process.env.HOME;
  const codexHome = process.env.CODEX_HOME;
  const codexBinary = process.env.PAPERCANVAS_CODEX_BINARY;
  const codexPath = process.env.PAPERCANVAS_CODEX_WRAPPER;
  const workingDirectory = process.env.PAPERCANVAS_WORK_DIR;
  const nodeDirectory = new URL(".", `file://${process.execPath}`).pathname.replace(/\/$/, "");
  const options = buildCodexOptions({
    codexPath,
    codexBinary,
    workingDirectory,
    homeDirectory,
    codexHome,
    nodeDirectory,
  });
  const codex = new Codex(options.client);
  const threadOptions = {
    ...options.thread,
    model: request.model,
    ...(request.reasoningEffort === undefined
      ? {}
      : { modelReasoningEffort: request.reasoningEffort }),
  };
  // PaperCanvas rebuilds every turn from its SQLite history and explicit paper context.
  // Never resume a Codex session: --ephemeral keeps full paper prompts out of CODEX_HOME.
  const thread = codex.startThread(threadOptions);
  const { events } = await thread.runStreamed(request.prompt, {
    signal: abortController.signal,
    ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
  });
  let terminal = false;

  for await (const event of events) {
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      emitEvent({ type: "thread", threadId: event.thread_id });
    } else if (event.type === "item.updated" || event.type === "item.completed") {
      const message = projectMessage(event.item);
      if (message) emitEvent(message);
    } else if (event.type === "turn.completed") {
      emitEvent({ type: "completed", usage: projectUsage(event.usage) });
      terminal = true;
      break;
    } else if (event.type === "turn.failed" || event.type === "error") {
      emitEvent({ type: "error", message: publicErrorMessage(event.error ?? event.message) });
      terminal = true;
      break;
    }
  }

  if (!terminal && !abortController.signal.aborted) {
    throw new Error("Codex stream ended without a terminal event");
  }
}

async function main() {
  const interface_ = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const input = createInputQueue(interface_);
  let abortController;

  try {
    const firstLine = await input.start;
    const request = validateRequest(JSON.parse(firstLine));
    abortController = new AbortController();
    input.setControlHandler((line) => {
      try {
        validateCancel(JSON.parse(line), request.requestId);
        abortController.abort();
      } catch {
        // Ignore any input that is not the exact, bounded cancel protocol.
      }
    });
    await streamTurn(request, abortController);
  } catch (error) {
    if (abortController?.signal.aborted || error?.name === "AbortError") {
      emitEvent({ type: "interrupted" });
      return;
    }
    process.stderr.write(`${sanitizeDiagnostic(error, process.env.HOME)}\n`);
    emitEvent({ type: "error", message: publicErrorMessage(error) });
    process.exitCode = 1;
  } finally {
    interface_.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${sanitizeDiagnostic(error, process.env.HOME)}\n`);
  emitEvent({ type: "error", message: publicErrorMessage(error) });
  process.exitCode = 1;
});
