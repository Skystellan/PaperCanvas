import type { PDFDocumentProxy } from "pdfjs-dist";
import "./pdfJsCompatibility";

export const PDF_MIN_ZOOM = 0.1;
export const PDF_MAX_ZOOM = 10;
export const PDF_ZOOM_DRAWING_DELAY_MS = 400;

const WEBKIT_DUPLICATE_WINDOW_MS = 500;
const WEBKIT_GESTURE_WATCHDOG_MS = 5000;
const MAX_CANVAS_PIXELS = 32 * 1024 * 1024;
const PDF_SCALE_ROUNDING = 100;
const PDF_ZOOM_STEP = 1.1;
const PDF_WHEEL_PIXELS_PER_TICK = 30;

interface WebKitGestureEvent extends Event {
  clientX?: number;
  clientY?: number;
  scale?: number;
}

interface FactorAccumulator {
  unusedFactor: number;
}

interface WebKitGestureState {
  accumulator: FactorAccumulator;
  origin: [number, number];
  previousEventScale: number;
  watchdogId: ReturnType<typeof setTimeout> | null;
}

interface TouchManagerLike {
  destroy(): void;
}

interface TouchManagerConstructor {
  new (options: {
    container: HTMLDivElement;
    onPinchEnd?: () => void;
    onPinching?: (
      origin: [number, number],
      previousDistance: number,
      distance: number,
    ) => void;
    onPinchStart?: () => void;
    signal: AbortSignal;
  }): TouchManagerLike;
}

export interface PdfViewerRuntime {
  readonly currentPage: number;
  readonly currentZoom: number;
  readonly pagesCount: number;
  destroy(): void;
  setPage(pageNumber: number): void;
  stepZoom(direction: -1 | 1): void;
  zoomTo(
    zoom: number,
    origin?: [number, number],
    drawingDelay?: number,
  ): void;
}

export interface CreatePdfViewerRuntimeOptions {
  abortSignal?: AbortSignal;
  container: HTMLDivElement;
  document: PDFDocumentProxy;
  onInteraction?: () => void;
  onPageChange?: (pageNumber: number) => void;
  onPageRendered?: (pageNumber: number) => void;
  onScaleChange?: (zoom: number) => void;
  viewer: HTMLDivElement;
}

export function clampPdfZoom(zoom: number): number {
  return Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, zoom));
}

/**
 * Carries PDF.js' two-decimal scale rounding into the next gesture event.
 * This is the algorithm used by the current official PDF.js viewer app.
 */
export function accumulatePdfScaleFactor(
  previousScale: number,
  factor: number,
  state: FactorAccumulator,
): number {
  if (
    factor === 1 ||
    !Number.isFinite(previousScale) ||
    previousScale <= 0 ||
    !Number.isFinite(factor) ||
    factor <= 0
  ) {
    return 1;
  }

  const target = clampPdfZoom(
    previousScale * factor * state.unusedFactor,
  );
  const nextScale =
    Math.round(target * PDF_SCALE_ROUNDING) / PDF_SCALE_ROUNDING;
  if (!Number.isFinite(nextScale) || nextScale <= 0) {
    state.unusedFactor = 1;
    return 1;
  }

  state.unusedFactor = target / nextScale;
  return nextScale / previousScale;
}

function calculatePdfStepScale(previousScale: number, steps: number): number {
  const delta = steps > 0 ? PDF_ZOOM_STEP : 1 / PDF_ZOOM_STEP;
  const round = steps > 0 ? Math.ceil : Math.floor;
  let nextScale = previousScale;
  for (let remaining = Math.abs(steps); remaining > 0; remaining -= 1) {
    nextScale =
      round(Number((nextScale * delta).toFixed(2)) * 10) / 10;
  }
  return nextScale;
}

function normalizeWheelEventDirection(event: WheelEvent): number {
  let delta = Math.hypot(event.deltaX, event.deltaY);
  const angle = Math.atan2(event.deltaY, event.deltaX);
  if (-0.25 * Math.PI < angle && angle < 0.75 * Math.PI) {
    delta = -delta;
  }
  return delta;
}

function eventOrigin(
  container: HTMLDivElement,
  clientX: number,
  clientY: number,
): [number, number] {
  const rect = container.getBoundingClientRect();
  return [
    clientX - rect.left + container.offsetLeft,
    clientY - rect.top + container.offsetTop,
  ];
}

function stableClientPoint(
  container: HTMLDivElement,
  clientX: number | undefined,
  clientY: number | undefined,
): [number, number] {
  if (
    Number.isFinite(clientX) &&
    Number.isFinite(clientY) &&
    (clientX !== 0 || clientY !== 0)
  ) {
    return [clientX!, clientY!];
  }
  const rect = container.getBoundingClientRect();
  return [
    rect.left + container.clientWidth / 2,
    rect.top + container.clientHeight / 2,
  ];
}

export async function createPdfViewerRuntime({
  abortSignal,
  container,
  document,
  onInteraction,
  onPageChange,
  onPageRendered,
  onScaleChange,
  viewer,
}: CreatePdfViewerRuntimeOptions): Promise<PdfViewerRuntime> {
  const abortController = new AbortController();
  const { signal } = abortController;
  if (abortSignal?.aborted) {
    abortController.abort();
    throw new DOMException("The PDF viewer runtime was aborted.", "AbortError");
  }

  type PdfJsRuntimeGlobal = {
    AnnotationEditorType: { DISABLE: number };
    AnnotationMode: { DISABLE: number };
    TouchManager: TouchManagerConstructor;
  };
  const globalWithPdfJs = globalThis as typeof globalThis & {
    pdfjsLib?: PdfJsRuntimeGlobal;
  };
  let pdfjsLib = globalWithPdfJs.pdfjsLib;
  if (!pdfjsLib) {
    const loadedPdfJs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsLib = loadedPdfJs as PdfJsRuntimeGlobal;
    globalWithPdfJs.pdfjsLib = pdfjsLib;
  }
  if (abortSignal?.aborted) {
    abortController.abort();
    throw new DOMException("The PDF viewer runtime was aborted.", "AbortError");
  }

  const { EventBus, PDFViewer } = await import(
    "pdfjs-dist/legacy/web/pdf_viewer.mjs"
  );
  if (abortSignal?.aborted) {
    abortController.abort();
    throw new DOMException("The PDF viewer runtime was aborted.", "AbortError");
  }

  const eventBus = new EventBus();
  const pdfViewer = new PDFViewer({
    abortSignal: signal,
    annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
    annotationMode: pdfjsLib.AnnotationMode.DISABLE,
    container,
    enableAutoLinking: false,
    eventBus,
    maxCanvasPixels: MAX_CANVAS_PIXELS,
    viewer,
  } as ConstructorParameters<typeof PDFViewer>[0]);

  let destroyed = false;
  let isPhysicalControlKeyDown = false;
  let lastWheelTime = Number.NEGATIVE_INFINITY;
  let ignoreWheelUntil = Number.NEGATIVE_INFINITY;
  let wheelUnusedTicks = 0;
  const wheelAccumulator: FactorAccumulator = { unusedFactor: 1 };
  const touchAccumulator: FactorAccumulator = { unusedFactor: 1 };
  let webkitGesture: WebKitGestureState | null = null;
  let touchManager: TouchManagerLike | null = null;

  const currentZoom = () => clampPdfZoom(pdfViewer.currentScale);

  const applyScaleFactor = (
    rawFactor: number,
    origin: [number, number],
    accumulator: FactorAccumulator,
  ) => {
    if (destroyed) return;
    const scaleFactor = accumulatePdfScaleFactor(
      pdfViewer.currentScale,
      rawFactor,
      accumulator,
    );
    if (scaleFactor === 1 || !Number.isFinite(scaleFactor)) return;
    pdfViewer.updateScale({
      drawingDelay: PDF_ZOOM_DRAWING_DELAY_MS,
      origin,
      scaleFactor,
    });
  };

  const applyZoom = (
    requestedZoom: number,
    origin?: [number, number],
    drawingDelay = PDF_ZOOM_DRAWING_DELAY_MS,
  ) => {
    if (destroyed || !Number.isFinite(requestedZoom)) return;
    const previousScale = pdfViewer.currentScale;
    const nextScale = clampPdfZoom(requestedZoom);
    if (previousScale <= 0 || nextScale === previousScale) return;
    pdfViewer.updateScale({
      drawingDelay,
      origin,
      scaleFactor: nextScale / previousScale,
    });
  };

  const applyZoomSteps = (steps: number, origin?: [number, number]) => {
    if (destroyed || !Number.isInteger(steps) || steps === 0) return;
    const previousScale = pdfViewer.currentScale;
    const steppedScale = calculatePdfStepScale(previousScale, steps);
    const nextScale = clampPdfZoom(steppedScale);
    if (previousScale <= 0 || nextScale === previousScale) return;
    if (nextScale !== steppedScale) {
      pdfViewer.updateScale({
        drawingDelay: PDF_ZOOM_DRAWING_DELAY_MS,
        origin,
        scaleFactor: nextScale / previousScale,
      });
      return;
    }
    pdfViewer.updateScale({
      drawingDelay: PDF_ZOOM_DRAWING_DELAY_MS,
      origin,
      steps,
    });
  };

  const accumulateWheelTicks = (ticks: number) => {
    if (
      (wheelUnusedTicks > 0 && ticks < 0) ||
      (wheelUnusedTicks < 0 && ticks > 0)
    ) {
      wheelUnusedTicks = 0;
    }
    wheelUnusedTicks += ticks;
    const wholeTicks = Math.trunc(wheelUnusedTicks);
    wheelUnusedTicks -= wholeTicks;
    return wholeTicks;
  };

  const refreshWebKitWatchdog = (gesture: WebKitGestureState) => {
    if (gesture.watchdogId !== null) clearTimeout(gesture.watchdogId);
    gesture.watchdogId = setTimeout(() => {
      if (webkitGesture !== gesture) return;
      gesture.watchdogId = null;
      webkitGesture = null;
    }, WEBKIT_GESTURE_WATCHDOG_MS);
  };

  const clearWebKitGesture = () => {
    if (!webkitGesture) return;
    if (webkitGesture.watchdogId !== null) {
      clearTimeout(webkitGesture.watchdogId);
    }
    webkitGesture = null;
  };

  const destroyRuntime = () => {
    if (destroyed) return;
    destroyed = true;
    clearWebKitGesture();
    touchManager?.destroy();
    touchManager = null;
    abortSignal?.removeEventListener("abort", destroyRuntime);
    abortController.abort();
    pdfViewer.setDocument(null as never);
  };
  abortSignal?.addEventListener("abort", destroyRuntime, { once: true });

  const handleControlKeyDown = (event: KeyboardEvent) => {
    isPhysicalControlKeyDown = event.key === "Control";
  };
  const handleControlKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Control") isPhysicalControlKeyDown = false;
  };
  const handleWindowBlur = () => {
    isPhysicalControlKeyDown = false;
  };

  const handleWheel = (event: WheelEvent) => {
    if (!(event.ctrlKey || event.metaKey) || destroyed) return;
    event.preventDefault();
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    const now = performance.now();
    if (now < ignoreWheelUntil || webkitGesture) return;

    onInteraction?.();
    lastWheelTime = now;
    const origin = eventOrigin(container, event.clientX, event.clientY);
    const deltaMode = event.deltaMode;
    const rawPinchFactor = Math.exp(-event.deltaY / 100);
    const isTrackpadPinch =
      event.ctrlKey &&
      !isPhysicalControlKeyDown &&
      deltaMode === WheelEvent.DOM_DELTA_PIXEL &&
      event.deltaX === 0 &&
      event.deltaZ === 0 &&
      Math.abs(rawPinchFactor - 1) < 0.05;

    if (isTrackpadPinch) {
      applyScaleFactor(rawPinchFactor, origin, wheelAccumulator);
      return;
    }

    const delta = normalizeWheelEventDirection(event);
    const ticks =
      deltaMode === WheelEvent.DOM_DELTA_LINE ||
      deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? Math.abs(delta) >= 1
          ? Math.sign(delta)
          : accumulateWheelTicks(delta)
        : accumulateWheelTicks(delta / PDF_WHEEL_PIXELS_PER_TICK);
    applyZoomSteps(ticks, origin);
  };

  const handleGestureStart = (event: WebKitGestureEvent) => {
    event.preventDefault();
    if (destroyed) return;
    clearWebKitGesture();
    if (performance.now() - lastWheelTime < WEBKIT_DUPLICATE_WINDOW_MS) return;

    onInteraction?.();
    const [clientX, clientY] = stableClientPoint(
      container,
      event.clientX,
      event.clientY,
    );
    const gesture: WebKitGestureState = {
      accumulator: { unusedFactor: 1 },
      origin: eventOrigin(container, clientX, clientY),
      previousEventScale: 1,
      watchdogId: null,
    };
    webkitGesture = gesture;
    refreshWebKitWatchdog(gesture);
  };

  const handleGestureChange = (event: WebKitGestureEvent) => {
    event.preventDefault();
    const gesture = webkitGesture;
    const scale = event.scale;
    if (!gesture || !Number.isFinite(scale) || !scale || scale <= 0) return;

    refreshWebKitWatchdog(gesture);
    const rawFactor = scale / gesture.previousEventScale;
    gesture.previousEventScale = scale;
    const [clientX, clientY] = stableClientPoint(
      container,
      event.clientX,
      event.clientY,
    );
    gesture.origin = eventOrigin(container, clientX, clientY);
    applyScaleFactor(rawFactor, gesture.origin, gesture.accumulator);
  };

  const handleGestureEnd = (event: WebKitGestureEvent) => {
    event.preventDefault();
    if (!webkitGesture) return;
    clearWebKitGesture();
    ignoreWheelUntil = performance.now() + WEBKIT_DUPLICATE_WINDOW_MS;
  };

  const handleGestureCancel = (event: WebKitGestureEvent) => {
    event.preventDefault();
    if (!webkitGesture) return;
    clearWebKitGesture();
    ignoreWheelUntil = performance.now() + WEBKIT_DUPLICATE_WINDOW_MS;
  };

  eventBus.on(
    "pagechanging",
    ({ pageNumber }: { pageNumber: number }) => onPageChange?.(pageNumber),
    { signal },
  );
  eventBus.on(
    "scalechanging",
    ({ scale }: { scale: number }) => onScaleChange?.(clampPdfZoom(scale)),
    { signal },
  );
  eventBus.on(
    "pagerendered",
    ({ pageNumber }: { pageNumber: number }) => onPageRendered?.(pageNumber),
    { signal },
  );
  eventBus.on(
    "pagesinit",
    () => {
      if (!destroyed) pdfViewer.currentScale = 1;
    },
    { signal },
  );

  container.addEventListener("wheel", handleWheel, { passive: false, signal });
  container.addEventListener("gesturestart", handleGestureStart as EventListener, {
    passive: false,
    signal,
  });
  container.addEventListener(
    "gesturechange",
    handleGestureChange as EventListener,
    { passive: false, signal },
  );
  container.addEventListener("gestureend", handleGestureEnd as EventListener, {
    passive: false,
    signal,
  });
  container.addEventListener(
    "gesturecancel",
    handleGestureCancel as EventListener,
    { passive: false, signal },
  );
  globalThis.document.addEventListener("keydown", handleControlKeyDown, {
    signal,
  });
  globalThis.document.addEventListener("keyup", handleControlKeyUp, { signal });
  globalThis.window.addEventListener("blur", handleWindowBlur, { signal });

  touchManager = new pdfjsLib.TouchManager({
    container,
    onPinchEnd: () => {
      touchAccumulator.unusedFactor = 1;
    },
    onPinching: (origin, previousDistance, distance) => {
      onInteraction?.();
      applyScaleFactor(
        distance / previousDistance,
        origin,
        touchAccumulator,
      );
    },
    onPinchStart: onInteraction,
    signal,
  });

  try {
    pdfViewer.setDocument(document);
    const runtimeAborted = new Promise<never>((_resolve, reject) => {
      const rejectAbort = () =>
        reject(
          new DOMException("The PDF viewer runtime was aborted.", "AbortError"),
        );
      if (signal.aborted) rejectAbort();
      else signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const documentReady = pdfViewer.pagesPromise ?? pdfViewer.firstPagePromise;
    if (!documentReady) {
      throw new Error("PDF.js did not expose a document readiness promise.");
    }
    await Promise.race([documentReady, runtimeAborted]);
    if (destroyed) {
      throw new Error("The PDF viewer runtime was destroyed while loading.");
    }
    pdfViewer.currentScale = 1;
    onPageChange?.(pdfViewer.currentPageNumber);
    onScaleChange?.(currentZoom());
  } catch (error) {
    destroyRuntime();
    throw error;
  }

  return {
    get currentPage() {
      return pdfViewer.currentPageNumber;
    },
    get currentZoom() {
      return currentZoom();
    },
    destroy() {
      destroyRuntime();
    },
    get pagesCount() {
      return pdfViewer.pagesCount;
    },
    setPage(pageNumber) {
      if (destroyed || !Number.isFinite(pageNumber)) return;
      pdfViewer.currentPageNumber = Math.min(
        pdfViewer.pagesCount,
        Math.max(1, Math.trunc(pageNumber)),
      );
    },
    stepZoom(direction) {
      if (destroyed) return;
      wheelUnusedTicks = 0;
      wheelAccumulator.unusedFactor = 1;
      touchAccumulator.unusedFactor = 1;
      clearWebKitGesture();
      applyZoomSteps(direction);
    },
    zoomTo(zoom, origin, drawingDelay) {
      wheelUnusedTicks = 0;
      wheelAccumulator.unusedFactor = 1;
      touchAccumulator.unusedFactor = 1;
      clearWebKitGesture();
      applyZoom(zoom, origin, drawingDelay);
    },
  };
}
