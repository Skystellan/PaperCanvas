import { useCallback, useRef, useState } from "react";
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
      {readingPaper && (
        <PaperReader
          initialDiscussionOpen={requestedWebChatId !== null}
          discussion={
            <WebChatPanel
              paper={readingPaper}
              initialChatId={requestedWebChatId}
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
            onPaperSelect={(paper) => {
              setSelectedPaperId(paper.id);
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
            active={readingPaper === null}
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
