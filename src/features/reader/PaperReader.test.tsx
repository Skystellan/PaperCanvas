import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PersistenceCoordinator } from "../persistence";
import { PaperReader } from "./PaperReader";
import type { PdfJsAdapter } from "./PdfViewer";
import type { NoteRepository } from "./model/noteAutosaveController";
import type {
  PdfHighlight,
  PdfHighlightRepository,
} from "./model/pdfHighlight";

const mindMapHarness = vi.hoisted(() => ({
  props: null as null | {
    generateMindMap?: (request: {
      paperId: string;
      prompt: string;
      signal: AbortSignal;
    }) => Promise<unknown>;
    paperId: string;
  },
}));

vi.mock("../mindmap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mindmap")>();
  return {
    ...actual,
    PaperMindMap: (props: NonNullable<typeof mindMapHarness.props>) => {
      mindMapHarness.props = props;
      return <div>Paper mind map canvas</div>;
    },
  };
});

const paper = {
  authors: "Ada Lovelace",
  createdAt: 1_777_000_000_000,
  domainId: null,
  filePath: null,
  id: "paper-1",
  title: "Local-first notes",
  year: 2026,
};

function createHighlightRepository(
  highlights: PdfHighlight[] = [],
): PdfHighlightRepository {
  return {
    load: vi.fn().mockResolvedValue(highlights),
    remove: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function renderReader(
  repository: NoteRepository,
  onBack: () => void | Promise<void> = vi.fn(),
) {
  return render(
    <PersistenceCoordinator>
      <PaperReader
        highlightRepository={createHighlightRepository()}
        paper={paper}
        noteRepository={repository}
        onBack={onBack}
      />
    </PersistenceCoordinator>,
  );
}

describe("PaperReader", () => {
  beforeEach(() => {
    mindMapHarness.props = null;
  });

  it("loads and edits notes even when a legacy paper has no local PDF", async () => {
    const repository: NoteRepository = {
      load: vi.fn().mockResolvedValue("Initial thought"),
      save: vi.fn().mockResolvedValue(undefined),
    };
    renderReader(repository);

    expect(screen.getByLabelText("Reading Local-first notes").tagName).toBe(
      "SECTION",
    );
    const notes = await screen.findByRole("textbox", { name: "Paper notes" });
    expect(notes).toHaveValue("Initial thought");
    expect(screen.getByText("This legacy paper has no local PDF.")).toBeVisible();
    fireEvent.change(notes, { target: { value: "A new thought" } });
    expect(notes).toHaveValue("A new thought");
  });

  it("collapses and restores the reader sidebar without losing its draft", async () => {
    const repository: NoteRepository = {
      load: vi.fn().mockResolvedValue("Initial thought"),
      save: vi.fn().mockResolvedValue(undefined),
    };
    renderReader(repository);

    const notes = await screen.findByRole("textbox", { name: "Paper notes" });
    fireEvent.change(notes, { target: { value: "Keep this while hidden" } });

    fireEvent.click(
      screen.getByRole("button", { name: "Hide reader sidebar" }),
    );

    expect(
      screen.queryByLabelText("Notes, mind map, and highlights panel"),
    ).not.toBeVisible();
    expect(
      screen.queryByRole("separator", { name: "Resize reader sidebar" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Show reader sidebar" }),
    );

    expect(screen.getByRole("textbox", { name: "Paper notes" })).toHaveValue(
      "Keep this while hidden",
    );
    expect(
      screen.getByRole("separator", { name: "Resize reader sidebar" }),
    ).toBeVisible();
  });

  it("lets pointer and keyboard users change the reader sidebar share", async () => {
    const repository: NoteRepository = {
      load: vi.fn().mockResolvedValue(""),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const { container } = renderReader(repository);
    await screen.findByRole("textbox", { name: "Paper notes" });
    const workspace = container.querySelector<HTMLElement>(
      ".paper-reader__workspace",
    );
    if (!workspace) throw new Error("Reader workspace was not rendered");
    workspace.getBoundingClientRect = vi.fn(() => ({
      bottom: 700,
      height: 700,
      left: 0,
      right: 1_000,
      top: 0,
      width: 1_000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));
    const separator = screen.getByRole("separator", {
      name: "Resize reader sidebar",
    });

    expect(workspace).toHaveStyle("--paper-reader-sidebar-width: 34%");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(workspace).toHaveStyle("--paper-reader-sidebar-width: 36%");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(workspace).toHaveStyle("--paper-reader-sidebar-width: 34%");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(workspace).toHaveStyle("--paper-reader-sidebar-width: 24%");

    fireEvent.pointerDown(separator, { clientX: 760 });
    fireEvent.pointerMove(window, { clientX: 600 });
    expect(workspace).toHaveStyle("--paper-reader-sidebar-width: 40%");
    fireEvent.pointerUp(window);

    fireEvent.keyDown(separator, { key: "End" });
    expect(workspace).toHaveStyle("--paper-reader-sidebar-width: 60%");
  });

  it("places the full discussion surface in a peer tab beside Notes and Mind map", async () => {
    const repository: NoteRepository = {
      load: vi.fn().mockResolvedValue(""),
      save: vi.fn().mockResolvedValue(undefined),
    };

    render(
      <PersistenceCoordinator>
        <PaperReader
          discussion={<aside aria-label="AI discussion">Full discussion</aside>}
          highlightRepository={createHighlightRepository()}
          noteRepository={repository}
          onBack={vi.fn()}
          paper={paper}
        />
      </PersistenceCoordinator>,
    );

    expect(screen.getByRole("tab", { name: "AI chat" })).toBeVisible();
    expect(screen.getByLabelText("AI discussion")).not.toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "AI chat" }));

    expect(screen.getByLabelText("AI discussion")).toBeVisible();
    expect(screen.queryByText("Highlights")).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Notes, mind map, AI chat, and highlights panel"),
    ).toBeVisible();
    expect(screen.getByLabelText(`Reading ${paper.title}`).querySelector(
      ".paper-reader__workspace--with-discussion",
    )).toBeNull();
  });

  it("flushes the latest note before Back completes", async () => {
    const repository: NoteRepository = {
      load: vi.fn().mockResolvedValue(""),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const onBack = vi.fn();
    renderReader(repository, onBack);
    const notes = await screen.findByRole("textbox", { name: "Paper notes" });
    fireEvent.change(notes, { target: { value: "Save before leaving" } });

    fireEvent.click(screen.getByRole("button", { name: "Back to canvas" }));

    await waitFor(() =>
      expect(repository.save).toHaveBeenCalledWith(
        "paper-1",
        "Save before leaving",
      ),
    );
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("stays in the reader and offers Retry when Back cannot save", async () => {
    const repository: NoteRepository = {
      load: vi.fn().mockResolvedValue(""),
      save: vi
        .fn()
        .mockRejectedValueOnce(new Error("disk full"))
        .mockResolvedValueOnce(undefined),
    };
    const onBack = vi.fn();
    renderReader(repository, onBack);
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Paper notes" }),
      { target: { value: "Never lose this" } },
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to canvas" }));
    expect(
      await screen.findByText("Your local changes could not be saved before leaving."),
    ).toBeVisible();
    expect(onBack).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
    expect(repository.save).toHaveBeenLastCalledWith("paper-1", "Never lose this");
  });

  it("keeps a failed draft visible when a standalone save retry also fails", async () => {
    const repository: NoteRepository = {
      load: vi.fn().mockResolvedValue(""),
      save: vi.fn().mockRejectedValue(new Error("disk remains full")),
    };
    renderReader(repository);
    const notes = await screen.findByRole("textbox", { name: "Paper notes" });
    fireEvent.change(notes, { target: { value: "Keep this draft" } });

    const saveError = "Your note could not be saved. Retry when local storage is available.";
    expect(await screen.findByText(saveError)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));

    await waitFor(() => expect(repository.save).toHaveBeenCalledTimes(2));
    expect(notes).toHaveValue("Keep this draft");
    expect(screen.getByText(saveError)).toBeVisible();
  });

  it("surfaces note load failure and can retry it", async () => {
    const repository: NoteRepository = {
      load: vi
        .fn()
        .mockRejectedValueOnce(new Error("locked"))
        .mockResolvedValueOnce("Recovered note"),
      save: vi.fn().mockResolvedValue(undefined),
    };
    renderReader(repository);

    expect(await screen.findByText("Your note could not be loaded.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading note" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Paper notes" })).toHaveValue(
        "Recovered note",
      ),
    );
  });

  it("labels papers whose optional metadata is unavailable", async () => {
    const repository: NoteRepository = {
      load: vi.fn().mockResolvedValue(""),
      save: vi.fn().mockResolvedValue(undefined),
    };
    render(
      <PersistenceCoordinator>
        <PaperReader
          highlightRepository={createHighlightRepository()}
          noteRepository={repository}
          onBack={vi.fn()}
          paper={{ ...paper, authors: null, year: null }}
        />
      </PersistenceCoordinator>,
    );

    expect(screen.getByText("Metadata unavailable")).toBeVisible();
    expect(await screen.findByRole("textbox", { name: "Paper notes" })).toBeEnabled();
  });

  it("saves a selected passage as an independent highlight without changing paper notes", async () => {
    const repository: NoteRepository = {
      load: vi.fn().mockResolvedValue("Existing thought"),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const renderTextLayer = vi.fn(({ container }: { container: HTMLElement }) => {
      const text = document.createElement("span");
      text.textContent = "Key local-first result";
      container.append(text);
      return { cancel: vi.fn(), promise: Promise.resolve() };
    });
    const pdfJs: PdfJsAdapter = {
      getDocument: () => ({
        destroy: vi.fn(),
        promise: Promise.resolve({
          destroy: vi.fn(),
          getPage: vi.fn().mockResolvedValue({
            getViewport: () => ({ height: 800, width: 600 }),
            render: () => ({ cancel: vi.fn(), promise: Promise.resolve() }),
            renderTextLayer,
          }),
          numPages: 1,
        }),
      }),
    };
    const highlightRepository = createHighlightRepository();
    const researchService = {
      askSelection: vi.fn().mockResolvedValue("It supports the central claim."),
      generateMindMap: vi.fn(),
      translateSelection: vi.fn().mockResolvedValue("关键的本地优先结果"),
    };
    const canvas = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as never);
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("pdf-viewer__text-layer")) {
          return {
            bottom: 900,
            height: 800,
            left: 100,
            right: 600,
            top: 100,
            width: 500,
            x: 100,
            y: 100,
            toJSON: () => ({}),
          };
        }
        return {
          bottom: 0,
          height: 0,
          left: 0,
          right: 0,
          top: 0,
          width: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        };
      });
    vi.spyOn(window, "getSelection").mockReturnValue({
      getRangeAt: () => ({
        getBoundingClientRect: () => ({
          bottom: 140,
          height: 20,
          left: 100,
          right: 300,
          top: 120,
          width: 200,
          x: 100,
          y: 120,
        }),
      }),
      isCollapsed: false,
      rangeCount: 1,
      removeAllRanges: vi.fn(),
      toString: () => "Key local-first result",
    } as unknown as Selection);

    render(
      <PersistenceCoordinator>
        <PaperReader
          highlightRepository={highlightRepository}
          noteRepository={repository}
          onBack={vi.fn()}
          paper={{ ...paper, filePath: "papers/paper-1.pdf" }}
          pdfJs={pdfJs}
          readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
          researchService={researchService}
        />
      </PersistenceCoordinator>,
    );
    const notes = await screen.findByRole("textbox", { name: "Paper notes" });
    const textLayer = await screen.findByTestId("pdf-text-layer-1");

    fireEvent.mouseUp(textLayer);
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Note about selection" }),
      { target: { value: "This supports the main claim." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Translate" }));
    fireEvent.click(screen.getByRole("button", { name: "Translate selection" }));
    await waitFor(() =>
      expect(researchService.translateSelection).toHaveBeenCalledWith(
        expect.objectContaining({
          pageNumber: 1,
          text: "Key local-first result",
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText("关键的本地优先结果")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Question about selection" }),
      { target: { value: "Why does this matter?" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask Codex" }));
    await waitFor(() =>
      expect(researchService.askSelection).toHaveBeenCalledWith(
        expect.objectContaining({
          pageNumber: 1,
          text: "Key local-first result",
        }),
        "Why does this matter?",
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText("It supports the central claim.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Note" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Save note" }),
    );

    await waitFor(() =>
      expect(highlightRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          comment: "This supports the main claim.",
          id: expect.stringMatching(/^highlight-/),
          pageNumber: 1,
          paperId: "paper-1",
          rects: [{ height: 0.025, left: 0, top: 0.025, width: 0.4 }],
          text: "Key local-first result",
        }),
      ),
    );
    expect(notes).toHaveValue("Existing thought");
    expect(
      screen.getByRole("button", { name: "Go to highlight on page 1" }),
    ).toHaveTextContent("Key local-first result");
    canvas.mockRestore();
    bounds.mockRestore();
  });

  it("discloses complete-paper sharing and passes mind-map generation to the injected Codex service", async () => {
    const repository: NoteRepository = {
      load: vi.fn().mockResolvedValue(""),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const generatedTree = {
      nodes: [
        {
          details: "",
          id: "root",
          parentId: null,
          title: "Paper thesis",
          x: 0,
          y: 0,
        },
      ],
      revision: 1,
      schemaVersion: 1 as const,
      sourcePrompt: "Map the argument",
      updatedAt: 100,
    };
    const researchService = {
      askSelection: vi.fn(),
      generateMindMap: vi.fn().mockResolvedValue(generatedTree),
      translateSelection: vi.fn(),
    };
    render(
      <PersistenceCoordinator>
        <PaperReader
          highlightRepository={createHighlightRepository()}
          noteRepository={repository}
          onBack={vi.fn()}
          paper={paper}
          researchService={researchService}
        />
      </PersistenceCoordinator>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Mind map" }));

    expect(
      screen.getByText(/sends the complete extracted paper text to Codex/i),
    ).toBeVisible();
    expect(screen.getByText("Paper mind map canvas")).toBeVisible();
    expect(screen.queryByText("Highlights")).not.toBeInTheDocument();
    expect(mindMapHarness.props?.paperId).toBe("paper-1");

    const signal = new AbortController().signal;
    await mindMapHarness.props?.generateMindMap?.({
      paperId: "paper-1",
      prompt: "Map the argument",
      signal,
    });

    expect(researchService.generateMindMap).toHaveBeenCalledWith({
      paper,
      prompt: "Map the argument",
      signal,
    });
  });

  it("loads and deletes persisted highlights without touching the paper note", async () => {
    const repository: NoteRepository = {
      load: vi.fn().mockResolvedValue("Paper thought"),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const persisted: PdfHighlight = {
      comment: "A useful caveat",
      createdAt: 1,
      id: "highlight-1",
      pageNumber: 4,
      paperId: "paper-1",
      rects: [{ height: 0.03, left: 0.1, top: 0.2, width: 0.5 }],
      text: "A persisted passage",
      updatedAt: 1,
    };
    const highlightRepository = createHighlightRepository([persisted]);

    render(
      <PersistenceCoordinator>
        <PaperReader
          highlightRepository={highlightRepository}
          noteRepository={repository}
          onBack={vi.fn()}
          paper={paper}
        />
      </PersistenceCoordinator>,
    );

    expect(await screen.findByText(/A persisted passage/)).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete highlight from page 4" }),
    );
    await waitFor(() =>
      expect(highlightRepository.remove).toHaveBeenCalledWith(
        "paper-1",
        "highlight-1",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText(/A persisted passage/)).toBeNull(),
    );
    expect(screen.getByRole("textbox", { name: "Paper notes" })).toHaveValue(
      "Paper thought",
    );
  });

  it("retries a failed highlight mutation before leaving the reader", async () => {
    const noteRepository: NoteRepository = {
      load: vi.fn().mockResolvedValue(""),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const persisted: PdfHighlight = {
      comment: "Remove me",
      createdAt: 1,
      id: "highlight-retry",
      pageNumber: 3,
      paperId: "paper-1",
      rects: [{ height: 0.03, left: 0.1, top: 0.2, width: 0.5 }],
      text: "A stale highlight",
      updatedAt: 1,
    };
    const highlightRepository = createHighlightRepository([persisted]);
    vi.mocked(highlightRepository.remove)
      .mockRejectedValueOnce(new Error("database busy"))
      .mockResolvedValueOnce(undefined);
    const onBack = vi.fn();
    render(
      <PersistenceCoordinator>
        <PaperReader
          highlightRepository={highlightRepository}
          noteRepository={noteRepository}
          onBack={onBack}
          paper={paper}
        />
      </PersistenceCoordinator>,
    );

    await screen.findByText(/A stale highlight/);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete highlight from page 3" }),
    );
    expect(await screen.findByText("Your highlight could not be deleted.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Back to canvas" }));

    await waitFor(() => expect(highlightRepository.remove).toHaveBeenCalledTimes(2));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
