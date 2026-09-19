import { Channel, invoke } from "../../../platform/core";
import type {
  AIProvider,
  AiStreamEvent,
  AiTurnRequest,
  CodexRuntimeStatus,
} from "../model/ai";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_PROMPT_CHARACTERS = 600_000;

function validateRequest(request: AiTurnRequest): void {
  if (!REQUEST_ID_PATTERN.test(request.requestId)) {
    throw new Error("Invalid Codex request id.");
  }
  if (!request.prompt.trim() || request.prompt.length > MAX_PROMPT_CHARACTERS) {
    throw new Error("Codex prompt is empty or exceeds the local bridge limit.");
  }
}

export class LocalCodexProvider implements AIProvider {
  getStatus(): Promise<CodexRuntimeStatus> {
    return invoke<CodexRuntimeStatus>("codex_runtime_status");
  }

  async streamTurn(
    request: AiTurnRequest,
    onEvent: (event: AiStreamEvent) => void,
  ): Promise<void> {
    validateRequest(request);
    const onEventChannel = new Channel<AiStreamEvent>();
    onEventChannel.onmessage = onEvent;
    await invoke("start_codex_turn", { request, onEvent: onEventChannel });
  }

  async cancel(requestId: string): Promise<void> {
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw new Error("Invalid Codex request id.");
    }
    await invoke("cancel_codex_turn", { requestId });
  }
}

export const localCodexProvider = new LocalCodexProvider();
