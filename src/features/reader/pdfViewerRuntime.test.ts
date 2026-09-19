import type { PDFDocumentProxy } from "pdfjs-dist";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accumulatePdfScaleFactor,
  createPdfViewerRuntime,
  PDF_ZOOM_DRAWING_DELAY_MS,
} from "./pdfViewerRuntime";

const runtimeFakes = vi.hoisted(() => ({
  nextFirstPagePromise: null as Promise<object> | null,
  nextPagesPromise: null as Promise<object> | null,
  touchManagers: [] as FakeTouchManager[],
  viewers: [] as FakePdfViewer[],
}));

class FakeEventBus {
  private readonly listeners = new Map<string, Set<(event: never) => void>>();

  dispatch(eventName: string, event: unknown) {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(event as never);
    }
  }

  on(
    eventName: string,
    listener: (event: never) => void,
    options?: { signal?: AbortSignal },
  ) {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
    options?.signal?.addEventListener(
      "abort",
      () => listeners.delete(listener),
      { once: true },
    );
  }
}

class FakeTouchManager {
  readonly destroy = vi.fn();

  constructor(
    readonly options: {
      container: HTMLDivElement;
      onPinchEnd?: () => void;
      onPinching?: (
        origin: [number, number],
        previousDistance: number,
        distance: number,
      ) => void;
      onPinchStart?: () => void;
      signal: AbortSignal;
    },
  ) {
    runtimeFakes.touchManagers.push(this);
  }
}

class FakePdfViewer {
  currentPageNumber = 1;
  directScaleWrites = 0;
  firstPagePromise: Promise<object> | null = null;
  pagesPromise: Promise<object> | null = null;
  pagesCount = 0;
  private scale = 0.75;
  private updatingScale = false;

  getPageView(index: number) {
    const div = this.options.viewer.children[index] as HTMLDivElement | undefined;
    return div ? { div } : undefined;
  }

  readonly setDocument = vi.fn((document: PDFDocumentProxy | null) => {
    this.pagesCount = document?.numPages ?? 0;
    this.firstPagePromise = document
      ? runtimeFakes.nextFirstPagePromise ?? Promise.resolve({})
      : null;
    this.pagesPromise = document
      ? runtimeFakes.nextPagesPromise ?? this.firstPagePromise
      : null;
    runtimeFakes.nextFirstPagePromise = null;
    runtimeFakes.nextPagesPromise = null;
  });

  readonly setCurrentScale = vi.fn((value: number) => {
    if (value === this.scale) return;
    this.scale = value;
    this.options.eventBus.dispatch("scalechanging", { scale: value });
  });

  get currentScale() {
    return this.scale;
  }

  set currentScale(value: number) {
    if (value === this.scale) return;
    if (!this.updatingScale) this.directScaleWrites += 1;
    this.setCurrentScale(value);
  }

  readonly updateScale = vi.fn(
    ({
      scaleFactor,
      steps,
    }: {
      drawingDelay?: number;
      origin?: [number, number];
      scaleFactor?: number;
      steps?: number;
    }) => {
      this.updatingScale = true;
      try {
        if (scaleFactor !== undefined) {
          this.currentScale = Math.min(
            25,
            Math.max(
              0.1,
              Math.round(this.currentScale * scaleFactor * 100) / 100,
            ),
          );
        } else if (steps) {
          const delta = steps > 0 ? 1.1 : 1 / 1.1;
          const round = steps > 0 ? Math.ceil : Math.floor;
          let nextScale = this.currentScale;
          for (let remaining = Math.abs(steps); remaining > 0; remaining -= 1) {
            nextScale =
              round(Number((nextScale * delta).toFixed(2)) * 10) / 10;
          }
          this.currentScale = Math.min(25, Math.max(0.1, nextScale));
        }
      } finally {
        this.updatingScale = false;
      }
    },
  );

  constructor(
    readonly options: {
      annotationEditorMode: number;
      annotationMode: number;
      container: HTMLDivElement;
      enableAutoLinking: boolean;
      eventBus: FakeEventBus;
      maxCanvasPixels?: number;
      renderingQueue?: unknown;
      viewer: HTMLDivElement;
    },
  ) {
    runtimeFakes.viewers.push(this);
  }
}

vi.mock("pdfjs-dist/legacy/web/pdf_viewer.mjs", () => ({
  EventBus: FakeEventBus,
  PDFViewer: FakePdfViewer,
}));

function createDocument(pageCount = 2): PDFDocumentProxy {
  return { numPages: pageCount } as PDFDocumentProxy;
}

function createElements() {
  const container = globalThis.document.createElement("div");
  const viewer = globalThis.document.createElement("div");
  container.append(viewer);
  Object.defineProperties(container, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 600 },
  });
  container.getBoundingClientRect = () =>
    DOMRect.fromRect({ width: 800, height: 600 });
  viewer.getBoundingClientRect = () =>
    DOMRect.fromRect({ width: 800, height: 2000 });
  return { container, viewer };
}

function dispatchWebKitGesture(
  container: HTMLElement,
  type: "gesturestart" | "gesturechange" | "gestureend" | "gesturecancel",
  {
    clientX,
    clientY,
    scale,
  }: { clientX: number; clientY: number; scale: number },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX, clientY, scale });
  container.dispatchEvent(event);
  return event;
}

const animationFrames = new Map<number, FrameRequestCallback>();

function paintAnimationFrame() {
  const callbacks = [...animationFrames.values()];
  animationFrames.clear();
  for (const callback of callbacks) callback(performance.now());
}

function settleZoom() {
  paintAnimationFrame();
  vi.advanceTimersByTime(PDF_ZOOM_DRAWING_DELAY_MS);
}

describe("createPdfViewerRuntime", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    animationFrames.clear();
    let nextFrameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrames.set(++nextFrameId, callback);
      return nextFrameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      animationFrames.delete(id);
    });
    runtimeFakes.nextFirstPagePromise = null;
    runtimeFakes.nextPagesPromise = null;
    runtimeFakes.touchManagers.length = 0;
    runtimeFakes.viewers.length = 0;
    (
      globalThis as typeof globalThis & {
        pdfjsLib?: {
          AnnotationEditorType: { DISABLE: number };
          AnnotationMode: { DISABLE: number };
          FeatureTest: { platform: { isMac: boolean } };
          TouchManager: typeof FakeTouchManager;
        };
      }
    ).pdfjsLib = {
      AnnotationEditorType: { DISABLE: -1 },
      AnnotationMode: { DISABLE: 0 },
      FeatureTest: { platform: { isMac: true } },
      TouchManager: FakeTouchManager,
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("creates the official viewer at a real PDF.js 100% scale", async () => {
    const { container, viewer } = createElements();
    const onPageChange = vi.fn();
    const onScaleChange = vi.fn();
    const runtime = await createPdfViewerRuntime({
      container,
      document: createDocument(),
      onPageChange,
      onScaleChange,
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;

    expect(pdfViewer.options).toMatchObject({
      annotationEditorMode: -1,
      annotationMode: 0,
      enableAutoLinking: false,
      maxCanvasPixels: 32 * 1024 * 1024,
    });
    expect(pdfViewer.options).not.toHaveProperty("renderingQueue");
    expect(pdfViewer.currentScale).toBe(1);
    expect(runtime.currentZoom).toBe(1);
    expect(runtime.pagesCount).toBe(2);
    expect(runtimeFakes.touchManagers).toHaveLength(1);
    expect(onPageChange).toHaveBeenLastCalledWith(1);
    expect(onScaleChange).toHaveBeenLastCalledWith(1);
  });

  it("uses PDF.js scale semantics and clamps the public range to 10%-1000%", async () => {
    const { container, viewer } = createElements();
    const onScaleChange = vi.fn();
    const runtime = await createPdfViewerRuntime({
      container,
      document: createDocument(),
      onScaleChange,
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;

    runtime.zoomTo(0.01);
    settleZoom();
    expect(pdfViewer.currentScale).toBe(0.1);
    expect(runtime.currentZoom).toBe(0.1);

    runtime.zoomTo(20);
    settleZoom();
    expect(pdfViewer.currentScale).toBe(10);
    expect(runtime.currentZoom).toBe(10);
    expect(onScaleChange).toHaveBeenLastCalledWith(10);
  });

  it("leaves ordinary scrolling alone", async () => {
    const { container, viewer } = createElements();
    await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    pdfViewer.updateScale.mockClear();
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 40,
    });

    container.dispatchEvent(wheel);

    expect(wheel.defaultPrevented).toBe(false);
    expect(pdfViewer.updateScale).not.toHaveBeenCalled();
  });

  it("retains the pointer origin when applying a trackpad pinch on the next frame", async () => {
    const { container, viewer } = createElements();
    container.getBoundingClientRect = vi.fn(() =>
      DOMRect.fromRect({ height: 600, width: 800, x: 40, y: 60 }),
    );
    await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    pdfViewer.updateScale.mockClear();
    pdfViewer.directScaleWrites = 0;

    const pinch = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 90,
      clientY: 120,
      ctrlKey: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: -4,
    });
    container.dispatchEvent(pinch);

    expect(pinch.defaultPrevented).toBe(true);
    expect(pdfViewer.updateScale).not.toHaveBeenCalled();
    settleZoom();
    expect(pdfViewer.updateScale).toHaveBeenCalledExactlyOnceWith({
      drawingDelay: -1,
      origin: [50, 60],
      scaleFactor: 1.04,
    });
    expect(pdfViewer.currentScale).toBe(1.04);
    expect(pdfViewer.directScaleWrites).toBe(0);
  });

  it("previews a burst across frames without PDF.js layout, then commits after idle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { container, viewer } = createElements();
    const onScaleChange = vi.fn();
    const runtime = await createPdfViewerRuntime({
      container,
      document: createDocument(100),
      onScaleChange,
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    onScaleChange.mockClear();

    for (let frame = 1; frame <= 8; frame += 1) {
      for (let event = 0; event < 16; event += 1) {
        container.dispatchEvent(
          new WheelEvent("wheel", {
            cancelable: true,
            ctrlKey: true,
            deltaY: -1,
            clientX: 240,
            clientY: 180,
          }),
        );
      }
      expect(pdfViewer.updateScale).not.toHaveBeenCalled();
      expect(animationFrames.size).toBe(1);
      paintAnimationFrame();
      expect(pdfViewer.updateScale).not.toHaveBeenCalled();
      expect(runtime.currentZoom).toBe(
        Math.round(Math.exp(frame * 0.16) * 100) / 100,
      );
    }
    expect(runtime.currentZoom).toBe(3.6);
    expect(onScaleChange).toHaveBeenCalledTimes(8);
    vi.advanceTimersByTime(PDF_ZOOM_DRAWING_DELAY_MS);
    expect(pdfViewer.currentScale).toBe(3.6);
    expect(pdfViewer.updateScale).toHaveBeenCalledOnce();
    runtime.destroy();
  });

  it.each([
    { name: "fixed pointer", finalScale: 1.5, move: false, scroll: false },
    { name: "moving pointer and scroll", finalScale: 1.5, move: true, scroll: true },
    { name: "reversal to the original scale", finalScale: 1, move: true, scroll: false },
    { name: "zoom out", finalScale: 0.8, move: false, scroll: false },
  ])("preserves the page-local point through preview and settle: $name", async ({ finalScale, move, scroll }) => {
    const { container, viewer } = createElements();
    const page = document.createElement("div");
    page.className = "page";
    page.innerHTML = '<div class="textLayer"><span>Selectable text</span></div><div class="pdf-viewer__persisted-highlights"></div>';
    viewer.append(page);
    const textLayer = page.firstElementChild;
    const highlights = page.lastElementChild;
    // A scrolled second page, with a fixed 24px gap and centered narrow pages.
    container.scrollLeft = 120;
    container.scrollTop = 700;
    container.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 40, y: 60, width: 800, height: 600 });
    Object.defineProperties(container, {
      offsetLeft: { value: 17 },
      offsetTop: { value: 29 },
    });
    viewer.getBoundingClientRect = () => DOMRect.fromRect({
      x: 64 - container.scrollLeft, y: 84 - container.scrollTop,
      width: 752, height: 4000,
    });
    const runtime = await createPdfViewerRuntime({ container, document: createDocument(), viewer });
    const pdfViewer = runtimeFakes.viewers[0]!;
    page.getBoundingClientRect = () => {
      const scale = pdfViewer.currentScale;
      const base = viewer.getBoundingClientRect();
      const matrix = viewer.style.transform.match(/translate3d\(([^p]+)px, ([^p]+)px, 0\) scale\(([^)]+)\)/);
      const [tx, ty, ratio] = matrix ? matrix.slice(1).map(Number) : [0, 0, 1];
      return DOMRect.fromRect({
        x: base.left + tx! + Math.max(0, (752 - 600 * scale) / 2) * ratio!,
        y: base.top + ty! + (800 * scale + 24) * ratio!,
        width: 600 * scale * ratio!, height: 800 * scale * ratio!,
      });
    };
    const initial = page.getBoundingClientRect();
    const x = (240 - initial.left) / initial.width;
    const y = (280 - initial.top) / initial.height;
    runtime.zoomTo(1.2, [217, 249]); // Client (240, 280) with nonzero offsets.
    paintAnimationFrame();
    expect(viewer).toHaveClass("is-zoom-preview");
    expect(page.style.transform).toBe("");
    const first = page.getBoundingClientRect();
    expect(first.left + first.width * x).toBeCloseTo(240, 8);
    expect(first.top + first.height * y).toBeCloseTo(280, 8);

    if (scroll) {
      container.scrollLeft += 30;
      container.scrollTop += 50;
    }
    const clientX = move ? 300 : 240;
    const clientY = move ? 340 : 280;
    runtime.zoomTo(finalScale, [clientX - 23, clientY - 31]);
    paintAnimationFrame();
    const preview = page.getBoundingClientRect();
    const expectedX = clientX + (240 - (scroll ? 30 : 0) - clientX) * finalScale / 1.2;
    const expectedY = clientY + (280 - (scroll ? 50 : 0) - clientY) * finalScale / 1.2;
    expect(preview.left + preview.width * x).toBeCloseTo(expectedX, 8);
    expect(preview.top + preview.height * y).toBeCloseTo(expectedY, 8);
    expect(pdfViewer.currentScale).toBe(1);

    settleZoom();
    const final = page.getBoundingClientRect();
    expect(final.left + final.width * x).toBeCloseTo(expectedX, 8);
    expect(final.top + final.height * y).toBeCloseTo(expectedY, 8);
    expect(pdfViewer.currentScale).toBe(finalScale);
    expect(viewer).not.toHaveClass("is-zoom-preview");
    expect(viewer.style.transform).toBe("");
    expect(page.firstElementChild).toBe(textLayer);
    expect(page.lastElementChild).toBe(highlights);
    runtime.destroy();
  });

  it("paints sub-percent pinch motion and returns a symmetric pinch to its starting scale", async () => {
    const { container, viewer } = createElements();
    const runtime = await createPdfViewerRuntime({ container, document: createDocument(), viewer });
    runtime.zoomTo(2.67, undefined, 0);
    paintAnimationFrame();
    const pdfViewer = runtimeFakes.viewers[0]!;
    pdfViewer.updateScale.mockClear();
    for (let frame = 0; frame < 90; frame += 1) {
      for (let event = 0; event < 4; event += 1) {
        container.dispatchEvent(new WheelEvent("wheel", {
          ctrlKey: true, deltaY: frame < 45 ? -0.4 : 0.4,
        }));
      }
      paintAnimationFrame();
      const scale = Number(viewer.style.transform.match(/scale\(([^)]+)\)/)?.[1]);
      expect(scale).toBeCloseTo(Math.exp(0.016 * (frame < 45 ? frame + 1 : 89 - frame)), 10);
    }
    settleZoom();
    expect(runtime.currentZoom).toBe(2.67);
    expect(pdfViewer.currentScale).toBe(2.67);
    expect(pdfViewer.updateScale).not.toHaveBeenCalled();
    runtime.destroy();
  });

  it("clears each preview through the renderer smoke's toolbar, wheel and alternating input sequence", async () => {
    const { container, viewer } = createElements();
    const runtime = await createPdfViewerRuntime({ container, document: createDocument(25), viewer });
    for (let click = 0; click < 6; click += 1) runtime.stepZoom(1);
    settleZoom();
    expect(viewer.style.transform).toBe("");
    for (let event = 0; event < 12; event += 1) {
      container.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -2 }));
    }
    settleZoom();
    expect(runtime.currentZoom).toBe(2.67);
    expect(viewer.style.transform).toBe("");
    for (const kind of ["pinch", "buttons"]) {
      for (let frame = 0; frame < 90; frame += 1) {
        paintAnimationFrame();
        vi.advanceTimersByTime(1000 / 60);
        if (kind === "pinch") {
          for (let event = 0; event < 4; event += 1) {
            container.dispatchEvent(new WheelEvent("wheel", {
              ctrlKey: true, deltaY: frame < 45 ? -0.4 : 0.4,
              clientX: 400, clientY: 300,
            }));
          }
        } else if (frame % 3 === 0) {
          runtime.stepZoom(frame % 6 === 0 ? 1 : -1);
        }
      }
      paintAnimationFrame();
      vi.advanceTimersByTime(700);
      expect(viewer.style.transform).toBe("");
      expect(viewer).not.toHaveClass("is-zoom-preview");
    }
    runtime.destroy();
  });

  it("routes a pixel mouse wheel through PDF.js ticks instead of a pinch factor", async () => {
    const { container, viewer } = createElements();
    await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    pdfViewer.updateScale.mockClear();

    globalThis.document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Control" }),
    );
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: -30,
    });
    container.dispatchEvent(wheel);

    expect(wheel.defaultPrevented).toBe(true);
    settleZoom();
    expect(pdfViewer.updateScale).toHaveBeenCalledExactlyOnceWith({
      drawingDelay: -1,
      origin: [0, 0],
      scaleFactor: 1.1,
    });
  });

  it.each([-8, 10])("treats a fast Chromium pinch delta %s as continuous scaling", async (deltaY) => {
    const { container, viewer } = createElements();
    const runtime = await createPdfViewerRuntime({ container, document: createDocument(), viewer });
    container.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY }));
    paintAnimationFrame();

    const scale = Number(viewer.style.transform.match(/scale\(([^)]+)\)/)?.[1]);
    expect(scale).toBeCloseTo(Math.exp(-deltaY / 100), 10);
    expect(runtimeFakes.viewers[0]!.updateScale).not.toHaveBeenCalled();
    settleZoom();
    expect(runtime.currentZoom).toBe(Math.round(Math.exp(-deltaY / 100) * 100) / 100);
    runtime.destroy();
  });

  it("keeps a physical Ctrl wheel discrete while another key is pressed", async () => {
    const { container, viewer } = createElements();
    const runtime = await createPdfViewerRuntime({ container, document: createDocument(), viewer });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Control" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
    for (let event = 0; event < 3; event += 1) {
      container.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -8 }));
    }
    paintAnimationFrame();
    expect(runtime.currentZoom).toBe(1);
    expect(viewer.style.transform).toBe("");
    container.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -8 }));
    settleZoom();
    expect(runtime.currentZoom).toBe(1.1);
    runtime.destroy();
  });

  it("does not classify a diagonal pixel wheel as a trackpad pinch", async () => {
    const { container, viewer } = createElements();
    await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    pdfViewer.updateScale.mockClear();

    container.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaX: 1,
        deltaY: -30,
      }),
    );

    settleZoom();
    expect(pdfViewer.updateScale).toHaveBeenCalledExactlyOnceWith({
      drawingDelay: -1,
      origin: [0, 0],
      scaleFactor: 1.1,
    });
  });

  it("clears stale physical-Control state when the window loses focus", async () => {
    const { container, viewer } = createElements();
    await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    pdfViewer.updateScale.mockClear();

    globalThis.document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Control" }),
    );
    globalThis.dispatchEvent(new Event("blur"));
    container.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaY: -1,
      }),
    );

    settleZoom();
    expect(pdfViewer.updateScale).toHaveBeenCalledExactlyOnceWith({
      drawingDelay: -1,
      origin: [0, 0],
      scaleFactor: 1.01,
    });
  });

  it("carries sub-percent rounding into a later pinch event", () => {
    const state = { unusedFactor: 1 };

    expect(accumulatePdfScaleFactor(1, 1.003, state)).toBe(1);
    expect(accumulatePdfScaleFactor(1, 1.003, state)).toBe(1.01);
    expect(state.unusedFactor).toBeCloseTo(1.003 ** 2 / 1.01);
  });

  it("accumulates tiny pinch deltas across frames even when a frame does not change scale", async () => {
    const { container, viewer } = createElements();
    const runtime = await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;

    for (let frame = 0; frame < 10; frame += 1) {
      container.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -0.1 }));
      container.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -0.1 }));
      paintAnimationFrame();
    }

    expect(runtime.currentZoom).toBe(1.02);
    expect(pdfViewer.updateScale).not.toHaveBeenCalled();
    settleZoom();
    expect(pdfViewer.currentScale).toBe(1.02);
    expect(pdfViewer.updateScale).toHaveBeenCalledOnce();
    runtime.destroy();
  });

  it("keeps mouse-wheel tick rounding for mixed directions within one frame", async () => {
    const { container, viewer } = createElements();
    const runtime = await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    runtime.zoomTo(1.05);
    settleZoom();
    pdfViewer.updateScale.mockClear();

    for (const deltaY of [-1, 1, -1]) {
      container.dispatchEvent(new WheelEvent("wheel", {
        ctrlKey: true,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY,
      }));
    }
    settleZoom();

    // Three PDF.js ticks: 1.05 -> 1.2 -> 1 -> 1.1. A net +1 tick yields 1.2.
    expect(pdfViewer.currentScale).toBe(1.1);
    expect(pdfViewer.updateScale).toHaveBeenCalledOnce();
    runtime.destroy();
  });

  it.each([
    { boundary: 10, direction: 1 as const, reversed: 9 },
    { boundary: 0.1, direction: -1 as const, reversed: 0.2 },
  ])("clamps queued button steps at $boundary without swallowing a reversal", async ({ boundary, direction, reversed }) => {
    const { container, viewer } = createElements();
    const runtime = await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;

    runtime.zoomTo(boundary);
    for (let click = 0; click < 10; click += 1) runtime.stepZoom(direction);
    expect(runtime.currentZoom).toBe(boundary);
    runtime.stepZoom(direction === 1 ? -1 : 1);
    settleZoom();

    expect(pdfViewer.currentScale).toBe(reversed);
    expect(pdfViewer.updateScale).toHaveBeenCalledOnce();
    runtime.destroy();
  });

  it("lets absolute zoom replace a queued gesture target and keeps its origin and drawing delay", async () => {
    const { container, viewer } = createElements();
    const runtime = await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;

    container.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -4 }));
    runtime.zoomTo(2.125, [300, 250], 0);
    settleZoom();

    expect(pdfViewer.updateScale).toHaveBeenCalledExactlyOnceWith({
      drawingDelay: -1,
      origin: [300, 250],
      scaleFactor: 2.13,
    });
    runtime.destroy();
  });

  it("does not let a queued zoom reset an explicit page navigation", async () => {
    const { container, viewer } = createElements();
    const runtime = await createPdfViewerRuntime({
      container,
      document: createDocument(10),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    const pageDuringZoom: number[] = [];
    pdfViewer.updateScale.mockImplementation(() => {
      pageDuringZoom.push(pdfViewer.currentPageNumber);
    });

    runtime.stepZoom(1);
    runtime.setPage(7);
    settleZoom();

    expect(pageDuringZoom).toEqual([1]);
    expect(runtime.currentPage).toBe(7);
    runtime.destroy();
  });

  it("does not accumulate beyond the product zoom boundaries", () => {
    const upper = { unusedFactor: 1 };
    const lower = { unusedFactor: 1 };

    expect(accumulatePdfScaleFactor(10, 2, upper)).toBe(1);
    expect(accumulatePdfScaleFactor(0.1, 0.5, lower)).toBe(1);
    expect(accumulatePdfScaleFactor(10, 0.9, upper)).toBe(0.9);
    expect(accumulatePdfScaleFactor(0.1, 1.1, lower)).toBeCloseTo(1.1);
  });

  it("coalesces WebKit pinch deltas and flushes the last target at gesture end", async () => {
    const { container, viewer } = createElements();
    await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    pdfViewer.updateScale.mockClear();
    pdfViewer.directScaleWrites = 0;

    dispatchWebKitGesture(container, "gesturestart", {
      clientX: 200,
      clientY: 150,
      scale: 1,
    });
    dispatchWebKitGesture(container, "gesturechange", {
      clientX: 200,
      clientY: 150,
      scale: 1.1,
    });
    dispatchWebKitGesture(container, "gesturechange", {
      clientX: 205,
      clientY: 145,
      scale: 1.21,
    });

    expect(pdfViewer.updateScale).not.toHaveBeenCalled();
    dispatchWebKitGesture(container, "gestureend", {
      clientX: 205,
      clientY: 145,
      scale: 1.21,
    });

    expect(pdfViewer.updateScale).toHaveBeenCalledExactlyOnceWith({
      drawingDelay: -1,
      origin: [205, 145],
      scaleFactor: 1.21,
    });
    expect(pdfViewer.currentScale).toBe(1.21);
    settleZoom();
    expect(pdfViewer.updateScale).toHaveBeenCalledOnce();
    expect(pdfViewer.directScaleWrites).toBe(0);
  });

  it("suppresses the duplicate wheel tail of a WebKit gesture", async () => {
    let currentTime = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => currentTime);
    const { container, viewer } = createElements();
    await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    pdfViewer.updateScale.mockClear();

    dispatchWebKitGesture(container, "gesturestart", {
      clientX: 200,
      clientY: 150,
      scale: 1,
    });
    dispatchWebKitGesture(container, "gesturechange", {
      clientX: 200,
      clientY: 150,
      scale: 1.2,
    });
    dispatchWebKitGesture(container, "gestureend", {
      clientX: 200,
      clientY: 150,
      scale: 1.2,
    });
    expect(pdfViewer.updateScale).toHaveBeenCalledOnce();

    currentTime += 300;
    container.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -4,
      }),
    );
    expect(pdfViewer.updateScale).toHaveBeenCalledOnce();

    currentTime += 201;
    container.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -4,
      }),
    );
    settleZoom();
    expect(pdfViewer.updateScale).toHaveBeenCalledTimes(2);
  });

  it("keeps a wheel-first stream when duplicate WebKit events arrive before its frame", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const { container, viewer } = createElements();
    const runtime = await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;

    container.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -4 }));
    dispatchWebKitGesture(container, "gesturestart", { clientX: 200, clientY: 150, scale: 1 });
    dispatchWebKitGesture(container, "gesturechange", { clientX: 200, clientY: 150, scale: 1.2 });
    dispatchWebKitGesture(container, "gestureend", { clientX: 200, clientY: 150, scale: 1.2 });
    expect(pdfViewer.updateScale).not.toHaveBeenCalled();
    settleZoom();

    expect(pdfViewer.currentScale).toBe(1.04);
    expect(pdfViewer.updateScale).toHaveBeenCalledOnce();
    runtime.destroy();
  });

  it.each(["gesturecancel", "blur"] as const)("flushes pending zoom on %s without leaving a stale frame", async (eventName) => {
    const { container, viewer } = createElements();
    const runtime = await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    dispatchWebKitGesture(container, "gesturestart", { clientX: 200, clientY: 150, scale: 1 });
    dispatchWebKitGesture(container, "gesturechange", { clientX: 200, clientY: 150, scale: 1.2 });

    if (eventName === "blur") globalThis.dispatchEvent(new Event("blur"));
    else dispatchWebKitGesture(container, eventName, { clientX: 200, clientY: 150, scale: 1.2 });
    expect(pdfViewer.currentScale).toBe(1.2);
    expect(animationFrames.size).toBe(0);
    settleZoom();
    expect(pdfViewer.updateScale).toHaveBeenCalledOnce();
    runtime.destroy();
  });

  it("uses PDF.js TouchManager and flushes a pending touch pinch at its end", async () => {
    const { container, viewer } = createElements();
    await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    const touchManager = runtimeFakes.touchManagers[0]!;
    pdfViewer.updateScale.mockClear();

    touchManager.options.onPinching?.([220, 180], 100, 120);

    expect(pdfViewer.updateScale).not.toHaveBeenCalled();
    touchManager.options.onPinchEnd?.();
    expect(pdfViewer.updateScale).toHaveBeenCalledExactlyOnceWith({
      drawingDelay: -1,
      origin: [220, 180],
      scaleFactor: 1.2,
    });
    settleZoom();
    expect(pdfViewer.updateScale).toHaveBeenCalledOnce();
  });

  it("coalesces toolbar clicks while preserving PDF.js step rounding and direction changes", async () => {
    const { container, viewer } = createElements();
    const runtime = await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    pdfViewer.updateScale.mockClear();

    runtime.stepZoom(1);
    expect(runtime.currentZoom).toBe(1.1);
    runtime.stepZoom(1);
    expect(runtime.currentZoom).toBe(1.3);
    runtime.stepZoom(1);
    expect(runtime.currentZoom).toBe(1.5);
    runtime.stepZoom(-1);
    expect(runtime.currentZoom).toBe(1.3);
    expect(pdfViewer.updateScale).not.toHaveBeenCalled();
    settleZoom();

    expect(pdfViewer.updateScale).toHaveBeenCalledExactlyOnceWith({
      drawingDelay: -1,
      origin: undefined,
      scaleFactor: 1.3,
    });
    expect(pdfViewer.currentScale).toBe(1.3);
  });

  it("keeps an active WebKit gesture alive while change events continue", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { container, viewer } = createElements();
    await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    pdfViewer.updateScale.mockClear();

    dispatchWebKitGesture(container, "gesturestart", {
      clientX: 200,
      clientY: 150,
      scale: 1,
    });
    vi.advanceTimersByTime(4900);
    dispatchWebKitGesture(container, "gesturechange", {
      clientX: 200,
      clientY: 150,
      scale: 1.1,
    });
    paintAnimationFrame();
    vi.advanceTimersByTime(4900);
    dispatchWebKitGesture(container, "gesturechange", {
      clientX: 200,
      clientY: 150,
      scale: 1.21,
    });
    settleZoom();

    expect(pdfViewer.updateScale).toHaveBeenCalledTimes(2);
  });

  it("recovers wheel input when WebKit omits gestureend", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let currentTime = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => currentTime);
    const { container, viewer } = createElements();
    await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    pdfViewer.updateScale.mockClear();

    dispatchWebKitGesture(container, "gesturestart", {
      clientX: 200,
      clientY: 150,
      scale: 1,
    });
    dispatchWebKitGesture(container, "gesturechange", {
      clientX: 200,
      clientY: 150,
      scale: 1.2,
    });
    settleZoom();
    expect(pdfViewer.updateScale).toHaveBeenCalledOnce();

    currentTime += 5000;
    vi.advanceTimersByTime(5000);
    container.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -4,
      }),
    );
    settleZoom();
    expect(pdfViewer.updateScale).toHaveBeenCalledTimes(2);
  });

  it("removes listeners, destroys TouchManager, and detaches the document", async () => {
    const { container, viewer } = createElements();
    const runtime = await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    const touchManager = runtimeFakes.touchManagers[0]!;

    runtime.destroy();
    pdfViewer.updateScale.mockClear();
    container.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -4,
      }),
    );

    expect(pdfViewer.updateScale).not.toHaveBeenCalled();
    expect(touchManager.destroy).toHaveBeenCalledOnce();
    expect(pdfViewer.setDocument).toHaveBeenLastCalledWith(null);
  });

  it.each(["destroy", "abort"] as const)("cancels a queued scale update on %s", async (method) => {
    const abortController = new AbortController();
    const { container, viewer } = createElements();
    const onScaleChange = vi.fn();
    const runtime = await createPdfViewerRuntime({
      abortSignal: abortController.signal,
      container,
      document: createDocument(),
      onScaleChange,
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    onScaleChange.mockClear();
    runtime.stepZoom(1);
    expect(animationFrames.size).toBe(1);

    if (method === "destroy") runtime.destroy();
    else abortController.abort();
    expect(animationFrames.size).toBe(0);
    settleZoom();

    expect(pdfViewer.updateScale).not.toHaveBeenCalled();
    expect(onScaleChange).not.toHaveBeenCalled();
    expect(pdfViewer.setDocument).toHaveBeenLastCalledWith(null);
  });

  it.each(["destroy", "abort"] as const)("restores a painted preview on %s and ignores a late RAF", async (method) => {
    const abortController = new AbortController();
    const { container, viewer } = createElements();
    viewer.style.setProperty("transform", "translateX(3px)", "important");
    const runtime = await createPdfViewerRuntime({
      abortSignal: abortController.signal, container, document: createDocument(), viewer,
    });
    runtime.stepZoom(1);
    paintAnimationFrame();
    expect(viewer).toHaveClass("is-zoom-preview");
    runtime.stepZoom(1);
    const queuedFrame = [...animationFrames.values()][0]!;
    if (method === "destroy") runtime.destroy();
    else abortController.abort();
    queuedFrame(performance.now());
    vi.advanceTimersByTime(PDF_ZOOM_DRAWING_DELAY_MS);
    expect(viewer.style.transform).toBe("translateX(3px)");
    expect(viewer.style.getPropertyPriority("transform")).toBe("important");
    expect(viewer).not.toHaveClass("is-zoom-preview");
    expect(runtimeFakes.viewers[0]!.updateScale).not.toHaveBeenCalled();
    expect(animationFrames.size).toBe(0);
  });

  it("aborts a runtime that unmounts while its first page is loading", async () => {
    let resolveFirstPage: ((value: object) => void) | undefined;
    runtimeFakes.nextFirstPagePromise = new Promise((resolve) => {
      resolveFirstPage = resolve;
    });
    const abortController = new AbortController();
    const { container, viewer } = createElements();
    const runtimePromise = createPdfViewerRuntime({
      abortSignal: abortController.signal,
      container,
      document: createDocument(),
      viewer,
    });
    await vi.waitFor(() => expect(runtimeFakes.viewers).toHaveLength(1));
    const pdfViewer = runtimeFakes.viewers[0]!;

    abortController.abort();
    resolveFirstPage?.({});

    await expect(runtimePromise).rejects.toThrow(/destroyed|aborted/i);
    expect(pdfViewer.setDocument).toHaveBeenLastCalledWith(null);
  });

  it("cleans up when PDF.js rejects page initialization", async () => {
    runtimeFakes.nextFirstPagePromise = Promise.resolve({});
    runtimeFakes.nextPagesPromise = Promise.reject(
      new Error("Unable to initialize PDF pages"),
    );
    const { container, viewer } = createElements();

    await expect(
      createPdfViewerRuntime({
        container,
        document: createDocument(),
        viewer,
      }),
    ).rejects.toThrow("Unable to initialize PDF pages");
    expect(runtimeFakes.viewers[0]?.setDocument).toHaveBeenLastCalledWith(null);
  });
});
