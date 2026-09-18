import { useCallback, useRef, useState } from "react";
import { ChatPanel, RecentDiscussions } from "./features/ai";
import {
  PaperLibrary,
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

function PaperCanvasApp() {
  const { flushPending, trackOperation } = usePersistenceCoordinator();
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null);
  const [readingPaper, setReadingPaper] = useState<Paper | null>(null);
  const [activeDiscussionId, setActiveDiscussionId] = useState<string | null>(
    null,
  );
  const [paperDropIntent, setPaperDropIntent] =
    useState<PaperDropIntent | null>(null);
  const [paperCatalogChange, setPaperCatalogChange] =
    useState<PaperCatalogChange | null>(null);
  const [navigationError, setNavigationError] = useState(false);
  const openingReaderRef = useRef(false);

  const publishPaperCatalogChange = useCallback(
    (kind: PaperCatalogChange["kind"], paperIds: string[]) => {
      setPaperCatalogChange((current) => ({
        kind,
        paperIds,
        revision: (current?.revision ?? 0) + 1,
      }));
    },
    [],
  );

  const openReader = useCallback(
    async (paper: Paper) => {
      if (openingReaderRef.current) return;
      openingReaderRef.current = true;
      setNavigationError(false);
      try {
        await flushPending();
        setSelectedPaperId(paper.id);
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
      {readingPaper && (
        <PaperReader
          discussion={
            <ChatPanel
              currentPaper={readingPaper}
              embedded
              initialSessionId={activeDiscussionId}
              onActiveSessionChange={setActiveDiscussionId}
              paperCatalogChange={paperCatalogChange}
            />
          }
          paper={readingPaper}
          onBack={() => setReadingPaper(null)}
        />
      )}
      <div
        className="canvas-workspace"
        hidden={readingPaper !== null}
        style={{ display: readingPaper ? "none" : undefined }}
      >
          <PaperLibrary
            beforePaperDelete={() => flushPending()}
            beforeOrganizationChange={() => flushPending()}
            trackPersistenceOperation={trackOperation}
            selectedPaperId={selectedPaperId}
            onPaperSelect={(paper) => setSelectedPaperId(paper.id)}
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
              publishPaperCatalogChange("deleted", [paper.id]);
            }}
            onPaperDrop={setPaperDropIntent}
            onOrganizationChanged={(paperIds) =>
              publishPaperCatalogChange("organized", [...paperIds])
            }
          />
          <Whiteboard
            active={readingPaper === null}
            onOpenPaper={(paper) => void openReader(paper)}
            onPaperDropComplete={() => setPaperDropIntent(null)}
            paperCatalogChange={paperCatalogChange}
            paperDropIntent={paperDropIntent}
          />
          <RecentDiscussions />
        </div>
      {navigationError && (
        <div className="workspace-error" role="alert">
          Could not save the canvas before opening the reader. Retry after local
          storage is available.
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
