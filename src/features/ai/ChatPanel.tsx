import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  SqlitePaperRepository,
  type Paper,
  type PaperCatalogChange,
  type PaperRepository,
} from "../library";
import { usePersistenceWriter } from "../persistence";
import type { AiRepository } from "./data/aiRepository";
import { sqliteAiRepository } from "./data/sqliteAiRepository";
import {
  LOCAL_CODEX_PROVIDER,
  SUPPORTED_CODEX_MODELS,
  type AIProvider,
  type AiRuntimeSettings,
  type ChatSession,
  type ChatSessionSnapshot,
  type CodexRuntimeStatus,
  type ReasoningEffort,
} from "./model/ai";
import { ChatContextOverflowError, ChatTurnController } from "./services/chatTurnController";
import { localCodexProvider } from "./services/localCodexProvider";
import {
  PaperTextExtractionCancelledError,
  PaperTextExtractionError,
} from "./services/paperTextExtractor";
import { PaperTextService } from "./services/paperTextService";
import "./ai.css";
import { WebChatPanel } from "./WebChatPanel";

const defaultPaperRepository = new SqlitePaperRepository();
const defaultPaperTextService = new PaperTextService(sqliteAiRepository);
const DEFAULT_PANEL_WIDTH = 360;
const MIN_PANEL_WIDTH = 300;
const MAX_PANEL_WIDTH = 560;

function modelLabel(model: AiRuntimeSettings["model"]): string {
  const tier = model.slice("gpt-5.6-".length);
  return `GPT 5.6 ${tier.charAt(0).toUpperCase()}${tier.slice(1)}`;
}

function reasoningLabel(effort: ReasoningEffort): string {
  if (effort === "xhigh") return "Extra high";
  return `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;
}

function clampPanelWidth(width: number): number {
  const viewportLimit = Math.max(
    MIN_PANEL_WIDTH,
    Math.floor(globalThis.innerWidth * 0.55),
  );
  return Math.min(Math.max(width, MIN_PANEL_WIDTH), MAX_PANEL_WIDTH, viewportLimit);
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function emptySnapshot(session: ChatSession): ChatSessionSnapshot {
  return { session, contexts: [], messages: [] };
}

function runtimeLabel(status: CodexRuntimeStatus | null): string {
  if (!status) return "Checking local Codex…";
  if (!status.available) return "Local Codex not found";
  if (!status.compatible) return "Codex version mismatch";
  if (!status.authenticated || status.loginMethod === "none") {
    return "Run codex login to connect ChatGPT";
  }
  if (status.loginMethod !== "chatgpt") {
    return "ChatGPT sign-in required (API-key login is disabled here)";
  }
  return `ChatGPT connected · Codex ${status.runtimeVersion ?? "local"}`;
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown
      components={{
        a: ({ children, ...props }) => (
          <a {...props} rel="noreferrer" target="_blank">
            {children}
          </a>
        ),
      }}
      remarkPlugins={[remarkGfm]}
    >
      {content}
    </ReactMarkdown>
  );
}

interface SettingsDialogProps {
  onClose: () => void;
  onSave: (settings: AiRuntimeSettings) => Promise<void>;
  runtimeStatus: CodexRuntimeStatus | null;
  settings: AiRuntimeSettings;
}

function SettingsDialog({
  onClose,
  onSave,
  runtimeStatus,
  settings,
}: SettingsDialogProps) {
  const [model, setModel] = useState(settings.model);
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>(settings.reasoningEffort);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const cardRef = useRef<HTMLFormElement>(null);
  const modelSelectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    modelSelectRef.current?.focus();
  }, []);

  const requestClose = useCallback(() => {
    if (!isSaving) onClose();
  }, [isSaving, onClose]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLFormElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;

      const card = cardRef.current;
      if (!card) return;
      const focusable = Array.from(
        card.querySelectorAll<HTMLElement>(
          "button:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])",
        ),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [requestClose],
  );

  return (
    <div
      aria-label="AI settings"
      aria-modal="true"
      className="ai-settings"
      role="dialog"
    >
      <div className="ai-settings__scrim" onClick={requestClose} />
      <form
        aria-busy={isSaving}
        className="ai-settings__card"
        onKeyDown={handleKeyDown}
        ref={cardRef}
        onSubmit={(event) => {
          event.preventDefault();
          if (isSaving) return;
          setIsSaving(true);
          setSaveError(false);
          void onSave({
            provider: LOCAL_CODEX_PROVIDER,
            model,
            reasoningEffort,
            updatedAt: Date.now(),
          })
            .then(onClose)
            .catch(() => {
              setSaveError(true);
              setIsSaving(false);
            });
        }}
      >
        <header>
          <div>
            <span className="ai-eyebrow">Local provider</span>
            <h2>Codex via ChatGPT</h2>
          </div>
          <button
            aria-label="Close AI settings"
            disabled={isSaving}
            onClick={requestClose}
            type="button"
          >
            ×
          </button>
        </header>
        <p className="ai-settings__status">{runtimeLabel(runtimeStatus)}</p>
        <p className="ai-settings__explanation">
          PaperCanvas uses your local Codex runtime and its “Sign in with ChatGPT”
          session. No API key is stored in this app.
        </p>
        <label>
          Model for AI requests
          <select
            disabled={isSaving}
            ref={modelSelectRef}
            value={model}
            onChange={(event) => setModel(event.target.value as AiRuntimeSettings["model"])}
          >
            {SUPPORTED_CODEX_MODELS.map((value) => (
              <option key={value} value={value}>
                {modelLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reasoning effort
          <select
            disabled={isSaving}
            value={reasoningEffort}
            onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}
          >
            <option value="low">Low · responsive</option>
            <option value="medium">Medium · balanced</option>
            <option value="high">High · deeper analysis</option>
            <option value="xhigh">Extra high · extended analysis</option>
            <option value="max">Max · longest analysis</option>
          </select>
        </label>
        {saveError && <p role="alert">Settings could not be saved locally.</p>}
        <footer>
          <button disabled={isSaving} onClick={requestClose} type="button">
            Cancel
          </button>
          <button className="is-primary" disabled={isSaving} type="submit">
            {isSaving ? "Saving…" : "Save settings"}
          </button>
        </footer>
      </form>
    </div>
  );
}

export interface ChatPanelProps {
  initialWebChatId?: string | null;
  currentPaper?: Paper | null;
  embedded?: boolean;
  initialSessionId?: string | null;
  onActiveSessionChange?: (sessionId: string) => void;
  paperCatalogChange?: PaperCatalogChange | null;
  paperRepository?: PaperRepository;
  paperTextService?: PaperTextService;
  provider?: AIProvider;
  repository?: AiRepository;
}

export function ChatPanel(props: ChatPanelProps) {
  if (props.embedded && props.currentPaper && !props.provider) {
    return <WebChatPanel paper={props.currentPaper} initialChatId={props.initialWebChatId} />;
  }
  return <CodexChatPanel {...props} />;
}

function CodexChatPanel({
  currentPaper = null,
  embedded = false,
  initialSessionId = null,
  onActiveSessionChange,
  paperCatalogChange = null,
  paperRepository = defaultPaperRepository,
  paperTextService = defaultPaperTextService,
  provider = localCodexProvider,
  repository = sqliteAiRepository,
}: ChatPanelProps) {
  const [settings, setSettings] = useState<AiRuntimeSettings | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<CodexRuntimeStatus | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [snapshot, setSnapshot] = useState<ChatSessionSnapshot | null>(null);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [prompt, setPrompt] = useState("");
  const [liveUser, setLiveUser] = useState("");
  const [liveAssistant, setLiveAssistant] = useState("");
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showPaperPicker, setShowPaperPicker] = useState(false);
  const [paperSearch, setPaperSearch] = useState("");
  const [pendingPaper, setPendingPaper] = useState<Paper | null>(null);
  const [isAttaching, setIsAttaching] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const activeRequestIdRef = useRef<string | null>(null);
  const attachAbortControllerRef = useRef<AbortController | null>(null);
  const sendOperationRef = useRef<Promise<void> | null>(null);
  const pendingMutationsRef = useRef(new Set<Promise<unknown>>());
  const mutationFailuresRef = useRef(new Map<string, unknown>());
  const mutationTokensRef = useRef(new Map<string, symbol>());
  const pendingContextCompensationsRef = useRef(
    new Map<string, { paperId: string; sessionId: string }>(),
  );
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const snapshotRef = useRef<ChatSessionSnapshot | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const initialSessionIdRef = useRef(initialSessionId);
  const onActiveSessionChangeRef = useRef(onActiveSessionChange);
  const sessionLoadSequenceRef = useRef(0);

  useEffect(() => {
    onActiveSessionChangeRef.current = onActiveSessionChange;
  }, [onActiveSessionChange]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const controller = useMemo(
    () => new ChatTurnController(repository, provider),
    [provider, repository],
  );

  const trackMutation = useCallback(
    <T,>(key: string, mutate: () => Promise<T>): Promise<T> => {
      const token = Symbol(key);
      mutationTokensRef.current.set(key, token);

      const operation = Promise.resolve().then(mutate);
      pendingMutationsRef.current.add(operation);
      const settle = operation.then(
        () => {
          if (mutationTokensRef.current.get(key) === token) {
            mutationFailuresRef.current.delete(key);
          }
        },
        (error: unknown) => {
          if (mutationTokensRef.current.get(key) === token) {
            mutationFailuresRef.current.set(key, error);
          }
        },
      );
      void settle.finally(() => {
        pendingMutationsRef.current.delete(operation);
      });
      return operation;
    },
    [],
  );

  const clearMutationFailure = useCallback((key: string) => {
    mutationTokensRef.current.set(key, Symbol(`${key}:discarded`));
    mutationFailuresRef.current.delete(key);
  }, []);

  const refreshSessions = useCallback(async () => {
    const loaded = await repository.listSessions();
    setSessions(loaded);
    return loaded;
  }, [repository]);

  const openSession = useCallback(
    async (sessionId: string) => {
      const sequence = sessionLoadSequenceRef.current + 1;
      sessionLoadSequenceRef.current = sequence;
      let loaded: ChatSessionSnapshot | null;
      try {
        loaded = await repository.loadSession(sessionId);
      } catch (error) {
        if (sequence !== sessionLoadSequenceRef.current) return null;
        throw error;
      }
      if (sequence !== sessionLoadSequenceRef.current) return null;
      if (!loaded) throw new Error("The local discussion could not be restored.");
      setSnapshot(loaded);
      onActiveSessionChangeRef.current?.(loaded.session.id);
      return loaded;
    },
    [repository],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await repository.markStreamingMessagesInterrupted(Date.now());
        const [loadedSettings, loadedSessions, availablePapers, status] = await Promise.all([
          repository.getSettings(),
          repository.listSessions(),
          paperRepository.list(),
          provider.getStatus().catch(() => ({
            available: false,
            authenticated: false,
            compatible: false,
            loginMethod: "unknown" as const,
            nodeVersion: null,
            runtimeVersion: null,
            message: "Local Codex status is unavailable.",
          })),
        ]);
        if (!active) return;
        setSettings(loadedSettings);
        setRuntimeStatus(status);
        setPapers(availablePapers);

        let selected = initialSessionIdRef.current
          ? loadedSessions.find(
              (session) => session.id === initialSessionIdRef.current,
            )
          : undefined;
        selected ??= loadedSessions[0];
        if (!selected) {
          selected = await repository.createSession({
            id: createId(),
            model: loadedSettings.model,
            timestamp: Date.now(),
            title: "New discussion",
          });
        }
        if (!active) return;
        setSessions(loadedSessions.length > 0 ? loadedSessions : [selected]);
        const loadedSnapshot = await repository.loadSession(selected.id);
        if (!active) return;
        setSnapshot(loadedSnapshot ?? emptySnapshot(selected));
        onActiveSessionChangeRef.current?.(selected.id);
      } catch {
        if (active) setErrorMessage("AI discussions could not be loaded from local storage.");
      } finally {
        if (active) setIsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [paperRepository, provider, repository]);

  useEffect(() => {
    if (!paperCatalogChange) return;
    let active = true;
    void (async () => {
      try {
        const availablePapers = await paperRepository.list();
        if (!active) return;
        setPapers(availablePapers);
        if (paperCatalogChange.kind !== "deleted") return;

        const activeSessionId = snapshotRef.current?.session.id;
        const [nextSessions, nextSnapshot] = await Promise.all([
          repository.listSessions(),
          activeSessionId
            ? repository.loadSession(activeSessionId)
            : Promise.resolve(null),
        ]);
        if (!active) return;
        setSessions(nextSessions);
        if (nextSnapshot) setSnapshot(nextSnapshot);
      } catch {
        if (active) {
          setErrorMessage("The paper library change could not be reconciled.");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [paperCatalogChange, paperRepository, repository]);

  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
    },
    [],
  );

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      resizeCleanupRef.current?.();
      const startX = event.clientX;
      const startWidth = panelWidth;
      const onPointerMove = (moveEvent: PointerEvent) => {
        setPanelWidth(clampPanelWidth(startWidth + startX - moveEvent.clientX));
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null;
      };
      resizeCleanupRef.current = cleanup;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
    },
    [panelWidth],
  );

  const runtimeReady =
    runtimeStatus?.available === true &&
    runtimeStatus.authenticated &&
    runtimeStatus.compatible &&
    runtimeStatus.loginMethod === "chatgpt";

  const runSend = useCallback(async () => {
    if (!snapshot || !settings || !prompt.trim() || isSending || !runtimeReady) return;
    const userPrompt = prompt.trim();
    setPrompt("");
    setLiveUser(userPrompt);
    setLiveAssistant("");
    setErrorMessage(null);
    setIsSending(true);
    try {
      await controller.send({
        snapshot,
        settings: { ...settings, model: snapshot.session.model },
        userPrompt,
        onRequestStarted: (requestId) => {
          activeRequestIdRef.current = requestId;
          setActiveRequestId(requestId);
        },
        onSnapshot: setLiveAssistant,
      });
      if (snapshot.session.title === "New discussion") {
        const title = userPrompt.slice(0, 56);
        await repository.renameSession(snapshot.session.id, title, Date.now());
      }
      await Promise.all([openSession(snapshot.session.id), refreshSessions()]);
    } catch (error) {
      if (error instanceof ChatContextOverflowError) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage(
          error instanceof Error ? error.message : "Codex could not complete this turn.",
        );
      }
      await openSession(snapshot.session.id).catch(() => undefined);
    } finally {
      activeRequestIdRef.current = null;
      setActiveRequestId(null);
      setIsSending(false);
      setIsStopping(false);
      setLiveUser("");
      setLiveAssistant("");
    }
  }, [
    controller,
    isSending,
    openSession,
    prompt,
    refreshSessions,
    repository,
    runtimeReady,
    settings,
    snapshot,
  ]);

  const send = useCallback(() => {
    if (sendOperationRef.current) return sendOperationRef.current;
    const operation = runSend();
    sendOperationRef.current = operation;
    const clear = () => {
      if (sendOperationRef.current === operation) sendOperationRef.current = null;
    };
    void operation.then(clear, clear);
    return operation;
  }, [runSend]);

  usePersistenceWriter(
    "ai-discussion",
    useMemo(
      () => ({
        isDirty: () =>
          sendOperationRef.current !== null ||
          pendingMutationsRef.current.size > 0 ||
          mutationFailuresRef.current.size > 0,
        flush: async () => {
          while (
            sendOperationRef.current !== null ||
            pendingMutationsRef.current.size > 0
          ) {
            const attachment = attachAbortControllerRef.current;
            if (attachment && !attachment.signal.aborted) {
              attachment.abort();
            }
            const sendOperation = sendOperationRef.current;
            if (sendOperation) {
              const requestId = activeRequestIdRef.current;
              if (requestId) await controller.cancel(requestId);
            }
            await Promise.allSettled([
              ...(sendOperation ? [sendOperation] : []),
              ...pendingMutationsRef.current,
            ]);
          }

          const failure = mutationFailuresRef.current.values().next();
          if (!failure.done) {
            throw failure.value instanceof Error
              ? failure.value
              : new Error("A local AI discussion change could not be saved.");
          }
        },
      }),
      [controller],
    ),
  );

  const attachPaper = useCallback(async () => {
    if (
      !pendingPaper ||
      !snapshot ||
      isAttaching ||
      attachAbortControllerRef.current
    ) {
      return;
    }
    const abortController = new AbortController();
    const contextMutationKey = `paper-context:${snapshot.session.id}:${pendingPaper.id}`;
    let persistenceAttempted = false;
    attachAbortControllerRef.current = abortController;
    setIsAttaching(true);
    setErrorMessage(null);
    try {
      const attached = await trackMutation(contextMutationKey, async () => {
        let contextAdded = false;
        try {
          const pendingCompensation =
            pendingContextCompensationsRef.current.get(contextMutationKey);
          if (pendingCompensation) {
            persistenceAttempted = true;
            await repository.removeContext(
              pendingCompensation.sessionId,
              pendingCompensation.paperId,
              Date.now(),
            );
            pendingContextCompensationsRef.current.delete(contextMutationKey);
          }
          await paperTextService.ensureReady(
            pendingPaper,
            abortController.signal,
          );
          if (abortController.signal.aborted) {
            throw new PaperTextExtractionCancelledError();
          }
          persistenceAttempted = true;
          await repository.addContext(
            snapshot.session.id,
            pendingPaper.id,
            Date.now(),
          );
          contextAdded = true;
          if (abortController.signal.aborted) {
            throw new PaperTextExtractionCancelledError();
          }
          return true;
        } catch (error) {
          if (!abortController.signal.aborted) throw error;
          if (contextAdded) {
            try {
              await repository.removeContext(
                snapshot.session.id,
                pendingPaper.id,
                Date.now(),
              );
            } catch (compensationError) {
              pendingContextCompensationsRef.current.set(contextMutationKey, {
                paperId: pendingPaper.id,
                sessionId: snapshot.session.id,
              });
              throw compensationError;
            }
          }
          return false;
        }
      });
      if (!attached) return;
      if (attachAbortControllerRef.current === abortController) {
        attachAbortControllerRef.current = null;
      }
      await openSession(snapshot.session.id);
      await refreshSessions();
      setPendingPaper(null);
      setShowPaperPicker(false);
    } catch (error) {
      if (!persistenceAttempted) {
        clearMutationFailure(contextMutationKey);
      }
      if (abortController.signal.aborted) {
        setErrorMessage(
          "Paper context cancellation could not be saved locally. Retry before closing.",
        );
      } else if (error instanceof PaperTextExtractionError) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage("The paper could not be attached to this discussion.");
      }
    } finally {
      if (attachAbortControllerRef.current === abortController) {
        attachAbortControllerRef.current = null;
      }
      setIsAttaching(false);
    }
  }, [
    clearMutationFailure,
    isAttaching,
    openSession,
    paperTextService,
    pendingPaper,
    refreshSessions,
    repository,
    snapshot,
    trackMutation,
  ]);

  const filteredPapers = papers.filter((paper) => {
    const term = paperSearch.trim().toLocaleLowerCase();
    const attached = snapshot?.contexts.some((context) => context.paperId === paper.id);
    return (
      !attached &&
      (!term ||
        paper.title.toLocaleLowerCase().includes(term) ||
        paper.authors?.toLocaleLowerCase().includes(term))
    );
  });
  const currentPaperAttached = Boolean(
    currentPaper &&
      snapshot?.contexts.some((context) => context.paperId === currentPaper.id),
  );

  if (isLoading || !settings || !snapshot) {
    return (
      <aside
        aria-label="AI discussion"
        className={`ai-panel ai-panel--loading${embedded ? " ai-panel--embedded" : ""}`}
      >
        <p role="status">Loading discussions…</p>
      </aside>
    );
  }

  return (
    <aside
      aria-label="AI discussion"
      className={`ai-panel${embedded ? " ai-panel--embedded" : ""}`}
      style={embedded ? undefined : { width: panelWidth }}
    >
      {!embedded && (
        <div
          aria-label="Resize AI discussion"
          aria-orientation="vertical"
          aria-valuemax={MAX_PANEL_WIDTH}
          aria-valuemin={MIN_PANEL_WIDTH}
          aria-valuenow={panelWidth}
          className="ai-panel__resizer"
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              setPanelWidth((width) => clampPanelWidth(width + 12));
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              setPanelWidth((width) => clampPanelWidth(width - 12));
            } else if (event.key === "Home") {
              event.preventDefault();
              setPanelWidth(MIN_PANEL_WIDTH);
            } else if (event.key === "End") {
              event.preventDefault();
              setPanelWidth(clampPanelWidth(MAX_PANEL_WIDTH));
            }
          }}
          onPointerDown={startResize}
          role="separator"
          tabIndex={0}
        />
      )}
      <header className="ai-panel__header">
        <div>
          <span className="ai-eyebrow">AI discussion</span>
          <h2>{snapshot.session.title}</h2>
        </div>
        <button
          aria-label="AI settings"
          className="ai-panel__settings"
          onClick={() => setShowSettings(true)}
          ref={settingsButtonRef}
          type="button"
        >
          <span>{modelLabel(snapshot.session.model).replace("GPT 5.6 ", "")}</span>
          <span aria-hidden="true">·</span>
          <span>{reasoningLabel(settings.reasoningEffort)}</span>
          <span aria-hidden="true">⚙</span>
        </button>
      </header>
      <div className={`ai-runtime ${runtimeReady ? "is-ready" : "is-unavailable"}`}>
        <span aria-hidden="true" />
        {runtimeLabel(runtimeStatus)}
      </div>

      <div className="ai-session-tools">
        <label>
          <span className="sr-only">Discussion history</span>
          <select
            aria-label="Discussion history"
            disabled={isSending}
            onChange={(event) => {
              void openSession(event.target.value).catch(() => {
                setErrorMessage("The discussion could not be opened.");
              });
            }}
            value={snapshot.session.id}
          >
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}
              </option>
            ))}
          </select>
        </label>
        <button
          aria-label="New discussion"
          disabled={isSending}
          onClick={() => {
            void (async () => {
              const created = await trackMutation("session-create", () =>
                repository.createSession({
                  id: createId(),
                  model: settings.model,
                  timestamp: Date.now(),
                  title: "New discussion",
                }),
              );
              setSnapshot(emptySnapshot(created));
              onActiveSessionChangeRef.current?.(created.id);
              await refreshSessions();
            })().catch(() => setErrorMessage("A new discussion could not be created."));
          }}
          type="button"
        >
          +
        </button>
        <button
          aria-label="Rename discussion"
          disabled={isSending}
          onClick={() => {
            setRenameDraft(snapshot.session.title);
            setRenaming(true);
          }}
          type="button"
        >
          Rename
        </button>
        <button
          aria-label="Delete discussion"
          disabled={isSending}
          onClick={() => {
            void (async () => {
              await trackMutation(`session:${snapshot.session.id}`, () =>
                repository.deleteSession(snapshot.session.id),
              );
              let remaining = await refreshSessions();
              if (!remaining[0]) {
                const created = await trackMutation("session-create", () =>
                  repository.createSession({
                    id: createId(),
                    model: settings.model,
                    timestamp: Date.now(),
                    title: "New discussion",
                  }),
                );
                remaining = [created];
                setSessions(remaining);
              }
              const loaded = await repository.loadSession(remaining[0].id);
              setSnapshot(loaded ?? emptySnapshot(remaining[0]));
              onActiveSessionChangeRef.current?.(remaining[0].id);
            })().catch(() => setErrorMessage("The discussion could not be deleted."));
          }}
          type="button"
        >
          Delete
        </button>
      </div>

      {renaming && (
        <form
          className="ai-rename"
          onSubmit={(event) => {
            event.preventDefault();
            const title = renameDraft.trim();
            if (!title) return;
            void trackMutation(`session:${snapshot.session.id}`, () =>
              repository.renameSession(
                snapshot.session.id,
                title.slice(0, 120),
                Date.now(),
              ),
            )
              .then(async () => {
                setRenaming(false);
                await Promise.all([openSession(snapshot.session.id), refreshSessions()]);
              })
              .catch(() => setErrorMessage("The discussion could not be renamed."));
          }}
        >
          <input aria-label="Discussion title" maxLength={120} onChange={(event) => setRenameDraft(event.target.value)} value={renameDraft} />
          <button type="submit">Save</button>
          <button
            onClick={() => {
              clearMutationFailure(`session:${snapshot.session.id}`);
              setRenaming(false);
            }}
            type="button"
          >
            Cancel
          </button>
        </form>
      )}

      <section aria-label="Paper context" className="ai-context">
        <div className="ai-context__heading">
          <span>Paper context</span>
          <div className="ai-context__actions">
            {currentPaper && !currentPaperAttached && (
              <button onClick={() => setPendingPaper(currentPaper)} type="button">
                Attach current PDF
              </button>
            )}
            <button onClick={() => setShowPaperPicker((value) => !value)} type="button">
              Add paper context
            </button>
          </div>
        </div>
        {snapshot.contexts.length === 0 ? (
          <p>
            No papers attached. Codex receives this chat plus its standard runtime
            system instructions.
          </p>
        ) : (
          <div className="ai-context__chips">
            {snapshot.contexts.map(({ paper }) => (
              <span key={paper.id}>
                {paper.title}
                <button
                  aria-label={`Remove ${paper.title} from context`}
                  disabled={isSending}
                  onClick={() => {
                    void trackMutation(
                      `context:${snapshot.session.id}:${paper.id}`,
                      () =>
                        repository.removeContext(
                          snapshot.session.id,
                          paper.id,
                          Date.now(),
                        ),
                    )
                      .then(() => openSession(snapshot.session.id))
                      .then(() => refreshSessions())
                      .catch(() => setErrorMessage("Paper context could not be removed."));
                  }}
                  type="button"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {showPaperPicker && (
          <div className="ai-paper-picker">
            <input
              aria-label="Search papers for context"
              onChange={(event) => setPaperSearch(event.target.value)}
              placeholder="Search local papers"
              type="search"
              value={paperSearch}
            />
            <div>
              {filteredPapers.map((paper) => (
                <button
                  aria-label={`Attach ${paper.title}`}
                  key={paper.id}
                  onClick={() => setPendingPaper(paper)}
                  type="button"
                >
                  <strong>{paper.title}</strong>
                  <small>{paper.authors || "Unknown authors"}</small>
                </button>
              ))}
              {filteredPapers.length === 0 && <p>No unattached papers match.</p>}
            </div>
          </div>
        )}
      </section>

      <div className="ai-messages" aria-live="polite">
        {snapshot.messages.length === 0 && !isSending && (
          <div className="ai-messages__empty">
            <span aria-hidden="true">✦</span>
            <p>Discuss a claim, compare attached papers, or ask for a structured reading.</p>
          </div>
        )}
        {snapshot.messages.map((message) => (
          <article className={`ai-message ai-message--${message.role}`} key={message.id}>
            <span>{message.role === "user" ? "You" : "Codex"}</span>
            <MarkdownMessage content={message.content || "…"} />
            {message.status === "interrupted" && <small>Stopped</small>}
            {message.status === "error" && <small>Turn failed</small>}
          </article>
        ))}
        {isSending && (
          <>
            <article className="ai-message ai-message--user">
              <span>You</span>
              <p>{liveUser}</p>
            </article>
            <article className="ai-message ai-message--assistant ai-message--streaming">
              <span>Codex</span>
              <MarkdownMessage content={liveAssistant || "Thinking…"} />
            </article>
          </>
        )}
      </div>

      {errorMessage && <p className="ai-panel__error" role="alert">{errorMessage}</p>}
      {!runtimeReady && (
        <p className="ai-panel__notice">
          PaperCanvas intentionally requires “Sign in with ChatGPT” so this provider cannot spend an API-key balance.
        </p>
      )}
      <form
        className="ai-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="Message Codex"
          disabled={isSending || !runtimeReady}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Ask about the paper…"
          rows={3}
          value={prompt}
        />
        <div>
          <span>
            {modelLabel(snapshot.session.model)} · {reasoningLabel(settings.reasoningEffort)} reasoning
          </span>
          {isSending ? (
            <button
              disabled={!activeRequestId || isStopping}
              onClick={() => {
                if (!activeRequestId) return;
                setIsStopping(true);
                void controller.cancel(activeRequestId).catch(() => {
                  setIsStopping(false);
                  setErrorMessage("The active Codex turn could not be stopped.");
                });
              }}
              type="button"
            >
              {isStopping ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button disabled={!prompt.trim() || !runtimeReady} type="submit">Send</button>
          )}
        </div>
      </form>

      {pendingPaper && (
        <div aria-label="Attach paper disclosure" className="ai-disclosure" role="dialog">
          <div className="ai-disclosure__scrim" />
          <div className="ai-disclosure__card">
            <span className="ai-eyebrow">Explicit context</span>
            <h3>{pendingPaper.title}</h3>
            <p>
              The complete extracted text will be sent to Codex through your ChatGPT account in this discussion. PaperCanvas will not truncate it silently.
            </p>
            <div>
              <button
                onClick={() => {
                  const attachment = attachAbortControllerRef.current;
                  if (attachment) attachment.abort();
                  setPendingPaper(null);
                }}
                type="button"
              >
                {isAttaching ? "Cancel extraction" : "Cancel"}
              </button>
              <button className="is-primary" disabled={isAttaching} onClick={() => void attachPaper()} type="button">
                {isAttaching ? "Extracting…" : "Attach full text"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <SettingsDialog
          onClose={() => {
            setShowSettings(false);
            queueMicrotask(() => settingsButtonRef.current?.focus());
          }}
          onSave={async (next) => {
            await trackMutation("settings", async () => {
              await repository.saveSettings(next, snapshot.session.id);
            });
            setSettings(next);
            setSnapshot((current) =>
              current?.session.id === snapshot.session.id
                ? {
                    ...current,
                    session: {
                      ...current.session,
                      model: next.model,
                      updatedAt: next.updatedAt,
                    },
                  }
                : current,
            );
            void refreshSessions().catch(() => {
              setErrorMessage(
                "Settings were saved locally, but the discussion state could not refresh.",
              );
            });
          }}
          runtimeStatus={runtimeStatus}
          settings={{ ...settings, model: snapshot.session.model }}
        />
      )}
    </aside>
  );
}
