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
  PaperLibrary: ({
    beforePaperDelete,
    beforeOrganizationChange,
    onPaperDeleted,
    onPaperDrop,
    onPapersImported,
    onOrganizationChanged,
    onPaperSelect,
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
    selectedPaperId: string | null;
    trackPersistenceOperation?: <T>(operation: Promise<T>) => Promise<T>;
  }) => (
    <aside aria-label="Paper library">
      <button type="button" onClick={() => onPaperSelect(paper)}>
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
  }: {
    onOpenPaper: (paper: Paper) => void;
    onPaperDropComplete?: () => void;
    paperCatalogChange?: { kind: string; revision: number } | null;
    paperDropIntent?: { paperId: string } | null;
  }) => (
    <section aria-label="Paper canvas">
      <input aria-label="Canvas memory" defaultValue="" />
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
    onBack,
  }: {
    discussion?: ReactNode;
    paper: Paper;
    onBack: () => void;
  }) => (
    <section aria-label={`Reading ${activePaper.title}`}>
      <button type="button" onClick={onBack}>
        Back to canvas
      </button>
      {discussion}
    </section>
  ),
}));

vi.mock("./features/ai", () => ({
  ChatPanel: ({
    currentPaper,
    embedded,
    initialSessionId,
    onActiveSessionChange,
    paperCatalogChange,
  }: {
    currentPaper?: Paper | null;
    embedded?: boolean;
    initialSessionId?: string | null;
    onActiveSessionChange?: (sessionId: string) => void;
    paperCatalogChange?: { kind: string; revision: number } | null;
  }) => (
    <aside aria-label="AI discussion">
      Local Codex chat
      <output aria-label="Current discussion paper">
        {currentPaper?.id ?? "none"}
      </output>
      <output aria-label="Discussion layout">
        {embedded ? "embedded" : "rail"}
      </output>
      <output aria-label="Initial discussion">
        {initialSessionId ?? "none"}
      </output>
      <button
        onClick={() => onActiveSessionChange?.("session-older")}
        type="button"
      >
        Switch discussion
      </button>
      <output aria-label="AI catalog change">
        {paperCatalogChange
          ? `${paperCatalogChange.kind}:${paperCatalogChange.revision}`
          : "none"}
      </output>
    </aside>
  ),
  RecentDiscussions: () => (
    <aside aria-label="Recent discussions">Recent local discussions</aside>
  ),
}));

import App from "./App";

beforeEach(() => {
  persistence.flushPending.mockReset().mockResolvedValue(undefined);
  persistence.trackOperation
    .mockReset()
    .mockImplementation((operation: Promise<unknown>) => operation);
});

it("composes the local Library and canvas inside one persistence coordinator", () => {
  render(<App />);

  expect(screen.queryByText("PaperCanvas")).not.toBeInTheDocument();
  expect(screen.queryByText("Local data · Codex on demand")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Paper library")).toBeVisible();
  expect(screen.getByLabelText("Paper canvas")).toBeVisible();
  expect(screen.getByLabelText("Recent discussions")).toBeVisible();
  expect(screen.queryByLabelText("AI discussion")).not.toBeInTheDocument();
  expect(screen.getByTestId("persistence-coordinator")).toBeVisible();
});

it("tracks Library selection without navigating", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("button", { name: "Select imported paper" }));

  expect(screen.getByLabelText("Selected paper")).toHaveTextContent(
    "paper-imported",
  );
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
  expect(screen.getByLabelText("Discussion layout")).toHaveTextContent(
    "embedded",
  );
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

it("remembers the active discussion across Reader navigation", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.dblClick(
    screen.getByRole("button", { name: "Imported research paper" }),
  );
  expect(screen.getByLabelText("Initial discussion")).toHaveTextContent("none");
  await user.click(screen.getByRole("button", { name: "Switch discussion" }));
  await user.click(screen.getByRole("button", { name: "Back to canvas" }));
  await user.dblClick(
    screen.getByRole("button", { name: "Imported research paper" }),
  );

  expect(screen.getByLabelText("Initial discussion")).toHaveTextContent(
    "session-older",
  );
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
