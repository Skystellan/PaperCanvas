import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { BaseDirectory } from "@tauri-apps/plugin-fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PdfViewer,
  type PdfDocumentLike,
  type PdfJsAdapter,
  type PdfPageLike,
  type PdfSelectionActions,
} from "./PdfViewer";
import type {
  CreatePdfViewerRuntimeOptions,
  PdfViewerRuntime,
} from "./pdfViewerRuntime";
import type { PdfHighlight } from "./model/pdfHighlight";
import { MAX_SUPPORTED_PDF_PAGES } from "./model/pdfLimits";

let observedIntersectionOptions: Array<IntersectionObserverInit | undefined> = [];

function createPdf(pageCount = 2) {
  const renderTasks: Array<{ cancel: ReturnType<typeof vi.fn> }> = [];
  const textLayerTasks: Array<{ cancel: ReturnType<typeof vi.fn> }> = [];
  const page: PdfPageLike = {
    getTextContent: vi.fn().mockResolvedValue({ items: [] }),
    getViewport: vi.fn(({ scale }) => ({
      height: 800 * scale,
      width: 600 * scale,
    })),
    render: vi.fn(() => {
      const task = { cancel: vi.fn(), promise: Promise.resolve() };
      renderTasks.push(task);
      return task;
    }),
    renderTextLayer: vi.fn(({ container }) => {
      const text = globalThis.document.createElement("span");
      text.textContent = "Selectable PDF text";
      container.append(text);
      const task = { cancel: vi.fn(), promise: Promise.resolve() };
      textLayerTasks.push(task);
      return task;
    }),
  };
  const document: PdfDocumentLike = {
    destroy: vi.fn().mockResolvedValue(undefined),
    getPage: vi.fn().mockResolvedValue(page),
    numPages: pageCount,
  };
  const loadingTask = {
    destroy: vi.fn().mockResolvedValue(undefined),
    promise: Promise.resolve(document),
  };
  const adapter: PdfJsAdapter = {
    getDocument: vi.fn(() => loadingTask),
  };
  return {
    adapter,
    document,
    loadingTask,
    page,
    renderTasks,
    textLayerTasks,
  };
}

describe("PdfViewer", () => {
  beforeEach(() => {
    observedIntersectionOptions = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains("pdf-viewer__text-layer")) {
          return {
            bottom: 500,
            height: 400,
            left: 100,
            right: 500,
            top: 100,
            width: 400,
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
      },
    );
    Object.defineProperty(globalThis, "devicePixelRatio", {
      configurable: true,
      value: 2,
    });
    class ImmediateIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0.55];
      constructor(
        private readonly callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        observedIntersectionOptions.push(options);
      }
      disconnect() {}
      observe(target: Element) {
        this.callback(
          [{ isIntersecting: true, target } as IntersectionObserverEntry],
          this,
        );
      }
      takeRecords() {
        return [];
      }
      unobserve() {}
    }
    vi.stubGlobal("IntersectionObserver", ImmediateIntersectionObserver);
  });

  it("reads an app-owned PDF and renders every page at HiDPI", async () => {
    const pdf = createPdf(2);
    const readFile = vi.fn().mockResolvedValue(new Uint8Array([37, 80, 68, 70]));

    render(
      <PdfViewer
        filePath="papers/paper-1.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={readFile}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading PDF");
    await waitFor(() => expect(pdf.document.getPage).toHaveBeenCalledTimes(2));
    expect(readFile).toHaveBeenCalledWith("papers/paper-1.pdf", {
      baseDir: BaseDirectory.AppData,
    });
    expect(pdf.adapter.getDocument).toHaveBeenCalledWith({
      data: expect.any(Uint8Array),
    });
    // Every page is intersecting in this rendering test, so callback order does
    // not define which visible page wins. The total page count is the contract.
    expect(screen.getByText(/^[12] \/ 2$/)).toBeVisible();
    const canvases = screen.getAllByRole("img", { name: /PDF page/ });
    expect(canvases).toHaveLength(2);
    await waitFor(() => expect(canvases[0]).toHaveAttribute("width", "1200"));
    expect(canvases[0]).toHaveStyle({ height: "800px", width: "600px" });
    expect(observedIntersectionOptions).toContainEqual(
      expect.objectContaining({ threshold: 0.1 }),
    );
  });

  it("uses the official PDF.js runtime and bridges toolbar state and highlights", async () => {
    const pdf = createPdf(2);
    pdf.document.viewerDocument = {};
    const destroy = vi.fn();
    const setPage = vi.fn();
    const stepZoom = vi.fn();
    const zoomTo = vi.fn();
    const runtime: PdfViewerRuntime = {
      currentPage: 1,
      currentZoom: 1,
      destroy,
      pagesCount: 2,
      setPage,
      stepZoom,
      zoomTo,
    };
    let runtimeOptions: CreatePdfViewerRuntimeOptions | undefined;
    const viewerRuntimeFactory = vi.fn(
      async (options: CreatePdfViewerRuntimeOptions) => {
        runtimeOptions = options;
        const page = globalThis.document.createElement("div");
        page.className = "page";
        page.dataset.pageNumber = "2";
        const canvasWrapper = globalThis.document.createElement("div");
        canvasWrapper.className = "canvasWrapper";
        page.append(canvasWrapper);
        options.viewer.append(page);
        return runtime;
      },
    );
    const highlight: PdfHighlight = {
      comment: "Official viewer overlay",
      createdAt: 1,
      id: "official-highlight",
      pageNumber: 2,
      paperId: "paper-1",
      rects: [{ height: 0.05, left: 0.25, top: 0.4, width: 0.5 }],
      text: "Rendered by the official viewer",
      updatedAt: 1,
    };
    const { unmount } = render(
      <PdfViewer
        filePath="papers/official.pdf"
        focusedHighlightId={highlight.id}
        highlights={[highlight]}
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
        viewerRuntimeFactory={viewerRuntimeFactory}
      />,
    );

    await waitFor(() => expect(viewerRuntimeFactory).toHaveBeenCalledOnce());
    expect(pdf.document.getPage).not.toHaveBeenCalled();
    expect(screen.getByLabelText("PDF pages")).toHaveClass(
      "pdf-viewer__pages--official",
    );
    const marker = await screen.findByTestId(
      "pdf-persisted-highlight-official-highlight",
    );
    expect(marker).toHaveClass("is-focused");
    expect(marker).toHaveStyle({
      height: "5%",
      left: "25%",
      top: "40%",
      width: "50%",
    });
    expect(setPage).toHaveBeenCalledWith(2);

    setPage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(setPage).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(stepZoom).toHaveBeenCalledWith(1);
    expect(zoomTo).not.toHaveBeenCalled();

    act(() => {
      runtimeOptions?.onPageChange?.(2);
      runtimeOptions?.onScaleChange?.(1.25);
    });
    expect(screen.getByText("2 / 2")).toBeVisible();
    expect(screen.getByText("125%")).toBeVisible();

    unmount();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("bridges official PDF.js text-layer selections to the existing tools", async () => {
    const pdf = createPdf(1);
    pdf.document.viewerDocument = {};
    let selectedText: Text | undefined;
    const runtime: PdfViewerRuntime = {
      currentPage: 1,
      currentZoom: 1,
      destroy: vi.fn(),
      pagesCount: 1,
      setPage: vi.fn(),
      stepZoom: vi.fn(),
      zoomTo: vi.fn(),
    };
    const viewerRuntimeFactory = vi.fn(
      async ({ viewer }: CreatePdfViewerRuntimeOptions) => {
        const page = globalThis.document.createElement("div");
        page.className = "page";
        page.dataset.pageNumber = "1";
        const canvasWrapper = globalThis.document.createElement("div");
        canvasWrapper.className = "canvasWrapper";
        canvasWrapper.getBoundingClientRect = vi.fn(() =>
          DOMRect.fromRect({ height: 400, width: 400, x: 100, y: 100 }),
        );
        const textLayer = globalThis.document.createElement("div");
        textLayer.className = "textLayer";
        selectedText = globalThis.document.createTextNode("Official selection");
        textLayer.append(selectedText);
        page.append(canvasWrapper, textLayer);
        viewer.append(page);
        return runtime;
      },
    );
    const removeAllRanges = vi.fn();
    vi.spyOn(window, "getSelection").mockImplementation(
      () =>
        ({
          getRangeAt: () => ({
            endContainer: selectedText,
            getBoundingClientRect: () =>
              DOMRect.fromRect({ height: 20, width: 200, x: 120, y: 120 }),
            getClientRects: () => [
              DOMRect.fromRect({ height: 20, width: 200, x: 120, y: 120 }),
            ],
            startContainer: selectedText,
          }),
          isCollapsed: false,
          rangeCount: 1,
          removeAllRanges,
          toString: () => "Official selection",
        }) as unknown as Selection,
    );

    render(
      <PdfViewer
        filePath="papers/official-selection.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
        selectionActions={{ saveNote: vi.fn() }}
        viewerRuntimeFactory={viewerRuntimeFactory}
      />,
    );
    const pages = await screen.findByLabelText("PDF pages");
    await waitFor(() => expect(selectedText).toBeDefined());
    fireEvent.mouseUp(pages);

    const dialog = await screen.findByRole("dialog", {
      name: "PDF selection tools",
    });
    expect(dialog).toBeVisible();
    expect(dialog).toHaveTextContent("Official selection");
  });

  it("refuses a hostile PDF page count before allocating page wrappers", async () => {
    const pdf = createPdf(MAX_SUPPORTED_PDF_PAGES + 1);

    render(
      <PdfViewer
        filePath="papers/hostile.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The local PDF could not be opened.",
    );
    expect(screen.queryByTestId("pdf-page")).not.toBeInTheDocument();
    expect(pdf.document.getPage).not.toHaveBeenCalled();
  });

  it("opens an anchored selection card and saves a contextual note", async () => {
    const pdf = createPdf(1);
    const saveNote = vi.fn();
    const selectionActions: PdfSelectionActions = { saveNote };
    const removeAllRanges = vi.fn();
    vi.spyOn(window, "getSelection").mockReturnValue({
      getRangeAt: () => ({
        getBoundingClientRect: () => ({
          bottom: 132,
          height: 24,
          left: 120,
          right: 400,
          top: 108,
          width: 280,
          x: 120,
          y: 108,
        }),
      }),
      isCollapsed: false,
      rangeCount: 1,
      removeAllRanges,
      toString: () => "  A selected\nresearch finding  ",
    } as unknown as Selection);

    render(
      <PdfViewer
        filePath="papers/selectable.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
        selectionActions={selectionActions}
      />,
    );

    const textLayer = await screen.findByTestId("pdf-text-layer-1");
    await waitFor(() =>
      expect(textLayer).toHaveTextContent("Selectable PDF text"),
    );
    fireEvent.mouseUp(textLayer);

    const card = await screen.findByRole("dialog", {
      name: "PDF selection tools",
    });
    expect(card).toHaveStyle({ left: "260px", top: "144px" });
    expect(screen.getByTestId("pdf-selection-highlight")).toHaveStyle({
      height: "24px",
      left: "120px",
      top: "108px",
      width: "280px",
    });
    expect(screen.getByRole("button", { name: "Note" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Translate (coming soon)" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ask AI (coming soon)" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Note about selection" }), {
      target: { value: "Compare this with the prior result." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save note" }),
    );

    await waitFor(() =>
      expect(saveNote).toHaveBeenCalledWith({
        comment: "Compare this with the prior result.",
        selection: {
          anchor: { x: 260, y: 132 },
          pageNumber: 1,
          rects: [{ height: 0.06, left: 0.05, top: 0.02, width: 0.7 }],
          text: "A selected research finding",
        },
      }),
    );
    expect(screen.queryByRole("dialog", { name: "PDF selection tools" })).toBeNull();
    expect(removeAllRanges).toHaveBeenCalledOnce();
  });

  it("renders persisted page-relative highlights and focuses one from the sidebar", async () => {
    const pdf = createPdf(2);
    const readPdfFile = vi.fn().mockResolvedValue(new Uint8Array([1]));
    const persisted: PdfHighlight = {
      comment: "A saved note",
      createdAt: 1,
      id: "highlight-page-2",
      pageNumber: 2,
      paperId: "paper-1",
      rects: [{ height: 0.05, left: 0.25, top: 0.4, width: 0.5 }],
      text: "Persisted across zoom levels",
      updatedAt: 1,
    };
    const { rerender } = render(
      <PdfViewer
        filePath="papers/highlights.pdf"
        highlights={[persisted]}
        pdfJs={pdf.adapter}
        readPdfFile={readPdfFile}
      />,
    );
    await waitFor(() => expect(pdf.document.getPage).toHaveBeenCalledTimes(2));
    const savedOverlay = screen.getByTestId("pdf-persisted-highlight-highlight-page-2");
    expect(savedOverlay).toHaveStyle({
      height: "5%",
      left: "25%",
      top: "40%",
      width: "50%",
    });

    const scrollIntoView = vi.fn();
    for (const page of screen.getAllByTestId("pdf-page")) {
      page.scrollIntoView = scrollIntoView;
    }
    rerender(
      <PdfViewer
        filePath="papers/highlights.pdf"
        focusedHighlightId={persisted.id}
        highlights={[persisted]}
        pdfJs={pdf.adapter}
        readPdfFile={readPdfFile}
      />,
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(savedOverlay).toHaveClass("is-focused");
    expect(screen.getByText("2 / 2")).toBeVisible();
  });

  it("rejects a text selection spanning more than one PDF page", async () => {
    const pdf = createPdf(2);
    render(
      <PdfViewer
        filePath="papers/cross-page.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
        selectionActions={{ saveNote: vi.fn() }}
      />,
    );
    const firstLayer = await screen.findByTestId("pdf-text-layer-1");
    const secondLayer = await screen.findByTestId("pdf-text-layer-2");
    await waitFor(() => expect(firstLayer.firstChild).not.toBeNull());
    const firstText = firstLayer.firstChild?.firstChild;
    const secondText = secondLayer.firstChild?.firstChild;
    vi.spyOn(window, "getSelection").mockReturnValue({
      getRangeAt: () => ({
        endContainer: secondText,
        getBoundingClientRect: () => ({
          bottom: 150,
          height: 20,
          left: 120,
          right: 300,
          top: 130,
          width: 180,
        }),
        startContainer: firstText,
      }),
      isCollapsed: false,
      rangeCount: 1,
      removeAllRanges: vi.fn(),
      toString: () => "Text spanning two pages",
    } as unknown as Selection);

    fireEvent.mouseUp(secondLayer);

    expect(screen.queryByRole("dialog", { name: "PDF selection tools" })).toBeNull();
  });

  it("shows Translate and Ask AI results inside the PaperCanvas selection card", async () => {
    const pdf = createPdf(1);
    const translate = vi.fn().mockResolvedValue("可组合的选区操作");
    const askAi = vi.fn().mockResolvedValue("This passage describes a composable action.");
    vi.spyOn(window, "getSelection").mockReturnValue({
      getRangeAt: () => ({
        getBoundingClientRect: () => ({
          bottom: 160,
          height: 20,
          left: 120,
          right: 260,
          top: 140,
          width: 140,
          x: 120,
          y: 140,
        }),
      }),
      isCollapsed: false,
      rangeCount: 1,
      removeAllRanges: vi.fn(),
      toString: () => "Composable selection action",
    } as unknown as Selection);

    render(
      <PdfViewer
        filePath="papers/future-actions.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
        selectionActions={{ askAi, saveNote: vi.fn(), translate }}
      />,
    );

    const textLayer = await screen.findByTestId("pdf-text-layer-1");
    await waitFor(() => expect(textLayer).toHaveTextContent("Selectable PDF text"));
    fireEvent.mouseUp(textLayer);
    fireEvent.click(screen.getByRole("button", { name: "Translate" }));
    fireEvent.click(screen.getByRole("button", { name: "Translate selection" }));
    await waitFor(() =>
      expect(translate).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Composable selection action" }),
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText("可组合的选区操作")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Question about selection" }), {
      target: { value: "Why does this matter?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask Codex" }));
    await waitFor(() =>
      expect(askAi).toHaveBeenCalledWith(
        expect.objectContaining({
          question: "Why does this matter?",
          selection: expect.objectContaining({ text: "Composable selection action" }),
        }),
      ),
    );
    expect(
      await screen.findByText("This passage describes a composable action."),
    ).toBeInTheDocument();
  });

  it("keeps the inline note and selection available when saving fails", async () => {
    const pdf = createPdf(1);
    const saveNote = vi
      .fn()
      .mockRejectedValueOnce(new Error("local database busy"))
      .mockResolvedValueOnce(undefined);
    vi.spyOn(window, "getSelection").mockReturnValue({
      getRangeAt: () => ({
        getBoundingClientRect: () => ({
          bottom: 120,
          height: 20,
          left: 100,
          right: 300,
          top: 100,
          width: 200,
          x: 100,
          y: 100,
        }),
      }),
      isCollapsed: false,
      rangeCount: 1,
      removeAllRanges: vi.fn(),
      toString: () => "Do not lose this annotation",
    } as unknown as Selection);

    render(
      <PdfViewer
        filePath="papers/retry-note.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
        selectionActions={{ saveNote }}
      />,
    );

    const textLayer = await screen.findByTestId("pdf-text-layer-1");
    await waitFor(() => expect(textLayer).toHaveTextContent("Selectable PDF text"));
    fireEvent.mouseUp(textLayer);
    const comment = await screen.findByRole("textbox", {
      name: "Note about selection",
    });
    fireEvent.change(comment, { target: { value: "Retained draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your selection is still here",
    );
    expect(comment).toHaveValue("Retained draft");
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "PDF selection tools" })).toBeNull(),
    );
    expect(saveNote).toHaveBeenCalledTimes(2);
  });

  it("renders only pages near the viewport", async () => {
    class NearbyPageObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin: string;
      readonly thresholds: readonly number[];

      constructor(
        private readonly callback: IntersectionObserverCallback,
        private readonly options: IntersectionObserverInit = {},
      ) {
        this.rootMargin = options.rootMargin ?? "0px";
        this.thresholds = Array.isArray(options.threshold)
          ? options.threshold
          : [options.threshold ?? 0];
      }

      disconnect() {}
      observe(target: Element) {
        const pageNumber = Number((target as HTMLElement).dataset.pageNumber);
        const isRenderObserver = this.options.rootMargin !== undefined;
        const isIntersecting = !isRenderObserver || pageNumber === 1;
        this.callback(
          [{ isIntersecting, target } as IntersectionObserverEntry],
          this,
        );
      }
      takeRecords() {
        return [];
      }
      unobserve() {}
    }
    vi.stubGlobal("IntersectionObserver", NearbyPageObserver);
    const pdf = createPdf(3);

    render(
      <PdfViewer
        filePath="papers/long-paper.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );

    await waitFor(() => expect(pdf.document.getPage).toHaveBeenCalledTimes(1));
    expect(pdf.document.getPage).toHaveBeenCalledWith(1);
    await waitFor(() => expect(pdf.page.render).toHaveBeenCalledTimes(1));
    expect(pdf.page.render).toHaveBeenCalledTimes(1);
  });

  it("renders without a scale transform on a standard-density display", async () => {
    Object.defineProperty(globalThis, "devicePixelRatio", {
      configurable: true,
      value: 1,
    });
    const pdf = createPdf(1);
    render(
      <PdfViewer
        filePath="papers/standard-density.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );

    await waitFor(() => expect(pdf.page.render).toHaveBeenCalledOnce());
    expect(pdf.page.render).toHaveBeenCalledWith(
      expect.objectContaining({ transform: undefined }),
    );
  });

  it("shows a page-level error when PDF.js throws synchronously", async () => {
    const pdf = createPdf(1);
    vi.mocked(pdf.page.render).mockImplementationOnce(() => {
      throw new Error("invalid page graphics");
    });

    render(
      <PdfViewer
        filePath="papers/broken-page.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Page 1 could not be rendered",
    );
  });

  it("refuses an oversized output canvas before allocating it", async () => {
    const pdf = createPdf(1);
    pdf.page.getViewport = vi.fn(() => ({
      height: 100_000,
      width: 100_000,
    }));

    render(
      <PdfViewer
        filePath="papers/oversized-page.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Page 1 could not be rendered",
    );
    expect(screen.getByRole("img", { name: "PDF page 1" })).toHaveAttribute(
      "width",
      "0",
    );
    expect(pdf.page.render).not.toHaveBeenCalled();
  });

  it("navigates pages and keeps zoom within bounds", async () => {
    const pdf = createPdf(3);
    render(
      <PdfViewer
        filePath="papers/paper.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );
    await screen.findByText("3 / 3");
    const scrollIntoView = vi.fn();
    for (const page of screen.getAllByTestId("pdf-page")) {
      page.scrollIntoView = scrollIntoView;
    }

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(scrollIntoView).toHaveBeenCalled();

    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    for (let index = 0; index < 80; index += 1) fireEvent.click(zoomOut);
    expect(screen.getByText("10%")).toBeVisible();
    expect(zoomOut).toBeDisabled();

    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    for (let index = 0; index < 120; index += 1) fireEvent.click(zoomIn);
    expect(screen.getByText("1000%")).toBeVisible();
    expect(zoomIn).toBeDisabled();
  });

  it("zooms with a trackpad pinch while leaving ordinary two-finger scrolling alone", async () => {
    const pdf = createPdf(1);
    render(
      <PdfViewer
        filePath="papers/pinch.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );
    await screen.findByText("1 / 1");
    const pages = screen.getByLabelText("PDF pages");

    const scrollEvent = createEvent.wheel(pages, {
      bubbles: true,
      cancelable: true,
      ctrlKey: false,
      deltaY: 40,
    });
    fireEvent(pages, scrollEvent);
    expect(scrollEvent.defaultPrevented).toBe(false);
    expect(screen.getByText("100%")).toBeVisible();

    const pinchEvent = createEvent.wheel(pages, {
      bubbles: true,
      cancelable: true,
      clientX: 320,
      clientY: 280,
      ctrlKey: true,
      deltaY: -24,
    });
    fireEvent(pages, pinchEvent);

    expect(pinchEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.queryByText("100%")).toBeNull());
    expect(
      vi.mocked(pdf.page.getViewport).mock.calls.some(
        ([options]) => options.scale > 1,
      ),
    ).toBe(false);
    await waitFor(() =>
      expect(
        vi.mocked(pdf.page.getViewport).mock.calls.some(
          ([options]) => options.scale > 1,
        ),
      ).toBe(true),
    );
  });

  it("handles WebKit gesture pinches and waits until the gesture ends to rerender the PDF", async () => {
    const pdf = createPdf(1);
    render(
      <PdfViewer
        filePath="papers/webkit-pinch.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );
    await waitFor(() => expect(pdf.page.render).toHaveBeenCalled());
    const renderCountBeforePinch = vi.mocked(pdf.page.render).mock.calls.length;
    const pages = screen.getByLabelText("PDF pages");

    const start = new Event("gesturestart", { bubbles: true, cancelable: true });
    Object.assign(start, { clientX: 300, clientY: 240, scale: 1 });
    fireEvent(pages, start);

    const change = new Event("gesturechange", { bubbles: true, cancelable: true });
    Object.assign(change, { clientX: 300, clientY: 240, scale: 1.25 });
    fireEvent(pages, change);

    expect(start.defaultPrevented).toBe(true);
    expect(change.defaultPrevented).toBe(true);
    expect(screen.getByText("125%")).toBeVisible();
    expect(pdf.page.render).toHaveBeenCalledTimes(renderCountBeforePinch);

    const end = new Event("gestureend", { bubbles: true, cancelable: true });
    Object.assign(end, { clientX: 300, clientY: 240, scale: 1.25 });
    fireEvent(pages, end);

    await waitFor(() =>
      expect(vi.mocked(pdf.page.render).mock.calls.length).toBeGreaterThan(
        renderCountBeforePinch,
      ),
    );
  });

  it("does not double-apply ctrl-wheel events emitted with a WebKit gesture", async () => {
    const pdf = createPdf(1);
    render(
      <PdfViewer
        filePath="papers/single-input-stream.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );
    await screen.findByText("1 / 1");
    const pages = screen.getByLabelText("PDF pages");

    const start = new Event("gesturestart", { bubbles: true, cancelable: true });
    Object.assign(start, { clientX: 300, clientY: 240, scale: 1 });
    fireEvent(pages, start);
    const change = new Event("gesturechange", { bubbles: true, cancelable: true });
    Object.assign(change, { clientX: 300, clientY: 240, scale: 1.2 });
    fireEvent(pages, change);
    fireEvent.wheel(pages, {
      clientX: 300,
      clientY: 240,
      ctrlKey: true,
      deltaY: -100,
    });

    expect(screen.getByText("120%")).toBeVisible();

    const end = new Event("gestureend", { bubbles: true, cancelable: true });
    Object.assign(end, { clientX: 300, clientY: 240, scale: 1.2 });
    fireEvent(pages, end);
    fireEvent.wheel(pages, {
      clientX: 300,
      clientY: 240,
      ctrlKey: true,
      deltaY: -100,
    });

    expect(screen.getByText("120%")).toBeVisible();
  });

  it("keeps a wheel-first pinch stream when duplicate WebKit events follow", async () => {
    const pdf = createPdf(1);
    render(
      <PdfViewer
        filePath="papers/wheel-first-stream.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );
    await screen.findByText("1 / 1");
    const pages = screen.getByLabelText("PDF pages");

    fireEvent.wheel(pages, {
      clientX: 300,
      clientY: 240,
      ctrlKey: true,
      deltaY: -10,
    });
    expect(screen.getByText("111%")).toBeVisible();

    const start = new Event("gesturestart", { bubbles: true, cancelable: true });
    Object.assign(start, { clientX: 300, clientY: 240, scale: 1 });
    fireEvent(pages, start);
    const change = new Event("gesturechange", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(change, { clientX: 300, clientY: 240, scale: 1.2 });
    fireEvent(pages, change);

    expect(screen.getByText("111%")).toBeVisible();
  });

  it("clears a WebKit preview when the gesture is cancelled", async () => {
    const pdf = createPdf(1);
    render(
      <PdfViewer
        filePath="papers/cancelled-pinch.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );
    await screen.findByText("1 / 1");
    const pages = screen.getByLabelText("PDF pages");
    const page = screen.getByTestId("pdf-page");
    page.getBoundingClientRect = vi.fn(() =>
      DOMRect.fromRect({ height: 800, width: 600, x: 100, y: 80 }),
    );
    const pendingFrames: FrameRequestCallback[] = [];
    let frameId = 0;
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        pendingFrames.push(callback);
        frameId += 1;
        return frameId;
      });

    try {
      const start = new Event("gesturestart", {
        bubbles: true,
        cancelable: true,
      });
      Object.assign(start, { clientX: 300, clientY: 240, scale: 1 });
      fireEvent(pages, start);
      const change = new Event("gesturechange", {
        bubbles: true,
        cancelable: true,
      });
      Object.assign(change, { clientX: 300, clientY: 240, scale: 1.2 });
      fireEvent(pages, change);
      act(() => {
        for (const callback of pendingFrames.splice(0)) callback(0);
      });
      expect(page.style.transform).toContain("scale(1.2)");

      fireEvent(pages, new Event("gesturecancel", { bubbles: true }));

      expect(screen.getByText("100%")).toBeVisible();
      expect(page.style.transform).toBe("");
      expect(page).not.toHaveClass("is-zoom-preview");
    } finally {
      requestFrame.mockRestore();
    }
  });

  it("previews a pinch on bounded page layers without relaying out every page", async () => {
    const pdf = createPdf(2);
    render(
      <PdfViewer
        filePath="papers/compositor-pinch.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );
    await screen.findByText(/^[12] \/ 2$/);
    await waitFor(() => expect(pdf.page.render).toHaveBeenCalledTimes(2));
    const pages = screen.getByLabelText("PDF pages");
    const pageElements = screen.getAllByTestId("pdf-page");
    const content = pages.querySelector<HTMLElement>(
      ".pdf-viewer__pages-content",
    );
    expect(content).not.toBeNull();
    Object.defineProperties(pages, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 800 },
      scrollLeft: { configurable: true, value: 0, writable: true },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    pages.getBoundingClientRect = vi.fn(() =>
      DOMRect.fromRect({ height: 600, width: 800, x: 0, y: 0 }),
    );
    content!.getBoundingClientRect = vi.fn(() =>
      DOMRect.fromRect({ height: 1648, width: 800, x: 0, y: 0 }),
    );
    pageElements.forEach((page, index) => {
      page.getBoundingClientRect = vi.fn(() =>
        DOMRect.fromRect({
          height: Number.parseFloat(page.style.height),
          width: Number.parseFloat(page.style.width),
          x: 100,
          y: index * 824,
        }),
      );
    });
    const widthsBeforePinch = pageElements.map((page) => page.style.width);
    const renderCountBeforePinch = vi.mocked(pdf.page.render).mock.calls.length;

    const start = new Event("gesturestart", { bubbles: true, cancelable: true });
    Object.assign(start, { clientX: 300, clientY: 240, scale: 1 });
    fireEvent(pages, start);
    const change = new Event("gesturechange", { bubbles: true, cancelable: true });
    Object.assign(change, { clientX: 300, clientY: 240, scale: 1.25 });
    fireEvent(pages, change);

    expect(pageElements.map((page) => page.style.width)).toEqual(
      widthsBeforePinch,
    );
    await waitFor(() =>
      expect(pageElements[0]?.style.transform).toContain("scale(1.25)"),
    );
    expect(pageElements[1]?.style.transform).toContain("scale(1.25)");
    expect(content?.style.transform).toBe("");
    expect(screen.getByText("125%")).toBeVisible();
    expect(pdf.page.render).toHaveBeenCalledTimes(renderCountBeforePinch);

    const end = new Event("gestureend", { bubbles: true, cancelable: true });
    Object.assign(end, { clientX: 300, clientY: 240, scale: 1.25 });
    fireEvent(pages, end);

    await waitFor(() => expect(pageElements[0]).toHaveStyle({ width: "750px" }));
    expect(pageElements[0]?.style.transform).toBe("");
    expect(pageElements[1]?.style.transform).toBe("");
  });

  it("captures a pinch anchor without measuring every page in a long PDF", async () => {
    const pdf = createPdf(50);
    render(
      <PdfViewer
        filePath="papers/long-pinch.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );
    await screen.findByText(/^[0-9]+ \/ 50$/);
    const pages = screen.getByLabelText("PDF pages");
    const pageBounds = screen.getAllByTestId("pdf-page").map((page, index) => {
      const getBounds = vi.fn(() =>
        DOMRect.fromRect({ height: 800, width: 600, x: 100, y: index * 824 }),
      );
      page.getBoundingClientRect = getBounds;
      return getBounds;
    });

    const start = new Event("gesturestart", { bubbles: true, cancelable: true });
    Object.assign(start, { clientX: 300, clientY: 240, scale: 1 });
    fireEvent(pages, start);

    expect(
      pageBounds.reduce((total, getBounds) => total + getBounds.mock.calls.length, 0),
    ).toBeLessThanOrEqual(18);
    const previewPages = pages.querySelectorAll(
      ".pdf-viewer__page.is-zoom-preview",
    );
    expect(previewPages.length).toBeGreaterThan(0);
    expect(previewPages.length).toBeLessThanOrEqual(18);
  });

  it("keeps the touched page point anchored when a pinch preview is committed", async () => {
    const pdf = createPdf(1);
    render(
      <PdfViewer
        filePath="papers/page-anchor.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );
    await screen.findByText("1 / 1");
    const pages = screen.getByLabelText("PDF pages");
    const page = screen.getByTestId("pdf-page");
    const content = pages.querySelector<HTMLElement>(
      ".pdf-viewer__pages-content",
    );
    expect(content).not.toBeNull();
    Object.defineProperties(pages, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 800 },
      scrollLeft: { configurable: true, value: 120, writable: true },
      scrollTop: { configurable: true, value: 360, writable: true },
    });
    pages.getBoundingClientRect = vi.fn(() =>
      DOMRect.fromRect({ height: 600, width: 800, x: 40, y: 60 }),
    );
    content!.getBoundingClientRect = vi.fn(() =>
      DOMRect.fromRect({
        height: Number.parseFloat(page.style.height) + 48,
        width: Math.max(800, Number.parseFloat(page.style.width) + 48),
        x: 40 - pages.scrollLeft,
        y: 60 - pages.scrollTop,
      }),
    );
    page.getBoundingClientRect = vi.fn(() =>
      DOMRect.fromRect({
        height: Number.parseFloat(page.style.height),
        width: Number.parseFloat(page.style.width),
        x: 64 - pages.scrollLeft,
        y: 84 - pages.scrollTop,
      }),
    );
    const clientX = 344;
    const clientY = 124;
    const initialRect = page.getBoundingClientRect();
    const normalizedX = (clientX - initialRect.left) / initialRect.width;
    const normalizedY = (clientY - initialRect.top) / initialRect.height;

    const start = new Event("gesturestart", { bubbles: true, cancelable: true });
    Object.assign(start, { clientX, clientY, scale: 1 });
    fireEvent(pages, start);
    const change = new Event("gesturechange", { bubbles: true, cancelable: true });
    Object.assign(change, { clientX, clientY, scale: 1.5 });
    fireEvent(pages, change);
    const end = new Event("gestureend", { bubbles: true, cancelable: true });
    Object.assign(end, { clientX, clientY, scale: 1.5 });
    fireEvent(pages, end);

    await waitFor(() => expect(page).toHaveStyle({ width: "900px" }));
    const committedRect = page.getBoundingClientRect();
    expect(committedRect.left + committedRect.width * normalizedX).toBeCloseTo(
      clientX,
    );
    expect(committedRect.top + committedRect.height * normalizedY).toBeCloseTo(
      clientY,
    );
  });

  it("locks the WebKit pinch focal point against noisy center coordinates", async () => {
    const pdf = createPdf(1);
    render(
      <PdfViewer
        filePath="papers/moving-center.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );
    await screen.findByText("1 / 1");
    const pages = screen.getByLabelText("PDF pages");
    const page = screen.getByTestId("pdf-page");
    const content = pages.querySelector<HTMLElement>(
      ".pdf-viewer__pages-content",
    );
    Object.defineProperties(pages, {
      scrollLeft: { configurable: true, value: 100, writable: true },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    pages.getBoundingClientRect = vi.fn(() =>
      DOMRect.fromRect({ height: 600, width: 800, x: 0, y: 0 }),
    );
    content!.getBoundingClientRect = vi.fn(() =>
      DOMRect.fromRect({ height: 848, width: 800, x: 0, y: 0 }),
    );
    page.getBoundingClientRect = vi.fn(() =>
      DOMRect.fromRect({
        height: 800,
        width: 600,
        x: 50 - pages.scrollLeft,
        y: 24 - pages.scrollTop,
      }),
    );
    const startClientX = 300;
    const startClientY = 200;
    const noisyClientX = 330;
    const noisyClientY = 220;
    const initialRect = page.getBoundingClientRect();
    const normalizedX = (startClientX - initialRect.left) / initialRect.width;
    const normalizedY = (startClientY - initialRect.top) / initialRect.height;

    const start = new Event("gesturestart", { bubbles: true, cancelable: true });
    Object.assign(start, { clientX: startClientX, clientY: startClientY, scale: 1 });
    fireEvent(pages, start);
    const change = new Event("gesturechange", { bubbles: true, cancelable: true });
    Object.assign(change, {
      clientX: noisyClientX,
      clientY: noisyClientY,
      scale: 1.25,
    });
    fireEvent(pages, change);
    await waitFor(() => expect(screen.getByText("125%")).toBeVisible());
    const end = new Event("gestureend", { bubbles: true, cancelable: true });
    Object.assign(end, {
      clientX: noisyClientX,
      clientY: noisyClientY,
      scale: 1.25,
    });
    fireEvent(pages, end);

    await waitFor(() => expect(page).toHaveStyle({ width: "750px" }));
    const committedRect = page.getBoundingClientRect();
    expect(committedRect.left + committedRect.width * normalizedX).toBeCloseTo(
      startClientX,
    );
    expect(committedRect.top + committedRect.height * normalizedY).toBeCloseTo(
      startClientY,
    );
  });

  it("filters sub-percent WebKit scale noise and small direction reversals", async () => {
    const pdf = createPdf(1);
    render(
      <PdfViewer
        filePath="papers/noisy-scale.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );
    await screen.findByText("1 / 1");
    const pages = screen.getByLabelText("PDF pages");
    const page = screen.getByTestId("pdf-page");
    page.getBoundingClientRect = vi.fn(() =>
      DOMRect.fromRect({ height: 800, width: 600, x: 100, y: 24 }),
    );

    const dispatchChange = (scale: number) => {
      const event = new Event("gesturechange", {
        bubbles: true,
        cancelable: true,
      });
      Object.assign(event, { clientX: 300, clientY: 240, scale });
      fireEvent(pages, event);
    };
    const start = new Event("gesturestart", { bubbles: true, cancelable: true });
    Object.assign(start, { clientX: 300, clientY: 240, scale: 1 });
    fireEvent(pages, start);

    dispatchChange(1.004);
    expect(screen.getByText("100%")).toBeVisible();
    expect(page.style.transform).toBe("");

    dispatchChange(1.012);
    await waitFor(() => expect(page.style.transform).toContain("scale(1.01)"));
    expect(screen.getByText("101%")).toBeVisible();

    dispatchChange(1.007);
    expect(screen.getByText("101%")).toBeVisible();

    dispatchChange(0.99);
    await waitFor(() => expect(page.style.transform).toContain("scale(0.99)"));
    expect(screen.getByText("99%")).toBeVisible();
  });

  it("previews trackpad zoom without restarting page rendering for every wheel event", async () => {
    const pdf = createPdf(1);
    render(
      <PdfViewer
        filePath="papers/debounced-pinch.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );
    await waitFor(() => expect(pdf.page.render).toHaveBeenCalled());
    const renderCountBeforePinch = vi.mocked(pdf.page.render).mock.calls.length;
    const pages = screen.getByLabelText("PDF pages");

    fireEvent.wheel(pages, {
      clientX: 240,
      clientY: 180,
      ctrlKey: true,
      deltaY: -8,
    });
    fireEvent.wheel(pages, {
      clientX: 240,
      clientY: 180,
      ctrlKey: true,
      deltaY: -8,
    });

    expect(screen.queryByText("100%")).not.toBeInTheDocument();
    expect(pdf.page.render).toHaveBeenCalledTimes(renderCountBeforePinch);
    await waitFor(() =>
      expect(vi.mocked(pdf.page.render).mock.calls.length).toBeGreaterThan(
        renderCountBeforePinch,
      ),
    );
  });

  it("keeps the viewport center anchored when toolbar zoom changes page size", async () => {
    const pdf = createPdf(1);
    render(
      <PdfViewer
        filePath="papers/toolbar-anchor.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );
    await screen.findByText("1 / 1");
    const pages = screen.getByLabelText("PDF pages");
    Object.defineProperties(pages, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 800 },
      scrollLeft: { configurable: true, value: 100, writable: true },
      scrollTop: { configurable: true, value: 80, writable: true },
    });

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    await waitFor(() => expect(pages.scrollLeft).toBeCloseTo(150));
    expect(pages.scrollTop).toBeCloseTo(118);
  });

  it("coalesces several pinch events into one compositor update", async () => {
    const pdf = createPdf(1);
    render(
      <PdfViewer
        filePath="papers/pinch-anchor.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );
    await screen.findByText("1 / 1");
    const pages = screen.getByLabelText("PDF pages");
    const content = pages.querySelector<HTMLElement>(".pdf-viewer__pages-content");
    const page = screen.getByTestId("pdf-page");
    expect(content).not.toBeNull();
    Object.defineProperties(pages, {
      scrollLeft: { configurable: true, value: 100, writable: true },
      scrollTop: { configurable: true, value: 80, writable: true },
    });
    page.getBoundingClientRect = vi.fn(() =>
      DOMRect.fromRect({ height: 800, width: 600, x: 100, y: 24 }),
    );

    let nextFrameId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        const id = nextFrameId;
        nextFrameId += 1;
        frames.set(id, callback);
        return id;
      });
    const cancelFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((id) => {
        frames.delete(id);
      });

    try {
      for (let index = 0; index < 2; index += 1) {
        fireEvent.wheel(pages, {
          clientX: 200,
          clientY: 150,
          ctrlKey: true,
          deltaY: -10,
        });
      }

      expect(frames).toHaveLength(1);
      [...frames.values()][0](0);
      expect(page.style.transform).toContain("scale(1.22)");
      expect(content?.style.transform).toBe("");
      expect(pages.scrollLeft).toBe(100);
      expect(pages.scrollTop).toBe(80);
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it("clamps repeated trackpad pinches to the same zoom limits as the toolbar", async () => {
    const pdf = createPdf(1);
    render(
      <PdfViewer
        filePath="papers/pinch-limits.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );
    await screen.findByText("1 / 1");
    const pages = screen.getByLabelText("PDF pages");

    for (let index = 0; index < 12; index += 1) {
      fireEvent.wheel(pages, { ctrlKey: true, deltaY: -200 });
    }
    await waitFor(() => expect(screen.getByText("1000%")).toBeVisible());

    for (let index = 0; index < 20; index += 1) {
      fireEvent.wheel(pages, { ctrlKey: true, deltaY: 200 });
    }
    await waitFor(() => expect(screen.getByText("10%")).toBeVisible());
  });

  it("cancels page rendering and destroys document resources on change", async () => {
    const first = createPdf(1);
    const second = createPdf(1);
    const readPdfFile = vi.fn().mockResolvedValue(new Uint8Array([1]));
    const { rerender, unmount } = render(
      <PdfViewer
        filePath="papers/first.pdf"
        pdfJs={first.adapter}
        readPdfFile={readPdfFile}
      />,
    );
    await waitFor(() => expect(first.renderTasks).toHaveLength(1));
    await waitFor(() => expect(first.textLayerTasks).toHaveLength(1));

    rerender(
      <PdfViewer
        filePath="papers/second.pdf"
        pdfJs={second.adapter}
        readPdfFile={readPdfFile}
      />,
    );
    await waitFor(() => expect(second.renderTasks).toHaveLength(1));
    expect(first.renderTasks[0]?.cancel).toHaveBeenCalled();
    expect(first.textLayerTasks[0]?.cancel).toHaveBeenCalled();
    expect(first.loadingTask.destroy).toHaveBeenCalled();
    expect(first.document.destroy).toHaveBeenCalled();

    unmount();
    expect(second.renderTasks[0]?.cancel).toHaveBeenCalled();
    expect(second.loadingTask.destroy).toHaveBeenCalled();
    expect(second.document.destroy).toHaveBeenCalled();
  });

  it("shows a useful legacy-paper message without attempting a file read", () => {
    const readPdfFile = vi.fn();
    render(<PdfViewer filePath={null} readPdfFile={readPdfFile} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This legacy paper has no local PDF",
    );
    expect(readPdfFile).not.toHaveBeenCalled();
  });

  it("clears an old load error when a different PDF succeeds", async () => {
    const pdf = createPdf(1);
    const readPdfFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("cannot read"))
      .mockResolvedValueOnce(new Uint8Array([1]));
    const { rerender } = render(
      <PdfViewer
        filePath="papers/broken.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={readPdfFile}
      />,
    );
    await screen.findByText("The local PDF could not be opened.");

    rerender(
      <PdfViewer
        filePath="papers/good.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={readPdfFile}
      />,
    );

    await screen.findByText("1 / 1");
    expect(screen.queryByText("The local PDF could not be opened.")).toBeNull();
  });

  it("reports a page render failure without failing the whole document", async () => {
    const pdf = createPdf(1);
    pdf.page.render = vi.fn(() => ({
      cancel: vi.fn(),
      promise: Promise.reject(new Error("bad page")),
    }));
    render(
      <PdfViewer
        filePath="papers/damaged-page.pdf"
        pdfJs={pdf.adapter}
        readPdfFile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      />,
    );

    expect(await screen.findByText("Page 1 could not be rendered.")).toBeVisible();
    expect(screen.getByText("1 / 1")).toBeVisible();
  });
});
