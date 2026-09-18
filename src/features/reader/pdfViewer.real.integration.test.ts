import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./pdfJsCompatibility";

// pdf_viewer.mjs intentionally reads the matching display build from this
// global, just like the official PDF.js viewer application does at runtime.
(globalThis as typeof globalThis & { pdfjsLib?: typeof pdfjsLib }).pdfjsLib =
  pdfjsLib;

const { EventBus, PDFViewer, RenderingStates } = await import(
  "pdfjs-dist/legacy/web/pdf_viewer.mjs"
);

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

class TestViewport {
  readonly height: number;
  readonly rawDims = {
    pageHeight: PAGE_HEIGHT,
    pageWidth: PAGE_WIDTH,
    pageX: 0,
    pageY: 0,
  };
  readonly rotation: number;
  readonly scale: number;
  readonly userUnit = 1;
  readonly width: number;

  constructor(scale: number, rotation = 0) {
    this.scale = scale;
    this.rotation = rotation;
    this.width = PAGE_WIDTH * scale;
    this.height = PAGE_HEIGHT * scale;
  }

  clone({
    rotation = this.rotation,
    scale = this.scale,
  }: { rotation?: number; scale?: number } = {}) {
    return new TestViewport(scale, rotation);
  }

  convertToPdfPoint(x: number, y: number): [number, number] {
    return [x / this.scale, PAGE_HEIGHT - y / this.scale];
  }

  convertToViewportPoint(x: number, y: number): [number, number] {
    return [x * this.scale, (PAGE_HEIGHT - y) * this.scale];
  }
}

interface PdfFixture {
  document: PDFDocumentProxy;
  renderPage: ReturnType<typeof vi.fn>;
}

function createPdfFixture(): PdfFixture {
  const renderPage = vi.fn(() => ({
    cancel: vi.fn(),
    onContinue: undefined as ((continueCallback: () => void) => void) | undefined,
    onError: undefined as ((error: unknown) => void) | undefined,
    promise: Promise.resolve(),
    separateAnnots: false,
  }));
  const page = {
    cleanup: vi.fn(),
    getStructTree: vi.fn().mockResolvedValue(null),
    getViewport: ({ scale, rotation = 0 }: { scale: number; rotation?: number }) =>
      new TestViewport(scale, rotation),
    isPureXfa: false,
    pageNumber: 1,
    render: renderPage,
    rotate: 0,
  } as unknown as PDFPageProxy;

  return {
    document: {
      getMetadata: vi.fn().mockResolvedValue({ info: {} }),
      getOptionalContentConfig: vi
        .fn()
        .mockResolvedValue({ hasInitialVisibility: true }),
      getPage: vi.fn().mockResolvedValue(page),
      isPureXfa: false,
      loadingParams: { disableAutoFetch: true },
      numPages: 1,
    } as unknown as PDFDocumentProxy,
    renderPage,
  };
}

function exposeLayout(element: HTMLElement, dimensions: {
  height: number;
  width: number;
}) {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: dimensions.height },
    clientLeft: { configurable: true, value: 0 },
    clientTop: { configurable: true, value: 0 },
    clientWidth: { configurable: true, value: dimensions.width },
    offsetLeft: { configurable: true, value: 0 },
    offsetTop: { configurable: true, value: 0 },
  });
}

interface ViewerHarness {
  abortController: AbortController;
  container: HTMLDivElement;
  fixture: PdfFixture;
  pageView: ReturnType<InstanceType<typeof PDFViewer>["getPageView"]>;
  pdfViewer: InstanceType<typeof PDFViewer>;
}

const harnesses: ViewerHarness[] = [];

async function createViewerHarness(): Promise<ViewerHarness> {
  const container = document.createElement("div");
  const viewer = document.createElement("div");
  viewer.className = "pdfViewer";
  container.append(viewer);
  document.body.append(container);
  exposeLayout(container, { height: 900, width: 800 });

  const abortController = new AbortController();
  const fixture = createPdfFixture();
  const pdfViewer = new PDFViewer({
    abortSignal: abortController.signal,
    annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
    annotationMode: pdfjsLib.AnnotationMode.DISABLE,
    container,
    enableAutoLinking: false,
    eventBus: new EventBus(),
    l10n: {
      pause() {},
      resume() {},
      translate: async () => {},
    } as never,
    textLayerMode: 0,
    viewer,
  } as ConstructorParameters<typeof PDFViewer>[0]);

  pdfViewer.setDocument(fixture.document);
  await pdfViewer.firstPagePromise;
  // The application establishes an explicit 100% scale after pagesinit.
  pdfViewer.currentScale = 1;
  const pageView = pdfViewer.getPageView(0);
  if (!pageView) throw new Error("PDF.js did not create its first page view.");
  exposeLayout(pageView.div, { height: PAGE_HEIGHT, width: PAGE_WIDTH });
  Object.defineProperty(pageView.div, "offsetParent", {
    configurable: true,
    value: container,
  });
  await pageView.draw();

  const harness = {
    abortController,
    container,
    fixture,
    pageView,
    pdfViewer,
  };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const { abortController, container, pdfViewer } of harnesses.splice(0)) {
    pdfViewer.setDocument(null as never);
    abortController.abort();
    container.remove();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("real pdfjs-dist PDFViewer zoom integration", () => {
  it("supports the product's complete 10%-1000% zoom range", async () => {
    const { pdfViewer } = await createViewerHarness();

    pdfViewer.updateScale({ scaleFactor: 0.001 });
    expect(pdfViewer.currentScale).toBe(0.1);

    pdfViewer.updateScale({ scaleFactor: 100 });
    expect(pdfViewer.currentScale).toBe(10);
  });

  it("keeps the rendered canvas during continuous delayed zoom and redraws after idle", async () => {
    const { fixture, pageView, pdfViewer } = await createViewerHarness();
    const initiallyRenderedCanvas = pageView.canvas;
    expect(initiallyRenderedCanvas).toBeInstanceOf(HTMLCanvasElement);
    expect(pageView.renderingState).toBe(RenderingStates.FINISHED);
    expect(fixture.renderPage).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();

    pdfViewer.updateScale({ drawingDelay: 400, scaleFactor: 1.1 });
    await vi.advanceTimersByTimeAsync(250);
    pdfViewer.updateScale({ drawingDelay: 400, scaleFactor: 1.1 });

    expect(pdfViewer.currentScale).toBe(1.21);
    expect(pageView.canvas).toBe(initiallyRenderedCanvas);
    expect(pageView.renderingState).toBe(RenderingStates.FINISHED);
    expect(fixture.renderPage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(399);
    expect(pageView.canvas).toBe(initiallyRenderedCanvas);
    expect(fixture.renderPage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.renderPage).toHaveBeenCalledTimes(2);
    expect(pageView.canvas).not.toBe(initiallyRenderedCanvas);
    expect(pageView.renderingState).toBe(RenderingStates.FINISHED);
  });
});
