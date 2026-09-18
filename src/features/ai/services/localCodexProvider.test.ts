import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiStreamEvent, AiTurnRequest } from "../model/ai";

const { channels, invoke } = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as Array<{ onmessage?: (event: AiStreamEvent) => void }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage?: (event: AiStreamEvent) => void;
    constructor() {
      channels.push(this);
    }
  },
}));

import { LocalCodexProvider } from "./localCodexProvider";

const request: AiTurnRequest = {
  requestId: "request-1",
  prompt: "Explain the selected result.",
  model: "gpt-5.6-luna",
  reasoningEffort: "low",
};

describe("LocalCodexProvider", () => {
  beforeEach(() => {
    invoke.mockReset();
    channels.length = 0;
  });

  it("reads narrow runtime status without exposing credentials", async () => {
    const status = {
      available: true,
      authenticated: true,
      compatible: true,
      loginMethod: "chatgpt" as const,
      nodeVersion: "22.23.2",
      runtimeVersion: "0.149.0-alpha.4.1",
      message: null,
    };
    invoke.mockResolvedValueOnce(status);

    await expect(new LocalCodexProvider().getStatus()).resolves.toEqual(status);
    expect(invoke).toHaveBeenCalledWith("codex_runtime_status");
  });

  it("streams typed snapshots through a Tauri channel", async () => {
    invoke.mockImplementationOnce(async (_command, arguments_: { onEvent: { onmessage?: (event: AiStreamEvent) => void } }) => {
      arguments_.onEvent.onmessage?.({ type: "thread", threadId: "thread-1" });
      arguments_.onEvent.onmessage?.({
        type: "message",
        itemId: "item-1",
        text: "Full snapshot",
      });
      arguments_.onEvent.onmessage?.({ type: "completed", usage: null });
    });
    const events: AiStreamEvent[] = [];

    await new LocalCodexProvider().streamTurn(request, (event) => events.push(event));

    expect(invoke).toHaveBeenCalledWith("start_codex_turn", {
      request,
      onEvent: expect.anything(),
    });
    expect(events).toEqual([
      { type: "thread", threadId: "thread-1" },
      { type: "message", itemId: "item-1", text: "Full snapshot" },
      { type: "completed", usage: null },
    ]);
  });

  it("uses the dedicated cancel command and rejects malformed request ids locally", async () => {
    invoke.mockResolvedValue(undefined);
    const provider = new LocalCodexProvider();
    await provider.cancel("request-1");
    expect(invoke).toHaveBeenCalledWith("cancel_codex_turn", {
      requestId: "request-1",
    });

    await expect(
      provider.streamTurn({ ...request, requestId: "../../bad" }, vi.fn()),
    ).rejects.toThrow("Invalid Codex request id");
  });
});
