import { useCallback, useEffect, useRef, useState } from "react";
import { executeWorkspaceCommand, listenForExternalWorkspaceChanges } from "./data/workspaceClient";
import { useResearchBridge } from "./features/research/useResearchBridge";
import { ResearchImports } from "./features/research/ResearchImports";
import { WebChatPanel, RecentDiscussions } from "./features/ai";
import {
  PaperLibrary,
  SqlitePaperRepository,
  type Paper,
  type PaperCatalogChange,
  type PaperDropIntent,
} from "./features/library";
import {
  PersistenceCoordinator,
  usePersistenceCoordinator,
} from "./features/persistence";
import { PaperReader } from "./features/reader";
import { Whiteboard } from "./features/whiteboard/Whiteboard";
import "./App.css";

const paperRepository = new SqlitePaperRepository();

function PaperCanvasApp() {
  const { flushPending, trackOperation } = usePersistenceCoordinator();
  const [requestedWebChatId, setRequestedWebChatId] = useState<string | null>(null);
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null);
  const [readingPaper, setReadingPaper] = useState<Paper | null>(null);
  const [paperFocusRequest, setPaperFocusRequest] = useState<{
    paperId: string;
    revision: number;
  } | null>(null);
  const [paperDropIntent, setPaperDropIntent] =
    useState<PaperDropIntent | null>(null);
  const [paperCatalogChange, setPaperCatalogChange] =
    useState<PaperCatalogChange | null>(null);
  const [navigationError, setNavigationError] = useState(false);
  const [externalRevision, setExternalRevision] = useState(0);
  const [externalUpdateError, setExternalUpdateError] = useState(false);
  const openingReaderRef = useRef(false);
  const catalogRevision = useRef(0);
  const [boardReady, setBoardReady] = useState(false);
  const [selectedBoardPapers, setSelectedBoardPapers] = useState<string[]>([]);
  const [undoBusy, setUndoBusy] = useState(false);
  const [researchFocus, setResearchFocus] = useState<{ paperIds: string[]; revision: number } | null>(null);
  const refreshWaiters = useRef<Array<{ revision: number; resolve: () => void; reject: () => void; timer: ReturnType<typeof setTimeout> }>>([]);

  const publishPaperCatalogChange = useCallback(
    (kind: PaperCatalogChange["kind"], paperIds: string[]) => {
      const revision = ++catalogRevision.current;
      setPaperCatalogChange({
        kind,
        paperIds,
        revision,
      });
      return revision;
    },
    [],
  );

  const refreshResearchWorkspace = useCallback((paperIds?: string[]) => {
    const revision = publishPaperCatalogChange("external", []);
    if (paperIds?.length) setResearchFocus({ paperIds, revision });
    setExternalRevision(current => current + 1);
    return new Promise<void>((resolve, reject) => {
      const waiter = { revision, resolve, reject: () => reject(new Error("Workspace refresh failed.")), timer: setTimeout(() => {
        refreshWaiters.current = refreshWaiters.current.filter(item => item !== waiter);
        setExternalUpdateError(true);
        reject(new Error("Workspace refresh timed out."));
      }, 10_000) };
      refreshWaiters.current.push(waiter);
    });
  }, [publishPaperCatalogChange]);

  const onSnapshotLoaded = useCallback((revision: number) => {
    setBoardReady(true);
    refreshWaiters.current = refreshWaiters.current.filter(waiter => {
      if (waiter.revision > revision) return true;
      clearTimeout(waiter.timer); waiter.resolve(); return false;
    });
  }, []);
  const onSnapshotFailed = useCallback(() => {
    for (const waiter of refreshWaiters.current) { clearTimeout(waiter.timer); waiter.reject(); }
    refreshWaiters.current = [];
  }, []);
  useEffect(() => () => {
    for (const waiter of refreshWaiters.current) { clearTimeout(waiter.timer); waiter.reject(); }
    refreshWaiters.current = [];
  }, []);

  const researchBusy = useResearchBridge({
    ready: boardReady,
    flushPending,
    selectedPaperIds: readingPaper ? [readingPaper.id] : selectedBoardPapers,
    refreshWorkspace: refreshResearchWorkspace,
  });
  const busy = researchBusy || undoBusy;

  const undoResearchBatch = async (batchId: string) => {
    setUndoBusy(true);
    try {
      await flushPending();
      await executeWorkspaceCommand({ type: "undo_research_batch", batchId });
      await refreshResearchWorkspace();
    } finally { setUndoBusy(false); }
  };

  useEffect(() => {
    let active = true;
    let updates = Promise.resolve();
    const subscription = listenForExternalWorkspaceChanges(() => {
      updates = updates.then(async () => {
        if (!active) return;
        // A stale board save is rejected by Rust. Keep drafts mounted when flushing
        // fails; never replace them with an external snapshot or retry at a new revision.
        await flushPending();
        if (!active) return;
        setExternalRevision((revision) => revision + 1);
        publishPaperCatalogChange("external", []);
        setExternalUpdateError(false);
      }).catch(() => {
        if (active) setExternalUpdateError(true);
      });
    });
    void subscription.catch(() => {
      if (active) setExternalUpdateError(true);
    });
    return () => {
      active = false;
      void subscription.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [flushPending, publishPaperCatalogChange]);

  const openReader = useCallback(
    async (paper: Paper, webChatId: string | null = null) => {
      if (openingReaderRef.current) return;
      openingReaderRef.current = true;
      setNavigationError(false);
      try {
        await flushPending();
        setSelectedPaperId(paper.id);
        setRequestedWebChatId(webChatId);
        setReadingPaper(paper);
      } catch {
        setNavigationError(true);
      } finally {
        openingReaderRef.current = false;
      }
    },
    [flushPending],
  );

  return (
    <main className="app-shell">
      {readingPaper && <div inert={busy} style={{ display: "contents" }}>
        <PaperReader
          initialDiscussionOpen={requestedWebChatId !== null}
          discussion={
            <WebChatPanel
              paper={readingPaper}
              initialChatId={requestedWebChatId}
            />
          }
          paper={readingPaper}
          onPaperUpdated={paper => {
            setReadingPaper(paper);
            setExternalRevision(current => current + 1);
            publishPaperCatalogChange("external", [paper.id]);
          }}
          onBack={() => setReadingPaper(null)}
        />
      </div>}
      <div
        className="canvas-workspace"
        hidden={readingPaper !== null}
        inert={busy}
        style={{ display: readingPaper ? "none" : undefined }}
      >
          <PaperLibrary
            externalRevision={externalRevision}
            beforePaperDelete={() => flushPending()}
            beforeOrganizationChange={() => flushPending()}
            trackPersistenceOperation={trackOperation}
            selectedPaperId={selectedPaperId}
            onPaperSelect={(paper) => {
              setSelectedPaperId(paper.id);
              setSelectedBoardPapers([paper.id]);
              setPaperFocusRequest((current) => ({
                paperId: paper.id,
                revision: (current?.revision ?? 0) + 1,
              }));
            }}
            onOpenPaper={(paper) => void openReader(paper)}
            onPapersImported={(papers) => {
              if (papers[0]) setSelectedPaperId(papers[0].id);
              publishPaperCatalogChange(
                "imported",
                papers.map(({ id }) => id),
              );
            }}
            onPaperDeleted={(paper) => {
              setSelectedPaperId((current) =>
                current === paper.id ? null : current,
              );
              setPaperDropIntent((current) =>
                current?.paperId === paper.id ? null : current,
              );
              setPaperFocusRequest((current) =>
                current?.paperId === paper.id ? null : current,
              );
              publishPaperCatalogChange("deleted", [paper.id]);
            }}
            onPaperDrop={setPaperDropIntent}
            onOrganizationChanged={(paperIds) =>
              publishPaperCatalogChange("organized", [...paperIds])
            }
          />
          <Whiteboard
            active={readingPaper === null && !busy}
            onSelectedPapersChange={setSelectedBoardPapers}
            onSnapshotLoaded={onSnapshotLoaded}
            onSnapshotFailed={onSnapshotFailed}
            researchFocus={researchFocus}
            onOpenPaper={(paper) => void openReader(paper)}
            onPaperDropComplete={() => setPaperDropIntent(null)}
            paperCatalogChange={paperCatalogChange}
            paperDropIntent={paperDropIntent}
            paperFocusRequest={paperFocusRequest}
          />
          <RecentDiscussions
            active={readingPaper === null}
            catalogRevision={paperCatalogChange?.revision}
            onOpenDiscussion={async (chat) => {
              const paper = await paperRepository.getById(chat.paperId);
              if (!paper) throw new Error("Paper no longer exists.");
              await openReader(paper, chat.id);
            }}
          />
        </div>
      {!readingPaper && <ResearchImports revision={externalRevision} onUndo={undoResearchBatch} disabled={busy} />}
      {busy && <div className="research-operation-mask" role="status"><span>正在保存并更新研究画布…</span></div>}
      {navigationError && (
        <div className="workspace-error" role="alert">
          Could not save the canvas before opening the reader. Retry after local
          storage is available.
        </div>
      )}
      {externalUpdateError && (
        <div className="workspace-error" role="alert">
          工作区更新未能载入，当前未保存内容已保留。
          <button type="button" onClick={() => {
            if (window.confirm("重新载入会放弃当前未保存的画布和笔记修改。确定重新载入吗？")) window.location.reload();
          }}>重新载入</button>
        </div>
      )}
    </main>
  );
}

function App() {
  return (
    <PersistenceCoordinator>
      <PaperCanvasApp />
    </PersistenceCoordinator>
  );
}

export default App;
