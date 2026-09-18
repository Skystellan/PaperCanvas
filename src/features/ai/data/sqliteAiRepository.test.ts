import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqliteDatabase } from "../../../data/sqliteDatabase";
import {
  DEFAULT_CODEX_MODEL,
  LOCAL_CODEX_PROVIDER,
} from "../model/ai";
import { SqliteAiRepository } from "./sqliteAiRepository";

describe("SqliteAiRepository", () => {
  const execute = vi.fn();
  const select = vi.fn();
  const database = { execute, select } as unknown as SqliteDatabase;
  const repository = new SqliteAiRepository(async () => database);

  beforeEach(() => {
    execute.mockReset();
    select.mockReset();
    execute.mockResolvedValue({ rowsAffected: 1 });
  });

  it("loads and saves the single local Codex setting without API keys", async () => {
    select.mockResolvedValueOnce([
      {
        provider: LOCAL_CODEX_PROVIDER,
        model: "gpt-5.6-terra",
        reasoning_effort: "high",
        updated_at: 42,
      },
    ]);

    await expect(repository.getSettings()).resolves.toEqual({
      provider: LOCAL_CODEX_PROVIDER,
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      updatedAt: 42,
    });

    await repository.saveSettings(
      {
        provider: LOCAL_CODEX_PROVIDER,
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        updatedAt: 99,
      },
      "session-1",
    );

    expect(execute).toHaveBeenLastCalledWith(
      expect.stringContaining("UPDATE ai_runtime_settings"),
      ["gpt-5.6-sol", "max", 99, "session-1"],
    );
    expect(execute.mock.calls[execute.mock.calls.length - 1]?.[0]).toContain(
      "applied_session_id",
    );
  });

  it("falls back safely when persisted model settings are not allowlisted", async () => {
    select.mockResolvedValueOnce([
      {
        provider: LOCAL_CODEX_PROVIDER,
        model: "gpt-5.6-luna --dangerously-bypass-approvals-and-sandbox",
        reasoning_effort: "minimal",
        updated_at: 42,
      },
    ]);

    await expect(repository.getSettings()).resolves.toEqual({
      provider: LOCAL_CODEX_PROVIDER,
      model: DEFAULT_CODEX_MODEL,
      reasoningEffort: "medium",
      updatedAt: 42,
    });
  });

  it("creates, lists, renames, and deletes chat sessions with bound values", async () => {
    await repository.createSession({
      id: "session-1",
      model: DEFAULT_CODEX_MODEL,
      timestamp: 10,
      title: "Paper discussion",
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO chat_sessions"),
      [
        "session-1",
        "Paper discussion",
        LOCAL_CODEX_PROVIDER,
        DEFAULT_CODEX_MODEL,
        10,
      ],
    );

    select.mockResolvedValueOnce([
      {
        id: "session-1",
        title: "Paper discussion",
        provider: LOCAL_CODEX_PROVIDER,
        model: DEFAULT_CODEX_MODEL,
        codex_thread_id: null,
        context_revision: 0,
        codex_context_revision: null,
        runtime_sync_state: "new",
        created_at: 10,
        updated_at: 10,
      },
    ]);
    await expect(repository.listSessions()).resolves.toHaveLength(1);

    await repository.renameSession("session-1", "Renamed", 11);
    expect(execute).toHaveBeenLastCalledWith(
      expect.stringContaining("UPDATE chat_sessions"),
      ["Renamed", 11, "session-1"],
    );

    await repository.deleteSession("session-1");
    expect(execute).toHaveBeenLastCalledWith(
      expect.stringContaining("DELETE FROM chat_sessions"),
      ["session-1"],
    );
  });

  it("loads messages and explicitly attached papers in stable order", async () => {
    select
      .mockResolvedValueOnce([
        {
          id: "session-1",
          title: "Discussion",
          provider: LOCAL_CODEX_PROVIDER,
          model: DEFAULT_CODEX_MODEL,
          codex_thread_id: "thread-1",
          context_revision: 2,
          codex_context_revision: 2,
          runtime_sync_state: "synced",
          created_at: 1,
          updated_at: 4,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "message-1",
          session_id: "session-1",
          role: "user",
          content: "Question",
          status: "complete",
          position: 0,
          created_at: 2,
          updated_at: 2,
        },
      ])
      .mockResolvedValueOnce([
        {
          session_id: "session-1",
          paper_id: "paper-1",
          position: 0,
          context_created_at: 3,
          id: "paper-1",
          title: "Paper",
          authors: null,
          year: null,
          file_path: "papers/one.pdf",
          domain_id: "domain-ai",
          paper_created_at: 1,
        },
      ]);

    const snapshot = await repository.loadSession("session-1");

    expect(snapshot?.messages[0]).toMatchObject({
      content: "Question",
      role: "user",
    });
    expect(snapshot?.contexts[0]).toMatchObject({
      paperId: "paper-1",
      paper: {
        title: "Paper",
        filePath: "papers/one.pdf",
        domainId: "domain-ai",
      },
    });
    expect(select.mock.calls[1][1]).toEqual(["session-1"]);
    expect(select.mock.calls[2][1]).toEqual(["session-1"]);
  });

  it("adds and removes only explicit context and relies on the revision trigger", async () => {
    await repository.addContext("session-1", "paper-1", 50);
    expect(execute).toHaveBeenLastCalledWith(
      expect.stringContaining("INSERT INTO chat_contexts"),
      ["session-1", "paper-1", 50],
    );

    await repository.removeContext("session-1", "paper-1", 60);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM chat_contexts"),
      ["session-1", "paper-1"],
    );
    expect(execute).toHaveBeenLastCalledWith(
      expect.stringContaining("UPDATE chat_sessions"),
      [60, "session-1"],
    );
  });

  it("begins both sides of a turn atomically, then persists stream recovery", async () => {
    await repository.beginTurn({
      assistantMessageId: "message-2",
      nextPosition: 3,
      sessionId: "session-1",
      timestamp: 70,
      userContent: "Question",
      userMessageId: "message-1",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenLastCalledWith(
      expect.stringContaining("INSERT INTO chat_messages"),
      [
        "session-1",
        "message-1",
        "Question",
        "message-2",
        3,
        70,
      ],
    );
    expect(execute.mock.calls[0]?.[0]).toContain("'user'");
    expect(execute.mock.calls[0]?.[0]).toContain("'assistant'");

    await repository.updateMessage({
      content: "Final answer",
      id: "message-2",
      status: "complete",
      timestamp: 71,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE chat_messages"),
      ["Final answer", "complete", 71, "message-2"],
    );
    expect(execute).toHaveBeenLastCalledWith(
      expect.stringContaining("SELECT session_id FROM chat_messages"),
      [71, "message-2"],
    );

    execute.mockResolvedValueOnce({ rowsAffected: 2 });
    await expect(repository.markStreamingMessagesInterrupted(72)).resolves.toBe(2);
  });

  it("stores full extracted paper text and never rewrites it through string interpolation", async () => {
    const text = {
      paperId: "paper-1",
      status: "ready" as const,
      content: "full ' paper text",
      pageCount: 2,
      charCount: 17,
      errorCode: null,
      updatedAt: 80,
    };
    await repository.savePaperText(text);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO paper_texts"),
      ["paper-1", "ready", "full ' paper text", 2, 17, null, 80],
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining(
        "WHERE paper_texts.status <> 'ready' OR excluded.status = 'ready'",
      ),
      expect.any(Array),
    );

    select.mockResolvedValueOnce([
      {
        paper_id: "paper-1",
        status: "ready",
        content: "full ' paper text",
        page_count: 2,
        char_count: 17,
        error_code: null,
        updated_at: 80,
      },
    ]);
    await expect(repository.getPaperText("paper-1")).resolves.toEqual(text);
  });
});
