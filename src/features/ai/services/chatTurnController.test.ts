import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Paper } from "../../library";
import type { AiRepository } from "../data/aiRepository";
import {
  DEFAULT_CODEX_MODEL,
  LOCAL_CODEX_PROVIDER,
  type AIProvider,
  type ChatSessionSnapshot,
} from "../model/ai";
import { MAX_ESTIMATED_INPUT_TOKENS } from "../model/contextBudget";
import {
  ChatContextOverflowError,
  ChatTurnController,
  buildCodexPrompt,
} from "./chatTurnController";

const paper: Paper = {
  id: "paper-1",
  title: "Explicit paper",
  authors: "Author",
  year: 2026,
  filePath: "papers/paper-1.pdf",
  domainId: null,
  createdAt: 1,
};

function snapshot(
  overrides: Partial<ChatSessionSnapshot["session"]> = {},
): ChatSessionSnapshot {
  return {
    session: {
      id: "session-1",
      title: "Discussion",
      provider: LOCAL_CODEX_PROVIDER,
      model: DEFAULT_CODEX_MODEL,
      codexThreadId: null,
      contextRevision: 0,
      codexContextRevision: null,
      runtimeSyncState: "new",
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    },
    messages: [],
    contexts: [],
  };
}

describe("buildCodexPrompt", () => {
  it("always rebuilds from local history and only explicitly attached full papers", () => {
    const prompt = buildCodexPrompt({
      messages: [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
      ],
      paperTexts: [{ paper, content: "COMPLETE PAPER TEXT" }],
      userPrompt: "Current question",
    });

    expect(prompt).toContain("BEGIN EXPLICIT PAPER CONTEXT: Explicit paper");
    expect(prompt).toContain("COMPLETE PAPER TEXT");
    expect(prompt).toContain("Earlier question");
    expect(prompt).toContain("Current question");
    expect(prompt).not.toContain("silently truncate");
  });
});

describe("ChatTurnController", () => {
  const repository = {
    beginTurn: vi.fn(),
    getPaperText: vi.fn(),
    updateMessage: vi.fn(),
    updateRuntimeSync: vi.fn(),
  } as unknown as AiRepository;
  const provider = {
    cancel: vi.fn(),
    getStatus: vi.fn(),
    streamTurn: vi.fn(),
  } as unknown as AIProvider;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(repository.beginTurn).mockReset();
    vi.mocked(repository.getPaperText).mockReset();
    vi.mocked(repository.updateMessage).mockReset();
    vi.mocked(repository.updateRuntimeSync).mockReset();
    vi.mocked(provider.streamTurn).mockReset();
    vi.mocked(provider.cancel).mockReset();
    vi.mocked(repository.beginTurn).mockImplementation(async (input) => ({
      userMessage: {
        id: input.userMessageId,
        sessionId: input.sessionId,
        role: "user",
        content: input.userContent,
        status: "complete",
        position: input.nextPosition,
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      },
      assistantMessage: {
        id: input.assistantMessageId,
        sessionId: input.sessionId,
        role: "assistant",
        content: "",
        status: "streaming",
        position: input.nextPosition + 1,
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      },
    }));
    vi.mocked(repository.updateMessage).mockResolvedValue(undefined);
    vi.mocked(repository.updateRuntimeSync).mockResolvedValue(undefined);
  });

  it("streams snapshots, persists completion, and synchronizes the Codex thread", async () => {
    vi.mocked(provider.streamTurn).mockImplementation(async (_request, onEvent) => {
      onEvent({ type: "thread", threadId: "thread-1" });
      onEvent({ type: "message", itemId: "answer", text: "Partial" });
      onEvent({ type: "message", itemId: "answer", text: "Final answer" });
      onEvent({ type: "completed", usage: null });
    });
    const onSnapshot = vi.fn();
    const controller = new ChatTurnController(
      repository,
      provider,
      () => 100,
      vi.fn().mockReturnValueOnce("user-id").mockReturnValueOnce("assistant-id").mockReturnValueOnce("request-id"),
    );

    const result = await controller.send({
      snapshot: snapshot(),
      settings: {
        provider: LOCAL_CODEX_PROVIDER,
        model: DEFAULT_CODEX_MODEL,
        reasoningEffort: "low",
        updatedAt: 1,
      },
      userPrompt: "Explain this",
      onSnapshot,
    });

    expect(provider.streamTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-id",
        model: DEFAULT_CODEX_MODEL,
      }),
      expect.any(Function),
    );
    expect(vi.mocked(provider.streamTurn).mock.calls[0][0]).not.toHaveProperty(
      "threadId",
    );
    expect(onSnapshot).toHaveBeenLastCalledWith("Final answer");
    expect(repository.updateMessage).toHaveBeenCalledTimes(2);
    expect(repository.updateMessage).toHaveBeenLastCalledWith({
      id: "assistant-id",
      content: "Final answer",
      status: "complete",
      timestamp: 100,
    });
    expect(repository.updateRuntimeSync).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      codexThreadId: null,
      codexContextRevision: null,
      state: "new",
      timestamp: 100,
    });
    expect(result.assistantMessage.content).toBe("Final answer");
  });

  it("never resumes a Codex session and rebuilds from SQLite history", async () => {
    vi.mocked(provider.streamTurn).mockImplementation(async (_request, onEvent) => {
      onEvent({ type: "completed", usage: null });
    });
    const controller = new ChatTurnController(repository, provider, () => 1, () => crypto.randomUUID());
    const prior = snapshot({
        codexThreadId: "thread-1",
        contextRevision: 3,
        codexContextRevision: 3,
        runtimeSyncState: "synced",
      });
    prior.messages = [
      {
        id: "old-message",
        sessionId: "session-1",
        role: "assistant",
        content: "Earlier local answer",
        status: "complete",
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    await controller.send({
      snapshot: prior,
      settings: {
        provider: LOCAL_CODEX_PROVIDER,
        model: DEFAULT_CODEX_MODEL,
        reasoningEffort: "low",
        updatedAt: 1,
      },
      userPrompt: "Follow up",
    });

    expect(provider.streamTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Earlier local answer"),
      }),
      expect.any(Function),
    );
    expect(vi.mocked(provider.streamTurn).mock.calls[0][0]).not.toHaveProperty(
      "threadId",
    );
  });

  it("blocks oversized full context before writing messages or calling Codex", async () => {
    vi.mocked(repository.getPaperText).mockResolvedValue({
      paperId: paper.id,
      status: "ready",
      content: "x".repeat(MAX_ESTIMATED_INPUT_TOKENS * 4 + 1),
      pageCount: 1,
      charCount: MAX_ESTIMATED_INPUT_TOKENS * 4 + 1,
      errorCode: null,
      updatedAt: 1,
    });
    const controller = new ChatTurnController(repository, provider);
    const withContext = snapshot();
    withContext.contexts = [
      { sessionId: "session-1", paperId: paper.id, position: 0, createdAt: 1, paper },
    ];

    await expect(
      controller.send({
        snapshot: withContext,
        settings: {
          provider: LOCAL_CODEX_PROVIDER,
          model: DEFAULT_CODEX_MODEL,
          reasoningEffort: "low",
          updatedAt: 1,
        },
        userPrompt: "Question",
      }),
    ).rejects.toBeInstanceOf(ChatContextOverflowError);
    expect(repository.beginTurn).not.toHaveBeenCalled();
    expect(provider.streamTurn).not.toHaveBeenCalled();
  });

  it("does not call Codex when the atomic turn start cannot be persisted", async () => {
    vi.mocked(repository.beginTurn).mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const controller = new ChatTurnController(repository, provider);

    await expect(
      controller.send({
        snapshot: snapshot(),
        settings: {
          provider: LOCAL_CODEX_PROVIDER,
          model: DEFAULT_CODEX_MODEL,
          reasoningEffort: "low",
          updatedAt: 1,
        },
        userPrompt: "Question",
      }),
    ).rejects.toThrow("database unavailable");

    expect(repository.beginTurn).toHaveBeenCalledOnce();
    expect(provider.streamTurn).not.toHaveBeenCalled();
    expect(repository.updateMessage).not.toHaveBeenCalled();
  });

  it("delegates stop to the active request id", async () => {
    const controller = new ChatTurnController(repository, provider);
    await controller.cancel("turn-1");
    expect(provider.cancel).toHaveBeenCalledWith("turn-1");
  });
});
