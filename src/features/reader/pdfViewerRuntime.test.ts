import type { PDFDocumentProxy } from "pdfjs-dist";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accumulatePdfScaleFactor,
  createPdfViewerRuntime,
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
  return { container, viewer };
}

function dispatchWebKitGesture(
  container: HTMLElement,
  type: "gesturestart" | "gesturechange" | "gestureend",
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

describe("createPdfViewerRuntime", () => {
  beforeEach(() => {
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
    expect(pdfViewer.currentScale).toBe(0.1);
    expect(runtime.currentZoom).toBe(0.1);

    runtime.zoomTo(20);
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

  it("routes every trackpad pinch event through PDF.js delayed drawing immediately", async () => {
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
    expect(pdfViewer.updateScale).toHaveBeenCalledExactlyOnceWith({
      drawingDelay: 400,
      origin: [50, 60],
      scaleFactor: 1.04,
    });
    expect(pdfViewer.currentScale).toBe(1.04);
    expect(pdfViewer.directScaleWrites).toBe(0);
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
    expect(pdfViewer.updateScale).toHaveBeenCalledExactlyOnceWith({
      drawingDelay: 400,
      origin: [0, 0],
      steps: 1,
    });
    expect(pdfViewer.updateScale.mock.calls[0]?.[0]).not.toHaveProperty(
      "scaleFactor",
    );
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

    expect(pdfViewer.updateScale).toHaveBeenCalledExactlyOnceWith({
      drawingDelay: 400,
      origin: [0, 0],
      steps: 1,
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

    expect(pdfViewer.updateScale).toHaveBeenCalledExactlyOnceWith({
      drawingDelay: 400,
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

  it("does not accumulate beyond the product zoom boundaries", () => {
    const upper = { unusedFactor: 1 };
    const lower = { unusedFactor: 1 };

    expect(accumulatePdfScaleFactor(10, 2, upper)).toBe(1);
    expect(accumulatePdfScaleFactor(0.1, 0.5, lower)).toBe(1);
    expect(accumulatePdfScaleFactor(10, 0.9, upper)).toBe(0.9);
    expect(accumulatePdfScaleFactor(0.1, 1.1, lower)).toBeCloseTo(1.1);
  });

  it("applies WebKit pinch deltas immediately and does no gesture-end commit", async () => {
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

    expect(pdfViewer.updateScale).toHaveBeenCalledTimes(2);
    expect(pdfViewer.updateScale.mock.calls[1]?.[0]).toEqual({
      drawingDelay: 400,
      origin: [205, 145],
      scaleFactor: expect.closeTo(1.1),
    });
    const scaleAtEnd = pdfViewer.currentScale;
    dispatchWebKitGesture(container, "gestureend", {
      clientX: 205,
      clientY: 145,
      scale: 1.21,
    });

    expect(pdfViewer.updateScale).toHaveBeenCalledTimes(2);
    expect(pdfViewer.currentScale).toBe(scaleAtEnd);
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
    expect(pdfViewer.updateScale).toHaveBeenCalledTimes(2);
  });

  it("uses PDF.js TouchManager and applies touch pinch deltas without an end commit", async () => {
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

    expect(pdfViewer.updateScale).toHaveBeenCalledExactlyOnceWith({
      drawingDelay: 400,
      origin: [220, 180],
      scaleFactor: 1.2,
    });
    touchManager.options.onPinchEnd?.();
    expect(pdfViewer.updateScale).toHaveBeenCalledOnce();
  });

  it("uses the same delayed official path for toolbar steps", async () => {
    const { container, viewer } = createElements();
    const runtime = await createPdfViewerRuntime({
      container,
      document: createDocument(),
      viewer,
    });
    const pdfViewer = runtimeFakes.viewers[0]!;
    pdfViewer.updateScale.mockClear();

    runtime.stepZoom(1);

    expect(pdfViewer.updateScale).toHaveBeenCalledExactlyOnceWith({
      drawingDelay: 400,
      origin: undefined,
      steps: 1,
    });
    expect(pdfViewer.currentScale).toBe(1.1);

    pdfViewer.updateScale.mockClear();
    runtime.stepZoom(1);

    expect(pdfViewer.updateScale).toHaveBeenCalledExactlyOnceWith({
      drawingDelay: 400,
      origin: undefined,
      steps: 1,
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
    vi.advanceTimersByTime(4900);
    dispatchWebKitGesture(container, "gesturechange", {
      clientX: 200,
      clientY: 150,
      scale: 1.21,
    });

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
