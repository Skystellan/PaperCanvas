import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Paper } from "../library/model/paper";
import {
  usePersistenceCoordinator,
  usePersistenceWriter,
} from "../persistence";
import {
  PaperMindMap,
  type MindMapRepository,
} from "../mindmap";
import {
  PdfViewer,
  type PdfFileReader,
  type PdfJsAdapter,
  type PdfSelectionActions,
  type PdfSelectionNoteRequest,
} from "./PdfViewer";
import { markdownNoteRepository } from "./data/markdownNoteRepository";
import { sqliteHighlightRepository } from "./data/sqliteHighlightRepository";
import { ReaderToolbarContext } from "./ReaderToolbarContext";
import { ReaderSidebar } from "./ReaderSidebar";
import type {
  PdfHighlight,
  PdfHighlightRepository,
} from "./model/pdfHighlight";
import type { NoteRepository } from "./model/noteAutosaveController";
import { useAutosavingNote } from "./useAutosavingNote";
import { usePdfHighlights } from "./usePdfHighlights";
import "./reader.css";

import { loadReaderState, saveReaderState, type PdfReadingLocation, type ReaderWorkspace } from "./model/readerState";
import { highlightMarkdown, type NoteCitation } from "./model/noteCitation";

const DEFAULT_SIDEBAR_RATIO = 34;
const MIN_SIDEBAR_RATIO = 24;
const MAX_SIDEBAR_RATIO = 60;
const SIDEBAR_KEYBOARD_STEP = 2;

function clampSidebarRatio(ratio: number): number {
  return Math.min(
    Math.max(Math.round(ratio * 10) / 10, MIN_SIDEBAR_RATIO),
    MAX_SIDEBAR_RATIO,
  );
}

export interface PaperReaderProps {
  initialDiscussionOpen?: boolean;
  discussion?: ReactNode;
  paper: Paper;
  onBack: () => void | Promise<void>;
  highlightRepository?: PdfHighlightRepository;
  mindMapRepository?: MindMapRepository;
  noteRepository?: NoteRepository;
  pdfJs?: PdfJsAdapter;
  readPdfFile?: PdfFileReader;
}

export function PaperReader(props: PaperReaderProps) {
  return <PaperReaderSession key={props.paper.id} {...props} />;
}

function PaperReaderSession({
  initialDiscussionOpen = false,
  discussion,
  highlightRepository = sqliteHighlightRepository,
  mindMapRepository,
  noteRepository = markdownNoteRepository,
  onBack,
  paper,
  pdfJs,
  readPdfFile,
}: PaperReaderProps) {
  const { flushPending } = usePersistenceCoordinator();
  const note = useAutosavingNote(paper.id, noteRepository);
  const {
    errorMessage: highlightError,
    highlights,
    load: loadHighlights,
    remove: removeHighlight,
    save: saveHighlight,
  } = usePdfHighlights(paper.id, highlightRepository);
  const [isLeaving, setIsLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState(false);
  const [workspaceToolbar, setWorkspaceToolbar] = useState<HTMLDivElement | null>(null);
  const [chatToolbar, setChatToolbar] = useState<HTMLDivElement | null>(null);
  const [savedState] = useState(() => loadReaderState(paper.id));
  const [isSidebarOpen, updateSidebarOpen] = useState(initialDiscussionOpen || (savedState.sidebarOpen ?? true));
  const [sidebarRatio, updateSidebarRatio] = useState(savedState.sidebarRatio ?? DEFAULT_SIDEBAR_RATIO);
  const [workspace, updateWorkspace] = useState<ReaderWorkspace>(initialDiscussionOpen && discussion ? "discussion" : savedState.workspace === "discussion" && !discussion ? "notes" : savedState.workspace ?? "notes");
  const setIsSidebarOpen = (value: boolean | ((previous: boolean) => boolean)) => {
    const next = typeof value === "function" ? value(isSidebarOpen) : value;
    updateSidebarOpen(next); saveReaderState(paper.id, { sidebarOpen: next });
  };
  const setSidebarRatio = useCallback((value: number | ((previous: number) => number)) => {
    updateSidebarRatio((previous) => {
      const next = typeof value === "function" ? value(previous) : value;
      saveReaderState(paper.id, { sidebarRatio: next }); return next;
    });
  }, [paper.id]);
  const setWorkspace = (next: ReaderWorkspace) => {
    updateWorkspace(next); saveReaderState(paper.id, { workspace: next });
  };
  const saveLocation = useCallback((location: PdfReadingLocation) => {
    saveReaderState(paper.id, { location });
  }, [paper.id]);
  const [citationTarget, setCitationTarget] = useState<NoteCitation | null>(null);
  const [selectedHighlightId, setSelectedHighlightId] = useState<string | null>(
    null,
  );
  const sidebarId = useId();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const pendingArtifactOperations = useRef(new Set<Promise<void>>());
  const retryArtifactOperations = useRef(
    new Map<string, () => Promise<void>>(),
  );

  const executeArtifactMutation = useCallback(
    (key: string, mutation: () => Promise<void>) => {
      const retry = async () => {
        const operation = mutation();
        pendingArtifactOperations.current.add(operation);
        try {
          await operation;
          if (retryArtifactOperations.current.get(key) === retry) {
            retryArtifactOperations.current.delete(key);
          }
        } finally {
          pendingArtifactOperations.current.delete(operation);
        }
      };
      retryArtifactOperations.current.set(key, retry);
      return retry();
    },
    [],
  );

  usePersistenceWriter(
    `reader-artifacts:${paper.id}`,
    useMemo(
      () => ({
        isDirty: () =>
          pendingArtifactOperations.current.size > 0 ||
          retryArtifactOperations.current.size > 0,
        flush: async () => {
          const active = [...pendingArtifactOperations.current];
          if (active.length > 0) await Promise.all(active);
          while (retryArtifactOperations.current.size > 0) {
            await Promise.all([...retryArtifactOperations.current.values()].map(
              (retry) => retry(),
            ));
          }
        },
      }),
      [],
    ),
  );

  const leaveReader = useCallback(async () => {
    if (isLeaving) return;
    setIsLeaving(true);
    setLeaveError(false);

    try {
      await flushPending();
      await onBack();
    } catch {
      setLeaveError(true);
      setIsLeaving(false);
    }
  }, [flushPending, isLeaving, onBack]);

  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
    },
    [],
  );

  const startSidebarResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const workspace = workspaceRef.current;
      if (!workspace) return;
      const bounds = workspace.getBoundingClientRect();
      if (bounds.width <= 0) return;

      event.preventDefault();
      resizeCleanupRef.current?.();
      const onPointerMove = (moveEvent: PointerEvent) => {
        const nextRatio = ((bounds.right - moveEvent.clientX) / bounds.width) * 100;
        setSidebarRatio(clampSidebarRatio(nextRatio));
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
    [setSidebarRatio],
  );

  const saveSelectionNote = useCallback(
    async (request: PdfSelectionNoteRequest) => {
      await executeArtifactMutation("save-highlight", async () => {
        const highlight = await saveHighlight(request);
        setSelectedHighlightId(highlight.id);
      });
    },
    [executeArtifactMutation, saveHighlight],
  );
  const addHighlightToNotes = (highlight: PdfHighlight) => {
    if (note.isLoading || note.loadError || isLeaving) return;
    note.append(highlightMarkdown(highlight, paper.title));
    setIsSidebarOpen(true);
    setWorkspace("notes");
  };
  const selectionActions: PdfSelectionActions = {
    saveNote: saveSelectionNote,
    ...(!note.isLoading && !note.loadError && !isLeaving ? {
      addToNotes: async (request: PdfSelectionNoteRequest) => {
        await executeArtifactMutation("save-highlight", async () => {
          const highlight = await saveHighlight(request);
          setSelectedHighlightId(highlight.id);
          addHighlightToNotes(highlight);
        });
      },
    } : {}),
  };


  return (
    <ReaderToolbarContext.Provider value={{ workspace: workspaceToolbar, chat: chatToolbar, visible: isSidebarOpen }}>
    <section className="paper-reader" aria-label={`Reading ${paper.title}`}>
      <header className="paper-reader__header">
        <button
          aria-label="Back to canvas"
          disabled={isLeaving}
          onClick={() => void leaveReader()}
          type="button"
        >
          ← Back
        </button>
        <div className="paper-reader__title">
          <h1 title={paper.title}>{paper.title}</h1>
          {(paper.authors || paper.year) && <p>{[paper.authors, paper.year].filter(Boolean).join(" · ")}</p>}
        </div>
        <div className="paper-reader__toolbar-slot" ref={setWorkspaceToolbar} hidden={!isSidebarOpen} />
        <div className="paper-reader__toolbar-slot" ref={setChatToolbar} hidden={!isSidebarOpen} />
        <button
          aria-controls={sidebarId}
          aria-expanded={isSidebarOpen}
          aria-label={`${isSidebarOpen ? "Hide" : "Show"} reader sidebar`}
          className="paper-reader__sidebar-toggle"
          onClick={() => setIsSidebarOpen((isOpen) => !isOpen)}
          type="button"
        >
          <span aria-hidden="true">{isSidebarOpen ? "▸" : "◂"}</span>
          <span>{isSidebarOpen ? "Hide panel" : "Show panel"}</span>
        </button>
      </header>

      {leaveError && (
        <div className="paper-reader__leave-error" role="alert">
          <span>Your local changes could not be saved before leaving.</span>
          <button onClick={() => void leaveReader()} type="button">
            Retry save
          </button>
        </div>
      )}

      <div
        className={`paper-reader__workspace${
          isSidebarOpen ? "" : " paper-reader__workspace--sidebar-hidden"
        }`}
        ref={workspaceRef}
        style={
          {
            "--paper-reader-sidebar-width": `${sidebarRatio}%`,
          } as CSSProperties
        }
      >
        <PdfViewer
          filePath={paper.filePath}
          initialLocation={savedState.location}
          onLocationChange={saveLocation}
          navigationTarget={citationTarget}
          focusedHighlightId={selectedHighlightId}
          highlights={highlights}
          pdfJs={pdfJs}
          readPdfFile={readPdfFile}
          selectionActions={selectionActions}
        />
        {isSidebarOpen && (
          <div
            aria-label="Resize reader sidebar"
            aria-orientation="vertical"
            aria-valuemax={MAX_SIDEBAR_RATIO}
            aria-valuemin={MIN_SIDEBAR_RATIO}
            aria-valuenow={sidebarRatio}
            aria-valuetext={`${sidebarRatio}% of reader width`}
            className="paper-reader__sidebar-resizer"
            onDoubleClick={() => setSidebarRatio(DEFAULT_SIDEBAR_RATIO)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                setSidebarRatio((ratio) =>
                  clampSidebarRatio(ratio + SIDEBAR_KEYBOARD_STEP),
                );
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                setSidebarRatio((ratio) =>
                  clampSidebarRatio(ratio - SIDEBAR_KEYBOARD_STEP),
                );
              } else if (event.key === "Home") {
                event.preventDefault();
                setSidebarRatio(MIN_SIDEBAR_RATIO);
              } else if (event.key === "End") {
                event.preventDefault();
                setSidebarRatio(MAX_SIDEBAR_RATIO);
              }
            }}
            onPointerDown={startSidebarResize}
            role="separator"
            tabIndex={0}
          />
        )}
        <ReaderSidebar
          workspace={workspace}
          onWorkspaceChange={setWorkspace}
          onAddHighlightToNotes={addHighlightToNotes}
          onCitation={(citation) => {
            if (citation.paperId !== paper.id) return;
            setSelectedHighlightId(citation.highlightId ?? null);
            setCitationTarget({ ...citation });
          }}
          discussion={discussion}
          errorMessage={highlightError}
          highlights={highlights}
          id={sidebarId}
          isHidden={!isSidebarOpen}
          isNoteDisabled={note.isLoading || isLeaving}
          mindMap={<PaperMindMap paperId={paper.id} repository={mindMapRepository} />}
          noteDraft={note.draft}
          noteLoadError={note.loadError}
          noteSaveError={!leaveError ? note.saveError : null}
          noteFileName={`${paper.id}.md`}
          onReloadNote={() => void note.reload()}
          onRevealNote={noteRepository.reveal ? () => noteRepository.reveal!(paper.id) : undefined}
          noteStatus={
            note.isLoading ? "Loading…" : note.isSaving ? "Saving…" : note.saveError ? "Not saved" : note.hasUnsavedChanges ? "Unsaved changes" : "Saved locally"
          }
          onDeleteHighlight={(highlight: PdfHighlight) => {
            void executeArtifactMutation(
              `delete-highlight:${highlight.id}`,
              async () => {
                await removeHighlight(highlight);
                if (selectedHighlightId === highlight.id) {
                  setSelectedHighlightId(null);
                }
              },
            ).catch(() => undefined);
          }}
          onNoteChange={note.setDraft}
          onRetry={() => {
            if (highlightError === "Your highlights could not be loaded.") {
              void loadHighlights();
            } else {
              void flushPending().catch(() => undefined);
            }
          }}
          onRetryNoteLoad={() => void note.retryLoad()}
          onRetryNoteSave={() => void note.flush().catch(() => undefined)}
          onSelectHighlight={(highlight) => setSelectedHighlightId(highlight.id)}
          selectedHighlightId={selectedHighlightId}
        />
      </div>
    </section>
    </ReaderToolbarContext.Provider>
  );
}

export const ReaderView = PaperReader;
