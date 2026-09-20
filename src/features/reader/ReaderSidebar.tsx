import { MarkdownNoteEditor } from "./MarkdownNoteEditor";
import { createPortal } from "react-dom";
import { ReaderToolbarContext } from "./ReaderToolbarContext";
import {
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import type { PdfHighlight } from "./model/pdfHighlight";

import type { ReaderWorkspace } from "./model/readerState";
import type { NoteCitation } from "./model/noteCitation";

export interface ReaderSidebarProps {
  initialWorkspace?: ReaderWorkspace;
  workspace?: ReaderWorkspace;
  onWorkspaceChange?: (workspace: ReaderWorkspace) => void;
  onAddHighlightToNotes?: (highlight: PdfHighlight) => void;
  onCitation?: (citation: NoteCitation) => void;
  discussion?: ReactNode;
  errorMessage?: string | null;
  highlights: PdfHighlight[];
  id?: string;
  isHidden?: boolean;
  isNoteDisabled: boolean;
  mindMap?: ReactNode;
  noteDraft: string;
  noteLoadError?: string | null;
  noteSaveError?: string | null;
  noteStatus: string;
  noteFileName?: string;
  onReloadNote?: () => void;
  onRevealNote?: () => Promise<void>;
  notesRef?: Ref<HTMLTextAreaElement>;
  onDeleteHighlight: (highlight: PdfHighlight) => void;
  onNoteChange: (value: string) => void;
  onRetryNoteLoad?: () => void;
  onRetryNoteSave?: () => void;
  onRetry?: () => void;
  onSelectHighlight: (highlight: PdfHighlight) => void;
  selectedHighlightId?: string | null;
}

export function ReaderSidebar({
  initialWorkspace = "notes",
  workspace,
  onWorkspaceChange,
  onAddHighlightToNotes,
  onCitation,
  discussion,
  errorMessage,
  highlights,
  id,
  isHidden = false,
  isNoteDisabled,
  mindMap,
  noteDraft,
  noteLoadError,
  noteSaveError,
  noteStatus,
  noteFileName,
  onReloadNote,
  onRevealNote,
  notesRef,
  onDeleteHighlight,
  onNoteChange,
  onRetryNoteLoad,
  onRetryNoteSave,
  onRetry,
  onSelectHighlight,
  selectedHighlightId,
}: ReaderSidebarProps) {
  const toolbar = useContext(ReaderToolbarContext);
  const [search, setSearch] = useState("");
  const [localWorkspace, setActiveWorkspace] =
    useState<ReaderWorkspace>(initialWorkspace);
  const activeWorkspace = workspace ?? localWorkspace;
  const [hasOpenedMindMap, setHasOpenedMindMap] = useState(initialWorkspace === "mindmap" || workspace === "mindmap");
  const [highlightsExpanded, setHighlightsExpanded] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const tabIdPrefix = useId();
  const notesTabRef = useRef<HTMLButtonElement>(null);
  const mindMapTabRef = useRef<HTMLButtonElement>(null);
  const discussionTabRef = useRef<HTMLButtonElement>(null);
  const activateWorkspace = (workspace: ReaderWorkspace) => {
    setSearchOpen(false);
    setSearch("");
    if (workspace === "mindmap") setHasOpenedMindMap(true);
    setActiveWorkspace(workspace);
    onWorkspaceChange?.(workspace);
  };
  const navigateWorkspaceTabs = (
    event: KeyboardEvent<HTMLButtonElement>,
    current: ReaderWorkspace,
  ) => {
    const workspaces: ReaderWorkspace[] = discussion
      ? ["notes", "mindmap", "discussion"]
      : ["notes", "mindmap"];
    const currentIndex = workspaces.indexOf(current);
    let next: ReaderWorkspace | null = null;
    if (event.key === "Home") next = workspaces[0];
    else if (event.key === "End") next = workspaces[workspaces.length - 1] ?? null;
    else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = workspaces[(currentIndex + 1) % workspaces.length];
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = workspaces[(currentIndex - 1 + workspaces.length) % workspaces.length];
    }
    if (!next) return;
    event.preventDefault();
    activateWorkspace(next);
    if (next === "notes") notesTabRef.current?.focus();
    else if (next === "mindmap") mindMapTabRef.current?.focus();
    else discussionTabRef.current?.focus();
  };
  const visibleHighlights = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return highlights;
    return highlights.filter((highlight) =>
      `${highlight.text} ${highlight.comment} ${highlight.pageNumber}`
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [highlights, search]);

  const workspaceHeading = (
        <div className="paper-reader__notes-heading">
          <div
            aria-label="Paper workspace"
            className="paper-reader__workspace-tabs"
            role="tablist"
          >
            <button
              aria-controls={`${tabIdPrefix}-notes-panel`}
              aria-selected={activeWorkspace === "notes"}
              className={activeWorkspace === "notes" ? "is-active" : ""}
              id={`${tabIdPrefix}-notes-tab`}
              onClick={() => activateWorkspace("notes")}
              onKeyDown={(event) => navigateWorkspaceTabs(event, "notes")}
              ref={notesTabRef}
              role="tab"
              tabIndex={activeWorkspace === "notes" ? 0 : -1}
              type="button"
            >
              Notes
            </button>
            <button
              aria-controls={`${tabIdPrefix}-mindmap-panel`}
              aria-selected={activeWorkspace === "mindmap"}
              className={activeWorkspace === "mindmap" ? "is-active" : ""}
              id={`${tabIdPrefix}-mindmap-tab`}
              onClick={() => activateWorkspace("mindmap")}
              onKeyDown={(event) => navigateWorkspaceTabs(event, "mindmap")}
              ref={mindMapTabRef}
              role="tab"
              tabIndex={activeWorkspace === "mindmap" ? 0 : -1}
              type="button"
            >
              Mind map
            </button>
            {discussion && (
              <button
                aria-controls={`${tabIdPrefix}-discussion-panel`}
                aria-selected={activeWorkspace === "discussion"}
                className={activeWorkspace === "discussion" ? "is-active" : ""}
                id={`${tabIdPrefix}-discussion-tab`}
                onClick={() => activateWorkspace("discussion")}
                onKeyDown={(event) => navigateWorkspaceTabs(event, "discussion")}
                ref={discussionTabRef}
                role="tab"
                tabIndex={activeWorkspace === "discussion" ? 0 : -1}
                type="button"
              >
                AI chat
              </button>
            )}
          </div>
          {activeWorkspace === "notes" && (
            <span aria-live="polite">{noteStatus}</span>
          )}
        </div>
  );

  return (
    <aside
      className="paper-reader__sidebar"
      hidden={isHidden}
      id={id}
      aria-label={
        discussion
          ? "Notes, mind map, AI chat, and highlights panel"
          : "Notes, mind map, and highlights panel"
      }
    >
      <section
        aria-label={
          discussion
            ? "Paper notes, mind map, and AI chat"
            : "Paper notes and mind map"
        }
        className={`paper-reader__notes${activeWorkspace === "discussion" ? " is-chat-workspace" : ""}${
          activeWorkspace !== "notes" ? " is-workspace-expanded" : ""
        }`}
      >
        {toolbar.workspace ? createPortal(workspaceHeading, toolbar.workspace) : workspaceHeading}
        <div
          aria-labelledby={`${tabIdPrefix}-notes-tab`}
          className="paper-reader__workspace-panel paper-reader__workspace-panel--notes"
          hidden={activeWorkspace !== "notes"}
          id={`${tabIdPrefix}-notes-panel`}
          role="tabpanel"
        >
          {noteLoadError ? (
            <div className="paper-reader__note-error" role="alert">
              <p>{noteLoadError}</p>
              {onRetryNoteLoad && (
                <button onClick={onRetryNoteLoad} type="button">
                  Retry loading note
                </button>
              )}
            </div>
          ) : (
            <MarkdownNoteEditor
              disabled={isNoteDisabled}
              onChange={onNoteChange}
              editorRef={notesRef}
              value={noteDraft}
              status={noteStatus}
              fileName={noteFileName}
              onReload={onReloadNote}
              onReveal={onRevealNote}
              onCitation={onCitation}
            />
          )}
          {noteSaveError && (
            <div className="paper-reader__note-error" role="alert">
              <p>{noteSaveError}</p>
              {onRetryNoteSave && (
                <button onClick={onRetryNoteSave} type="button">
                  Retry save
                </button>
              )}
            </div>
          )}
        </div>
        <div
          aria-labelledby={`${tabIdPrefix}-mindmap-tab`}
          className="paper-reader__workspace-panel paper-reader__workspace-panel--mindmap"
          hidden={activeWorkspace !== "mindmap"}
          id={`${tabIdPrefix}-mindmap-panel`}
          role="tabpanel"
        >
          {(hasOpenedMindMap || activeWorkspace === "mindmap") &&
            (mindMap ?? (
              <p className="paper-reader__mindmap-unavailable">
                Mind map is unavailable for this paper.
              </p>
            ))}
        </div>
        {discussion && (
          <div
            aria-labelledby={`${tabIdPrefix}-discussion-tab`}
            className="paper-reader__workspace-panel paper-reader__workspace-panel--discussion"
            hidden={activeWorkspace !== "discussion"}
            id={`${tabIdPrefix}-discussion-panel`}
            role="tabpanel"
          >
            <ReaderToolbarContext.Provider value={{ ...toolbar, visible: !isHidden && activeWorkspace === "discussion" }}>
              {discussion}
            </ReaderToolbarContext.Provider>
          </div>
        )}
      </section>

      {activeWorkspace === "notes" && (
        <section
          aria-label="Highlights"
          className={`paper-reader__highlights${highlights.length === 0 || !highlightsExpanded ? " is-compact" : ""}`}
        >
          {highlights.length === 0 ? (
            <p className="paper-reader__highlight-hint">Select PDF text to add a highlight or annotation.</p>
          ) : <>
            <div className="paper-reader__highlights-heading">
              <button type="button" aria-expanded={highlightsExpanded} aria-controls={`${tabIdPrefix}-highlights`}
                onClick={() => setHighlightsExpanded((expanded) => !expanded)}>
                <span aria-hidden="true">{highlightsExpanded ? "▾" : "▸"}</span> Highlights <span>{highlights.length}</span>
              </button>
              {highlightsExpanded && <button type="button" aria-label="Find highlights" aria-expanded={searchOpen}
                onClick={() => { setSearchOpen((open) => !open); setSearch(""); }}>⌕</button>}
            </div>
            {highlightsExpanded && searchOpen && <label className="paper-reader__highlight-search">
              <input aria-label="Search highlights" autoFocus
                onChange={(event) => setSearch(event.target.value)} placeholder="Search highlights"
                onKeyDown={(event) => { if (event.key === "Escape") { setSearchOpen(false); setSearch(""); } }}
                type="search" value={search} />
            </label>}
          </>}

          {errorMessage && (
            <div className="paper-reader__highlight-error" role="alert">
              <span>{errorMessage}</span>
              {onRetry && (
                <button onClick={onRetry} type="button">
                  Retry
                </button>
              )}
            </div>
          )}

          {highlights.length > 0 && <div className="paper-reader__highlight-list" id={`${tabIdPrefix}-highlights`} hidden={!highlightsExpanded}>
            {visibleHighlights.map((highlight) => (
              <article
                className={`paper-reader__highlight${
                  selectedHighlightId === highlight.id ? " is-selected" : ""
                }`}
                key={highlight.id}
              >
                <button
                  aria-label={`Go to highlight on page ${highlight.pageNumber}`}
                  className="paper-reader__highlight-target"
                  onClick={() => onSelectHighlight(highlight)}
                  type="button"
                >
                  <span className="paper-reader__highlight-quote">
                    “{highlight.text}” <small>· p. {highlight.pageNumber}</small>
                  </span>
                  {highlight.comment && (
                    <span className="paper-reader__highlight-comment">
                      {highlight.comment}
                    </span>
                  )}
                </button>
                {onAddHighlightToNotes && <button type="button" className="paper-reader__highlight-add"
                  disabled={isNoteDisabled || !!noteLoadError}
                  aria-label={`Add highlight from page ${highlight.pageNumber} to notes`}
                  onClick={() => onAddHighlightToNotes(highlight)}>Add to notes</button>}
                <button
                  aria-label={`Delete highlight from page ${highlight.pageNumber}`}
                  className="paper-reader__highlight-delete"
                  onClick={() => onDeleteHighlight(highlight)}
                  title="Delete highlight"
                  type="button"
                >
                  ×
                </button>
              </article>
            ))}
            {visibleHighlights.length === 0 && (
              <p className="paper-reader__highlight-empty">
                {highlights.length === 0
                  ? "Select text in the PDF to save your first highlight."
                  : "No highlights match this search."}
              </p>
            )}
          </div>}
        </section>
      )}
    </aside>
  );
}
