import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Paper, PaperRepository } from "../library";
import type { AiRepository, BeginTurnInput } from "./data/aiRepository";
import {
  DEFAULT_CODEX_MODEL,
  LOCAL_CODEX_PROVIDER,
  type AIProvider,
  type ChatContext,
  type ChatMessage,
  type ChatSession,
  type ChatSessionSnapshot,
  type StoredPaperText,
} from "./model/ai";
import type { PaperTextService } from "./services/paperTextService";
import { PaperTextExtractionError } from "./services/paperTextExtractor";
import { ChatPanel } from "./ChatPanel";

const persistence = vi.hoisted(() => ({
  writer: null as null | { isDirty(): boolean; flush(): Promise<void> },
}));

vi.mock("../persistence", () => ({
  usePersistenceWriter: (
    _name: string,
    writer: { isDirty(): boolean; flush(): Promise<void> },
  ) => {
    persistence.writer = writer;
  },
}));

const paper: Paper = {
  id: "paper-1",
  title: "Attention Is All You Need",
  authors: "Vaswani et al.",
  year: 2017,
  filePath: "papers/attention.pdf",
  createdAt: 1,
  domainId: null,
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createRepository() {
  const session: ChatSession = {
    id: "session-1",
    title: "Transformer notes",
    provider: LOCAL_CODEX_PROVIDER,
    model: DEFAULT_CODEX_MODEL,
    codexThreadId: null,
    contextRevision: 0,
    codexContextRevision: null,
    runtimeSyncState: "new",
    createdAt: 1,
    updatedAt: 1,
  };
  const messages: ChatMessage[] = [];
  const contexts: ChatContext[] = [];
  const repository: AiRepository = {
    addContext: vi.fn(async (sessionId, paperId, timestamp) => {
      contexts.push({ sessionId, paperId, position: contexts.length, createdAt: timestamp });
      session.contextRevision += 1;
      session.runtimeSyncState = "desynced";
    }),
    beginTurn: vi.fn(async (input: BeginTurnInput) => {
      const userMessage: ChatMessage = {
        id: input.userMessageId,
        sessionId: input.sessionId,
        role: "user",
        content: input.userContent,
        status: "complete",
        position: input.nextPosition,
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      };
      const assistantMessage: ChatMessage = {
        id: input.assistantMessageId,
        sessionId: input.sessionId,
        role: "assistant",
        content: "",
        status: "streaming",
        position: input.nextPosition + 1,
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      };
      messages.push(userMessage, assistantMessage);
      return { assistantMessage, userMessage };
    }),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    getPaperText: vi.fn(async () => ({
      paperId: paper.id,
      status: "ready" as const,
      content: "Complete transformer paper text",
      pageCount: 15,
      charCount: 31,
      errorCode: null,
      updatedAt: 1,
    })),
    getSettings: vi.fn(async () => ({
      provider: LOCAL_CODEX_PROVIDER,
      model: "gpt-5.6-luna" as const,
      reasoningEffort: "low" as const,
      updatedAt: 1,
    })),
    listSessions: vi.fn(async () => [session]),
    loadSession: vi.fn(async () => ({
      session: { ...session },
      messages: messages.map((message) => ({ ...message })),
      contexts: contexts.map((context) => ({ ...context, paper })),
    })),
    markStreamingMessagesInterrupted: vi.fn(async () => 0),
    removeContext: vi.fn(async (_sessionId, paperId) => {
      const index = contexts.findIndex((context) => context.paperId === paperId);
      if (index >= 0) contexts.splice(index, 1);
      session.contextRevision += 1;
      session.runtimeSyncState = "desynced";
    }),
    renameSession: vi.fn(async (_id, title) => {
      session.title = title;
    }),
    savePaperText: vi.fn(),
    saveSettings: vi.fn(async (settings) => {
      session.model = settings.model;
    }),
    updateMessage: vi.fn(async ({ content, id, status, timestamp }) => {
      const message = messages.find((item) => item.id === id);
      if (message) Object.assign(message, { content, status, updatedAt: timestamp });
    }),
    updateRuntimeSync: vi.fn(async (input) => {
      session.codexThreadId = input.codexThreadId;
      session.codexContextRevision = input.codexContextRevision;
      session.runtimeSyncState = input.state;
    }),
  };
  return { contexts, messages, repository, session };
}

function createProvider(): AIProvider {
  return {
    cancel: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({
      available: true,
      authenticated: true,
      compatible: true,
      loginMethod: "chatgpt" as const,
      nodeVersion: "22.23.2",
      runtimeVersion: "0.149.0-alpha.4.1",
      message: null,
    })),
    streamTurn: vi.fn(async (_request, onEvent) => {
      onEvent({ type: "thread", threadId: "codex-thread-1" });
      onEvent({
        type: "message",
        itemId: "answer-1",
        text: "**Attention** replaces recurrence with self-attention.",
      });
      onEvent({ type: "completed", usage: null });
    }),
  };
}

describe("ChatPanel", () => {
  it("restores the active discussion selected before the reader was reopened", async () => {
    const { repository, session } = createRepository();
    const olderSession: ChatSession = {
      ...session,
      id: "session-older",
      title: "Earlier close reading",
      updatedAt: 0,
    };
    repository.listSessions = vi.fn(async () => [session, olderSession]);
    repository.loadSession = vi.fn(async (sessionId) => ({
      session: { ...(sessionId === olderSession.id ? olderSession : session) },
      contexts: [],
      messages: [],
    }));
    const onActiveSessionChange = vi.fn();

    render(
      <ChatPanel
        initialSessionId={olderSession.id}
        onActiveSessionChange={onActiveSessionChange}
        paperRepository={{ list: vi.fn(async () => []), getById: vi.fn() }}
        paperTextService={{ ensureReady: vi.fn() } as unknown as PaperTextService}
        provider={createProvider()}
        repository={repository}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: olderSession.title }),
    ).toBeVisible();
    expect(onActiveSessionChange).toHaveBeenCalledWith(olderSession.id);

    await userEvent.selectOptions(
      screen.getByLabelText("Discussion history"),
      session.id,
    );
    expect(
      await screen.findByRole("heading", { name: session.title }),
    ).toBeVisible();
    expect(onActiveSessionChange).toHaveBeenLastCalledWith(session.id);
  });

  it("keeps the latest discussion choice when session loads finish out of order", async () => {
    const { repository, session } = createRepository();
    const middleSession = {
      ...session,
      id: "session-middle",
      title: "Middle discussion",
      updatedAt: 2,
    };
    const latestSession = {
      ...session,
      id: "session-latest",
      title: "Latest discussion",
      updatedAt: 3,
    };
    repository.listSessions = vi.fn(async () => [
      session,
      middleSession,
      latestSession,
    ]);
    const onActiveSessionChange = vi.fn();
    render(
      <ChatPanel
        onActiveSessionChange={onActiveSessionChange}
        paperRepository={{ list: vi.fn(async () => []), getById: vi.fn() }}
        paperTextService={{ ensureReady: vi.fn() } as unknown as PaperTextService}
        provider={createProvider()}
        repository={repository}
      />,
    );
    await screen.findByRole("heading", { name: session.title });
    const middleLoad = createDeferred<ChatSessionSnapshot | null>();
    const latestLoad = createDeferred<ChatSessionSnapshot | null>();
    vi.mocked(repository.loadSession).mockImplementation((sessionId) =>
      sessionId === middleSession.id ? middleLoad.promise : latestLoad.promise,
    );
    const history = screen.getByLabelText("Discussion history");

    fireEvent.change(history, { target: { value: middleSession.id } });
    fireEvent.change(history, { target: { value: latestSession.id } });
    await act(async () => {
      latestLoad.resolve({
        session: latestSession,
        contexts: [],
        messages: [],
      });
      await latestLoad.promise;
    });
    expect(
      await screen.findByRole("heading", { name: latestSession.title }),
    ).toBeVisible();

    await act(async () => {
      middleLoad.resolve({
        session: middleSession,
        contexts: [],
        messages: [],
      });
      await middleLoad.promise;
    });
    expect(
      screen.getByRole("heading", { name: latestSession.title }),
    ).toBeVisible();
    expect(onActiveSessionChange).toHaveBeenLastCalledWith(latestSession.id);
  });

  it("restores history and streams Markdown through the local ChatGPT-authenticated Codex runtime", async () => {
    const { messages, repository } = createRepository();
    const provider = createProvider();
    render(
      <ChatPanel
        paperRepository={{ list: vi.fn(async () => [paper]), getById: vi.fn() }}
        paperTextService={{ ensureReady: vi.fn() } as unknown as PaperTextService}
        provider={provider}
        repository={repository}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Transformer notes" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/ChatGPT connected/i)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Message Codex"), "Why is attention useful?");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Attention", { selector: "strong" })).toBeInTheDocument();
    await waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]).toMatchObject({ role: "assistant", status: "complete" });
    expect(provider.streamTurn).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.6-luna" }),
      expect.any(Function),
    );
  });

  it("requires an explicit full-text disclosure before attaching a paper", async () => {
    const { contexts, repository } = createRepository();
    const paperRepository: PaperRepository = {
      list: vi.fn(async () => [paper]),
      getById: vi.fn(async () => paper),
    };
    const readyText: StoredPaperText = {
      paperId: paper.id,
      status: "ready",
      content: "Complete transformer paper text",
      pageCount: 15,
      charCount: 31,
      errorCode: null,
      updatedAt: 1,
    };
    const ensureReady = vi.fn(async () => readyText);
    render(
      <ChatPanel
        paperRepository={paperRepository}
        paperTextService={{ ensureReady } as unknown as PaperTextService}
        provider={createProvider()}
        repository={repository}
      />,
    );

    await screen.findByRole("heading", { name: "Transformer notes" });
    await userEvent.click(screen.getByRole("button", { name: "Add paper context" }));
    await userEvent.click(
      await screen.findByRole("button", { name: `Attach ${paper.title}` }),
    );

    expect(screen.getByText(/complete extracted text will be sent/i)).toBeInTheDocument();
    expect(ensureReady).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/complete extracted text will be sent/i)).not.toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole("button", { name: `Attach ${paper.title}` }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Attach full text" }));

    await waitFor(() => expect(contexts).toHaveLength(1));
    expect(ensureReady).toHaveBeenCalledWith(paper, expect.any(AbortSignal));
    expect(await screen.findByText(paper.title)).toBeInTheDocument();
  });

  it("offers the PDF currently being read as an explicit discussion context", async () => {
    const { repository } = createRepository();
    const ensureReady = vi.fn();
    render(
      <ChatPanel
        currentPaper={paper}
        paperRepository={{ list: vi.fn(async () => [paper]), getById: vi.fn() }}
        paperTextService={{ ensureReady } as unknown as PaperTextService}
        provider={createProvider()}
        repository={repository}
      />,
    );

    await screen.findByRole("heading", { name: "Transformer notes" });
    await userEvent.click(
      screen.getByRole("button", { name: "Attach current PDF" }),
    );

    expect(screen.getByRole("dialog", { name: "Attach paper disclosure" })).toHaveTextContent(
      paper.title,
    );
    expect(ensureReady).not.toHaveBeenCalled();
  });

  it("reconciles the paper picker when the library changes without remounting", async () => {
    const { repository } = createRepository();
    const paperRepository: PaperRepository = {
      list: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([paper]),
      getById: vi.fn(async () => paper),
    };
    const props = {
      paperRepository,
      paperTextService: {
        ensureReady: vi.fn(),
      } as unknown as PaperTextService,
      provider: createProvider(),
      repository,
    };
    const view = render(<ChatPanel {...props} />);
    await screen.findByRole("heading", { name: "Transformer notes" });

    view.rerender(
      <ChatPanel
        {...props}
        paperCatalogChange={{
          kind: "imported",
          paperIds: [paper.id],
          revision: 1,
        }}
      />,
    );
    await waitFor(() => expect(paperRepository.list).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("button", { name: "Add paper context" }));
    expect(
      await screen.findByRole("button", { name: `Attach ${paper.title}` }),
    ).toBeVisible();
  });

  it("switches the current discussion model and reasoning effort without an API key", async () => {
    const { repository } = createRepository();
    const provider = createProvider();
    render(
      <ChatPanel
        paperRepository={{ list: vi.fn(async () => []), getById: vi.fn() }}
        paperTextService={{ ensureReady: vi.fn() } as unknown as PaperTextService}
        provider={provider}
        repository={repository}
      />,
    );

    await screen.findByRole("heading", { name: "Transformer notes" });
    const settingsButton = screen.getByRole("button", { name: "AI settings" });
    expect(settingsButton).toHaveTextContent(/Luna.*Low/i);
    await userEvent.click(settingsButton);
    expect(screen.getByText(/No API key is stored/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/API key/i)).not.toBeInTheDocument();

    expect(screen.getByLabelText("Model for AI requests")).toHaveValue(
      "gpt-5.6-luna",
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Model for AI requests"),
      "gpt-5.6-terra",
    );
    await userEvent.selectOptions(screen.getByLabelText("Reasoning effort"), "high");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() =>
      expect(repository.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gpt-5.6-terra", reasoningEffort: "high" }),
        "session-1",
      ),
    );
    expect(
      await screen.findByRole("button", { name: "AI settings" }),
    ).toHaveTextContent(/Terra.*High/i);

    await userEvent.type(screen.getByLabelText("Message Codex"), "Use the new model");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(provider.streamTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-5.6-terra",
          reasoningEffort: "high",
        }),
        expect.any(Function),
      ),
    );
  });

  it("opens settings with the current discussion model instead of the global default", async () => {
    const { repository } = createRepository();
    repository.getSettings = vi.fn(async () => ({
      provider: LOCAL_CODEX_PROVIDER,
      model: "gpt-5.6-sol" as const,
      reasoningEffort: "low" as const,
      updatedAt: 2,
    }));
    render(
      <ChatPanel
        paperRepository={{ list: vi.fn(async () => []), getById: vi.fn() }}
        paperTextService={{ ensureReady: vi.fn() } as unknown as PaperTextService}
        provider={createProvider()}
        repository={repository}
      />,
    );

    await screen.findByRole("heading", { name: "Transformer notes" });
    expect(screen.getByRole("button", { name: "AI settings" })).toHaveTextContent(/Luna/i);
    await userEvent.click(screen.getByRole("button", { name: "AI settings" }));
    expect(screen.getByLabelText("Model for AI requests")).toHaveValue(
      "gpt-5.6-luna",
    );
    await userEvent.selectOptions(screen.getByLabelText("Reasoning effort"), "high");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() =>
      expect(repository.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-5.6-luna",
          reasoningEffort: "high",
        }),
        "session-1",
      ),
    );
  });

  it("keeps AI settings modal, focus-safe, and non-dismissible while saving", async () => {
    const { repository } = createRepository();
    const save = createDeferred<void>();
    repository.saveSettings = vi.fn(() => save.promise);
    const user = userEvent.setup();
    render(
      <ChatPanel
        paperRepository={{ list: vi.fn(async () => []), getById: vi.fn() }}
        paperTextService={{ ensureReady: vi.fn() } as unknown as PaperTextService}
        provider={createProvider()}
        repository={repository}
      />,
    );

    await screen.findByRole("heading", { name: "Transformer notes" });
    const opener = screen.getByRole("button", { name: "AI settings" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "AI settings" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() =>
      expect(screen.getByLabelText("Model for AI requests")).toHaveFocus(),
    );

    const closeButton = screen.getByRole("button", { name: "Close AI settings" });
    const saveButton = screen.getByRole("button", { name: "Save settings" });
    saveButton.focus();
    await user.tab();
    expect(closeButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(saveButton).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "AI settings" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();

    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(screen.getByRole("button", { name: "Close AI settings" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "AI settings" })).toBeVisible();

    await act(async () => {
      save.resolve();
      await save.promise;
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "AI settings" })).not.toBeInTheDocument(),
    );
    expect(opener).toHaveFocus();
  });

  it("does not report an atomic settings commit as failed when refresh fails", async () => {
    const { repository } = createRepository();
    const user = userEvent.setup();
    render(
      <ChatPanel
        paperRepository={{ list: vi.fn(async () => []), getById: vi.fn() }}
        paperTextService={{ ensureReady: vi.fn() } as unknown as PaperTextService}
        provider={createProvider()}
        repository={repository}
      />,
    );

    await screen.findByRole("heading", { name: "Transformer notes" });
    const sessionLoadsBeforeSave = vi.mocked(repository.loadSession).mock.calls.length;
    repository.listSessions = vi.fn().mockRejectedValueOnce(new Error("read busy"));
    await user.click(screen.getByRole("button", { name: "AI settings" }));
    await user.selectOptions(
      screen.getByLabelText("Model for AI requests"),
      "gpt-5.6-sol",
    );
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "AI settings" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/Settings could not be saved locally/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI settings" })).toHaveTextContent(/Sol/i);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /settings were saved.*could not refresh/i,
    );
    expect(repository.loadSession).toHaveBeenCalledTimes(sessionLoadsBeforeSave);
  });

  it("lets keyboard and pointer users resize the right discussion rail", async () => {
    const { repository } = createRepository();
    render(
      <ChatPanel
        paperRepository={{ list: vi.fn(async () => []), getById: vi.fn() }}
        paperTextService={{ ensureReady: vi.fn() } as unknown as PaperTextService}
        provider={createProvider()}
        repository={repository}
      />,
    );
    const panel = await screen.findByLabelText("AI discussion");
    const separator = screen.getByRole("separator", {
      name: "Resize AI discussion",
    });

    expect(panel).toHaveStyle({ width: "360px" });
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(panel).toHaveStyle({ width: "372px" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(panel).toHaveStyle({ width: "360px" });
    fireEvent.keyDown(separator, { key: "Home" });
    expect(panel).toHaveStyle({ width: "300px" });
    fireEvent.pointerDown(separator, { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 450 });
    expect(panel).toHaveStyle({ width: "350px" });
    fireEvent.pointerUp(window);
    fireEvent.keyDown(separator, { key: "End" });
    expect(panel).toHaveStyle({ width: "560px" });
  });

  it("fills an embedded tab without exposing a redundant resize handle", async () => {
    const { repository } = createRepository();
    render(
      <ChatPanel
        embedded
        paperRepository={{ list: vi.fn(async () => []), getById: vi.fn() }}
        paperTextService={{ ensureReady: vi.fn() } as unknown as PaperTextService}
        provider={createProvider()}
        repository={repository}
      />,
    );

    const panel = await screen.findByLabelText("AI discussion");
    expect(panel).toHaveClass("ai-panel--embedded");
    expect(panel).not.toHaveAttribute("style");
    expect(
      screen.queryByRole("separator", { name: "Resize AI discussion" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    [
      { available: false, authenticated: false, compatible: false, loginMethod: "none" as const },
      "Local Codex not found",
    ],
    [
      { available: true, authenticated: true, compatible: false, loginMethod: "chatgpt" as const },
      "Codex version mismatch",
    ],
    [
      { available: true, authenticated: false, compatible: true, loginMethod: "none" as const },
      "Run codex login to connect ChatGPT",
    ],
    [
      { available: true, authenticated: true, compatible: true, loginMethod: "api" as const },
      "ChatGPT sign-in required",
    ],
  ])("fails closed for an unavailable runtime %#", async (status, label) => {
    const { repository } = createRepository();
    const provider = createProvider();
    provider.getStatus = vi.fn(async () => ({
      ...status,
      nodeVersion: null,
      runtimeVersion: null,
      message: null,
    }));
    render(
      <ChatPanel
        paperRepository={{ list: vi.fn(async () => []), getById: vi.fn() }}
        paperTextService={{ ensureReady: vi.fn() } as unknown as PaperTextService}
        provider={provider}
        repository={repository}
      />,
    );

    expect(await screen.findByText(label, { exact: false })).toBeInTheDocument();
    expect(screen.getByLabelText("Message Codex")).toBeDisabled();
    expect(screen.getByText(/cannot spend an API-key balance/i)).toBeVisible();
  });

  it("renames, removes context from, and deletes a saved discussion", async () => {
    const { contexts, repository, session } = createRepository();
    contexts.push({
      sessionId: session.id,
      paperId: paper.id,
      position: 0,
      createdAt: 1,
    });
    render(
      <ChatPanel
        paperRepository={{ list: vi.fn(async () => [paper]), getById: vi.fn() }}
        paperTextService={{ ensureReady: vi.fn() } as unknown as PaperTextService}
        provider={createProvider()}
        repository={repository}
      />,
    );

    await screen.findByRole("heading", { name: "Transformer notes" });
    await userEvent.click(
      screen.getByRole("button", { name: `Remove ${paper.title} from context` }),
    );
    await waitFor(() => expect(contexts).toHaveLength(0));
    expect(await screen.findByText(/No papers attached/i)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Rename discussion" }));
    const title = screen.getByLabelText("Discussion title");
    await userEvent.clear(title);
    await userEvent.type(title, "  New research title  ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { name: "New research title" })).toBeVisible();

    const replacement: ChatSession = {
      ...session,
      id: "session-replacement",
      title: "New discussion",
    };
    vi.mocked(repository.listSessions).mockResolvedValueOnce([]);
    vi.mocked(repository.createSession).mockResolvedValueOnce(replacement);
    vi.mocked(repository.loadSession).mockResolvedValueOnce(null);
    await userEvent.click(screen.getByRole("button", { name: "Delete discussion" }));
    await waitFor(() => expect(repository.deleteSession).toHaveBeenCalledWith(session.id));
    expect(await screen.findByRole("heading", { name: "New discussion" })).toBeVisible();
  });

  it("shows recoverable storage and Codex errors without losing the discussion", async () => {
    const { repository } = createRepository();
    const provider = createProvider();
    provider.streamTurn = vi.fn(async (_request, onEvent) => {
      onEvent({ type: "error", message: "Codex allowance is temporarily unavailable." });
    });
    repository.saveSettings = vi.fn(async () => {
      throw new Error("disk full");
    });
    const ensureReady = vi.fn(async () => {
      throw new PaperTextExtractionError(
        "no_text",
        "This PDF has no selectable text. OCR is not enabled.",
      );
    });
    render(
      <ChatPanel
        paperRepository={{ list: vi.fn(async () => [paper]), getById: vi.fn() }}
        paperTextService={{ ensureReady } as unknown as PaperTextService}
        provider={provider}
        repository={repository}
      />,
    );

    await screen.findByRole("heading", { name: "Transformer notes" });
    await userEvent.type(screen.getByLabelText("Message Codex"), "Explain this");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(
      await screen.findByText("Codex allowance is temporarily unavailable."),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Add paper context" }));
    await userEvent.click(
      await screen.findByRole("button", { name: `Attach ${paper.title}` }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Attach full text" }));
    expect(
      await screen.findByText("This PDF has no selectable text. OCR is not enabled."),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "AI settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/Settings could not be saved locally/i)).toBeVisible();
  });

  it("registers an active turn so navigation or native close cancels and drains it", async () => {
    const { repository } = createRepository();
    let emit: ((event: Parameters<Parameters<AIProvider["streamTurn"]>[1]>[0]) => void) | undefined;
    let finish: (() => void) | undefined;
    const provider = createProvider();
    provider.streamTurn = vi.fn(
      async (_request, onEvent) =>
        new Promise<void>((resolve) => {
          emit = onEvent;
          finish = resolve;
          onEvent({ type: "thread", threadId: "ephemeral-thread" });
        }),
    );
    provider.cancel = vi.fn(async () => {
      emit?.({ type: "interrupted" });
      finish?.();
    });
    render(
      <ChatPanel
        paperRepository={{ list: vi.fn(async () => []), getById: vi.fn() }}
        paperTextService={{ ensureReady: vi.fn() } as unknown as PaperTextService}
        provider={provider}
        repository={repository}
      />,
    );
    await screen.findByRole("heading", { name: "Transformer notes" });
    await userEvent.type(screen.getByLabelText("Message Codex"), "Keep this turn safe");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(provider.streamTurn).toHaveBeenCalledOnce());

    expect(persistence.writer?.isDirty()).toBe(true);
    await persistence.writer?.flush();

    expect(provider.cancel).toHaveBeenCalledOnce();
    expect(persistence.writer?.isDirty()).toBe(false);
    expect(repository.updateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "interrupted" }),
    );
  });

  it("keeps an explicit paper attachment dirty until extraction and context persistence finish", async () => {
    const { repository } = createRepository();
    const extraction = createDeferred<StoredPaperText>();
    const ensureReady = vi.fn(() => extraction.promise);
    render(
      <ChatPanel
        paperRepository={{ list: vi.fn(async () => [paper]), getById: vi.fn() }}
        paperTextService={{ ensureReady } as unknown as PaperTextService}
        provider={createProvider()}
        repository={repository}
      />,
    );

    await screen.findByRole("heading", { name: "Transformer notes" });
    await userEvent.click(screen.getByRole("button", { name: "Add paper context" }));
    await userEvent.click(
      await screen.findByRole("button", { name: `Attach ${paper.title}` }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Attach full text" }));

    expect(persistence.writer?.isDirty()).toBe(true);

    extraction.resolve({
      paperId: paper.id,
      status: "ready",
      content: "Complete transformer paper text",
      pageCount: 15,
      charCount: 31,
      errorCode: null,
      updatedAt: 1,
    });
    await waitFor(() =>
      expect(repository.addContext).toHaveBeenCalledWith(
        "session-1",
        paper.id,
        expect.any(Number),
      ),
    );
    await waitFor(() => expect(persistence.writer?.isDirty()).toBe(false));
  });

  it("does not block close after PDF extraction fails before any context is saved", async () => {
    const { repository } = createRepository();
    const ensureReady = vi.fn(async () => {
      throw new PaperTextExtractionError(
        "no_text",
        "The local PDF could not be extracted.",
      );
    });
    render(
      <ChatPanel
        paperRepository={{ list: vi.fn(async () => [paper]), getById: vi.fn() }}
        paperTextService={{ ensureReady } as unknown as PaperTextService}
        provider={createProvider()}
        repository={repository}
      />,
    );

    await screen.findByRole("heading", { name: "Transformer notes" });
    await userEvent.click(screen.getByRole("button", { name: "Add paper context" }));
    await userEvent.click(
      await screen.findByRole("button", { name: `Attach ${paper.title}` }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Attach full text" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The local PDF could not be extracted.",
    );
    await waitFor(() => expect(persistence.writer?.isDirty()).toBe(false));
    await expect(persistence.writer?.flush()).resolves.toBeUndefined();
    expect(repository.addContext).not.toHaveBeenCalled();
  });

  it("cancels and drains an in-flight attachment when close persistence flushes", async () => {
    const { repository } = createRepository();
    let extractionSignal: AbortSignal | undefined;
    const ensureReady = vi.fn(
      (_paper: Paper, signal?: AbortSignal) =>
        new Promise<StoredPaperText>((_resolve, reject) => {
          extractionSignal = signal;
          signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })),
            { once: true },
          );
        }),
    );
    render(
      <ChatPanel
        paperRepository={{ list: vi.fn(async () => [paper]), getById: vi.fn() }}
        paperTextService={{ ensureReady } as unknown as PaperTextService}
        provider={createProvider()}
        repository={repository}
      />,
    );

    await screen.findByRole("heading", { name: "Transformer notes" });
    await userEvent.click(screen.getByRole("button", { name: "Add paper context" }));
    await userEvent.click(
      await screen.findByRole("button", { name: `Attach ${paper.title}` }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Attach full text" }));
    await waitFor(() => expect(ensureReady).toHaveBeenCalledOnce());

    await persistence.writer?.flush();

    expect(extractionSignal?.aborted).toBe(true);
    expect(repository.addContext).not.toHaveBeenCalled();
    expect(persistence.writer?.isDirty()).toBe(false);
  });

  it("compensates a context write that commits while attachment cancellation is in flight", async () => {
    const { contexts, repository } = createRepository();
    const addContext = createDeferred<void>();
    repository.addContext = vi.fn(async (sessionId, paperId, timestamp) => {
      await addContext.promise;
      contexts.push({ sessionId, paperId, position: 0, createdAt: timestamp });
    });
    const ensureReady = vi.fn(async () => ({
      paperId: paper.id,
      status: "ready" as const,
      content: "Complete transformer paper text",
      pageCount: 15,
      charCount: 31,
      errorCode: null,
      updatedAt: 1,
    }));
    render(
      <ChatPanel
        paperRepository={{ list: vi.fn(async () => [paper]), getById: vi.fn() }}
        paperTextService={{ ensureReady } as unknown as PaperTextService}
        provider={createProvider()}
        repository={repository}
      />,
    );

    await screen.findByRole("heading", { name: "Transformer notes" });
    await userEvent.click(screen.getByRole("button", { name: "Add paper context" }));
    await userEvent.click(
      await screen.findByRole("button", { name: `Attach ${paper.title}` }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Attach full text" }));
    await waitFor(() => expect(repository.addContext).toHaveBeenCalledOnce());

    const flush = persistence.writer?.flush();
    addContext.resolve(undefined);
    await flush;

    expect(repository.removeContext).toHaveBeenCalledWith(
      "session-1",
      paper.id,
      expect.any(Number),
    );
    expect(contexts).toHaveLength(0);
    expect(persistence.writer?.isDirty()).toBe(false);
  });

  it("keeps a failed attachment compensation blocking close after the disclosure is dismissed", async () => {
    const { contexts, repository } = createRepository();
    const addContext = createDeferred<void>();
    repository.addContext = vi.fn(async (sessionId, paperId, timestamp) => {
      await addContext.promise;
      contexts.push({ sessionId, paperId, position: 0, createdAt: timestamp });
    });
    repository.removeContext = vi.fn(async () => {
      throw new Error("database busy");
    });
    const ensureReady = vi
      .fn()
      .mockResolvedValueOnce({
        paperId: paper.id,
        status: "ready",
        content: "Complete transformer paper text",
        pageCount: 15,
        charCount: 31,
        errorCode: null,
        updatedAt: 1,
      });
    render(
      <ChatPanel
        paperRepository={{ list: vi.fn(async () => [paper]), getById: vi.fn() }}
        paperTextService={{ ensureReady } as unknown as PaperTextService}
        provider={createProvider()}
        repository={repository}
      />,
    );

    await screen.findByRole("heading", { name: "Transformer notes" });
    await userEvent.click(screen.getByRole("button", { name: "Add paper context" }));
    await userEvent.click(
      await screen.findByRole("button", { name: `Attach ${paper.title}` }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Attach full text" }));
    await waitFor(() => expect(repository.addContext).toHaveBeenCalledOnce());

    const firstFlush = persistence.writer?.flush();
    addContext.resolve(undefined);
    await expect(firstFlush).rejects.toThrow("database busy");
    expect(contexts).toHaveLength(1);
    expect(await screen.findByText(/cancellation could not be saved/i)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(persistence.writer?.isDirty()).toBe(true);
    await expect(persistence.writer?.flush()).rejects.toThrow("database busy");

    await userEvent.click(
      screen.getByRole("button", { name: `Attach ${paper.title}` }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Attach full text" }));
    await waitFor(() => expect(repository.removeContext).toHaveBeenCalledTimes(2));
    expect(ensureReady).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(persistence.writer?.isDirty()).toBe(true));
    await expect(persistence.writer?.flush()).rejects.toThrow("database busy");
  });

  it("blocks close after a failed settings write until a successful retry", async () => {
    const { repository } = createRepository();
    repository.saveSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    render(
      <ChatPanel
        paperRepository={{ list: vi.fn(async () => []), getById: vi.fn() }}
        paperTextService={{ ensureReady: vi.fn() } as unknown as PaperTextService}
        provider={createProvider()}
        repository={repository}
      />,
    );

    await screen.findByRole("heading", { name: "Transformer notes" });
    await userEvent.click(screen.getByRole("button", { name: "AI settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/Settings could not be saved locally/i)).toBeVisible();
    expect(persistence.writer?.isDirty()).toBe(true);
    await expect(persistence.writer?.flush()).rejects.toThrow("disk full");

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "AI settings" })).not.toBeInTheDocument();
    expect(persistence.writer?.isDirty()).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "AI settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(repository.saveSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(persistence.writer?.isDirty()).toBe(false));
  });
});
