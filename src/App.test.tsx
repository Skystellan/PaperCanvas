import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Paper } from "./features/library";

const paper: Paper = {
  id: "paper-imported",
  title: "Imported research paper",
  authors: null,
  year: null,
  filePath: "papers/imported.pdf",
  createdAt: 1,
  domainId: null,
};

const catalog = vi.hoisted(() => ({ getById: vi.fn() }));

const persistence = vi.hoisted(() => ({
  flushPending: vi.fn(),
  trackOperation: vi.fn(),
}));

vi.mock("./features/persistence", () => ({
  PersistenceCoordinator: ({ children }: { children: ReactNode }) => (
    <div data-testid="persistence-coordinator">{children}</div>
  ),
  usePersistenceCoordinator: () => ({
    flushPending: persistence.flushPending,
    trackOperation: persistence.trackOperation,
  }),
}));

vi.mock("./features/library", () => ({
  SqlitePaperRepository: class { getById = catalog.getById; },
  PaperLibrary: ({
    beforePaperDelete,
    beforeOrganizationChange,
    onPaperDeleted,
    onPaperDrop,
    onPapersImported,
    onOrganizationChanged,
    onPaperSelect,
    onOpenPaper,
    selectedPaperId,
    trackPersistenceOperation,
  }: {
    beforePaperDelete?: (paper: Paper) => Promise<void> | void;
    beforeOrganizationChange?: () => Promise<void> | void;
    onPaperDeleted?: (paper: Paper) => void;
    onPaperDrop?: (drop: {
      paperId: string;
      clientX: number;
      clientY: number;
    }) => void;
    onPapersImported?: (papers: Paper[]) => void;
    onOrganizationChanged?: (paperIds: readonly string[]) => void;
    onPaperSelect: (paper: Paper) => void;
    onOpenPaper?: (paper: Paper) => void;
    selectedPaperId: string | null;
    trackPersistenceOperation?: <T>(operation: Promise<T>) => Promise<T>;
  }) => (
    <aside aria-label="Paper library">
      <button type="button" onClick={() => onPaperSelect(paper)} onDoubleClick={() => onOpenPaper?.(paper)}>
        Select imported paper
      </button>
      <output aria-label="Selected paper">{selectedPaperId ?? "none"}</output>
      <button
        type="button"
        onClick={() =>
          onPaperDrop?.({ paperId: paper.id, clientX: 320, clientY: 240 })
        }
      >
        Bridge imported paper drop
      </button>
      <button type="button" onClick={() => onPapersImported?.([paper])}>
        Report imported paper
      </button>
      <button
        type="button"
        onClick={() => {
          void Promise.resolve(beforeOrganizationChange?.()).then(() =>
            onOrganizationChanged?.([paper.id]),
          );
        }}
      >
        Report organization change
      </button>
      <button
        type="button"
        onClick={() => {
          void Promise.resolve(beforePaperDelete?.(paper)).then(() =>
            onPaperDeleted?.(paper),
          );
        }}
      >
        Report deleted paper
      </button>
      <button
        type="button"
        onClick={() =>
          void trackPersistenceOperation?.(Promise.resolve(undefined))
        }
      >
        Track library operation
      </button>
    </aside>
  ),
}));

vi.mock("./features/whiteboard/Whiteboard", () => ({
  Whiteboard: ({
    onOpenPaper,
    onPaperDropComplete,
    paperCatalogChange,
    paperDropIntent,
    paperFocusRequest,
  }: {
    onOpenPaper: (paper: Paper) => void;
    onPaperDropComplete?: () => void;
    paperCatalogChange?: { kind: string; revision: number } | null;
    paperDropIntent?: { paperId: string } | null;
    paperFocusRequest?: { paperId: string; revision: number } | null;
  }) => (
    <section aria-label="Paper canvas">
      <input aria-label="Canvas memory" defaultValue="" />
      <output aria-label="Focused canvas paper">{paperFocusRequest?.paperId ?? "none"}</output>
      <button type="button" onDoubleClick={() => onOpenPaper(paper)}>
        Imported research paper
      </button>
      <button type="button" onPointerUp={() => onPaperDropComplete?.()}>
        Drop paper on canvas
      </button>
      <output aria-label="Pending canvas paper">
        {paperDropIntent?.paperId ?? "none"}
      </output>
      <output aria-label="Canvas catalog change">
        {paperCatalogChange
          ? `${paperCatalogChange.kind}:${paperCatalogChange.revision}`
          : "none"}
      </output>
    </section>
  ),
}));

vi.mock("./features/reader", () => ({
  PaperReader: ({
    discussion,
    paper: activePaper,
    initialDiscussionOpen,
    onBack,
  }: {
    discussion?: ReactNode;
    initialDiscussionOpen?: boolean;
    paper: Paper;
    onBack: () => void;
  }) => (
    <section aria-label={`Reading ${activePaper.title}`} data-discussion-open={initialDiscussionOpen}>
      <button type="button" onClick={onBack}>
        Back to canvas
      </button>
      {discussion}
    </section>
  ),
}));

vi.mock("./features/ai", () => ({
  WebChatPanel: ({ paper: currentPaper, initialChatId }: { paper: Paper; initialChatId?: string | null }) => (
    <aside aria-label="AI discussion">
      <output aria-label="Current discussion paper">{currentPaper.id}</output>
      <output aria-label="Requested web discussion">{initialChatId ?? "none"}</output>
    </aside>
  ),
  RecentDiscussions: ({ onOpenDiscussion }: { onOpenDiscussion: (chat: { id: string; paperId: string }) => Promise<void> }) => (
    <aside aria-label="Recent discussions">Recent local discussions
      <button type="button" onClick={() => void onOpenDiscussion({ id: "web-chat-older", paperId: paper.id })}>Continue recent discussion</button>
    </aside>
  ),
}));

import App from "./App";

beforeEach(() => {
  catalog.getById.mockReset().mockResolvedValue(paper);
  persistence.flushPending.mockReset().mockResolvedValue(undefined);
  persistence.trackOperation
    .mockReset()
    .mockImplementation((operation: Promise<unknown>) => operation);
});

it("composes the local Library and canvas inside one persistence coordinator", () => {
  render(<App />);

  expect(screen.queryByText("PaperCanvas")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Paper library")).toBeVisible();
  expect(screen.getByLabelText("Paper canvas")).toBeVisible();
  expect(screen.getByLabelText("Recent discussions")).toBeVisible();
  expect(screen.queryByLabelText("AI discussion")).not.toBeInTheDocument();
  expect(screen.getByTestId("persistence-coordinator")).toBeVisible();
});

it("focuses the canvas from Library selection without navigating", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("button", { name: "Select imported paper" }));

  expect(screen.getByLabelText("Selected paper")).toHaveTextContent("paper-imported");
  expect(screen.getByLabelText("Focused canvas paper")).toHaveTextContent("paper-imported");
  expect(screen.getByLabelText("Paper canvas")).toBeVisible();
});

it("coordinates a bridged native Library drop with the canvas", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(
    screen.getByRole("button", { name: "Bridge imported paper drop" }),
  );

  expect(screen.getByLabelText("Pending canvas paper")).toHaveTextContent(
    "paper-imported",
  );

  await user.click(
    screen.getByRole("button", { name: "Drop paper on canvas" }),
  );
  expect(screen.getByLabelText("Pending canvas paper")).toHaveTextContent("none");
});

it("passes close-blocking operation tracking to the Library", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(
    screen.getByRole("button", { name: "Track library operation" }),
  );

  expect(persistence.trackOperation).toHaveBeenCalledOnce();
});

it("publishes imports and flushes pending work before publishing a deletion", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("button", { name: "Report imported paper" }));
  expect(screen.getByLabelText("Canvas catalog change")).toHaveTextContent(
    "imported:1",
  );

  await user.click(screen.getByRole("button", { name: "Select imported paper" }));
  await user.click(screen.getByRole("button", { name: "Report deleted paper" }));

  expect(persistence.flushPending).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("Selected paper")).toHaveTextContent("none");
  expect(screen.getByLabelText("Canvas catalog change")).toHaveTextContent(
    "deleted:2",
  );
});

it("flushes the shared layout before publishing an organization change", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(
    screen.getByRole("button", { name: "Report organization change" }),
  );

  expect(persistence.flushPending).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("Canvas catalog change")).toHaveTextContent(
    "organized:1",
  );
});

it("opens Reader only on card double-click and returns to the same workspace", async () => {
  const user = userEvent.setup();
  render(<App />);
  const card = screen.getByRole("button", { name: "Imported research paper" });

  await user.click(card);
  expect(screen.queryByLabelText("Reading Imported research paper")).not.toBeInTheDocument();
  await user.dblClick(card);

  expect(persistence.flushPending).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("Reading Imported research paper")).toBeVisible();
  expect(screen.getByLabelText("Paper library")).not.toBeVisible();
  expect(screen.getByLabelText("AI discussion")).toBeVisible();
  expect(screen.getByLabelText("Current discussion paper")).toHaveTextContent(
    paper.id,
  );
  expect(screen.getByLabelText("Recent discussions")).not.toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back to canvas" }));

  expect(screen.getByLabelText("Paper library")).toBeVisible();
  expect(screen.getByLabelText("Paper canvas")).toBeVisible();
  expect(screen.getByLabelText("Recent discussions")).toBeVisible();
  expect(screen.queryByLabelText("AI discussion")).not.toBeInTheDocument();
});

it("preserves the mounted canvas while visiting Reader", async () => {
  const user = userEvent.setup();
  render(<App />);
  const memory = screen.getByLabelText("Canvas memory");
  await user.type(memory, "kept");

  await user.dblClick(
    screen.getByRole("button", { name: "Imported research paper" }),
  );
  await user.click(screen.getByRole("button", { name: "Back to canvas" }));

  expect(screen.getByLabelText("Canvas memory")).toHaveValue("kept");
});

it("explicitly removes the mounted canvas workspace from layout while Reader is open", async () => {
  const user = userEvent.setup();
  render(<App />);
  const workspace = screen.getByLabelText("Paper canvas").parentElement!;

  await user.dblClick(
    screen.getByRole("button", { name: "Imported research paper" }),
  );

  expect(workspace.style.display).toBe("none");
});

it("keeps the canvas mounted when pre-reader persistence fails", async () => {
  const user = userEvent.setup();
  persistence.flushPending.mockRejectedValueOnce(new Error("disk full"));
  render(<App />);

  await user.dblClick(
    screen.getByRole("button", { name: "Imported research paper" }),
  );

  expect(screen.getByLabelText("Paper canvas")).toBeVisible();
  expect(screen.queryByLabelText("Reading Imported research paper")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not save the canvas before opening the reader",
  );
});


it("opens a recent web chat in its paper and resets that target on normal paper navigation", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: "Continue recent discussion" }));
  expect(catalog.getById).toHaveBeenCalledWith(paper.id);
  expect(screen.getByLabelText("Requested web discussion")).toHaveTextContent("web-chat-older");
  expect(screen.getByLabelText(`Reading ${paper.title}`)).toHaveAttribute("data-discussion-open", "true");
  await user.click(screen.getByRole("button", { name: "Back to canvas" }));
  await user.dblClick(screen.getByRole("button", { name: "Imported research paper" }));
  expect(screen.getByLabelText("Requested web discussion")).toHaveTextContent("none");
  expect(screen.getByLabelText(`Reading ${paper.title}`)).toHaveAttribute("data-discussion-open", "false");
});

it("opens a library paper directly after flushing pending work", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.dblClick(screen.getByRole("button", { name: "Select imported paper" }));
  expect(persistence.flushPending).toHaveBeenCalledOnce();
  expect(screen.getByLabelText(`Reading ${paper.title}`)).toBeVisible();
  expect(screen.getByLabelText("Paper canvas")).not.toBeVisible();
});
