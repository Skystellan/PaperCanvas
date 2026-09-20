import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PdfReadingLocation } from "./model/readerState";
import "./pdfJsCompatibility";
import {
  capturePdfZoomPreviewPages,
  clearPdfZoomPreviewPages,
  type PdfZoomPreviewPage,
} from "./pdfZoomPreview";

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
  setPage(pageNumber: number, offset?: number): void;
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
  initialLocation?: PdfReadingLocation;
  onLocationChange?: (location: PdfReadingLocation) => void;
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
  initialLocation,
  onLocationChange,
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
  let locationReady = false;
  let closingZoom: number | undefined;
  let locationTimer: ReturnType<typeof setTimeout> | null = null;
  let locationPage = initialLocation?.pageNumber ?? 1;
  let navigationSequence = 0;
  let isPhysicalControlKeyDown = false;
  let lastWheelTime = Number.NEGATIVE_INFINITY;
  let ignoreWheelUntil = Number.NEGATIVE_INFINITY;
  let wheelUnusedTicks = 0;
  const wheelAccumulator: FactorAccumulator = { unusedFactor: 1 };
  const touchAccumulator: FactorAccumulator = { unusedFactor: 1 };
  let webkitGesture: WebKitGestureState | null = null;
  let touchManager: TouchManagerLike | null = null;
  let zoomFrameId: number | null = null;
  let zoomCommitId: ReturnType<typeof setTimeout> | null = null;
  let pendingZoom: {
    zoom: number;
    previewZoom: number;
    origin?: [number, number];
    drawingDelay: number;
    layers: PdfZoomPreviewPage[];
    anchor?: { element: HTMLDivElement; x: number; y: number };
    point: [number, number];
    translation: [number, number];
    scrollLeft: number;
    scrollTop: number;
  } | null = null;

  const currentZoom = () =>
    clampPdfZoom(pendingZoom?.zoom ?? pdfViewer.currentScale);

  const reportLocation = () => {
    if (locationTimer !== null) clearTimeout(locationTimer);
    locationTimer = null;
    if (destroyed || !locationReady || !onLocationChange || pendingZoom) return;
    const bounds = pdfViewer.getPageView(locationPage - 1)?.div.getBoundingClientRect();
    if (!bounds || bounds.height <= 0) return;
    onLocationChange({
      pageNumber: locationPage,
      offset: Math.min(1, Math.max(0, (container.getBoundingClientRect().top - bounds.top) / bounds.height)),
      zoom: closingZoom ?? currentZoom(),
    });
  };
  const scheduleLocation = () => {
    if (destroyed || !locationReady || !onLocationChange) return;
    if (locationTimer !== null) clearTimeout(locationTimer);
    locationTimer = setTimeout(reportLocation, 150);
  };

  const navigate = async (pageNumber: number, offset?: number) => {
    const sequence = ++navigationSequence;
    const page = Math.min(pdfViewer.pagesCount, Math.max(1, Math.trunc(pageNumber)));
    const pageView = pdfViewer.getPageView(page - 1);
    // Only fetch the destination. pagesPromise can await every page in a large PDF.
    if (offset !== undefined && pageView && !pageView.pdfPage) {
      const pdfPage = await document.getPage(page);
      if (destroyed || sequence !== navigationSequence) return;
      if (!pageView.pdfPage) pageView.setPdfPage(pdfPage);
    }
    if (destroyed || sequence !== navigationSequence) return;
    pdfViewer.currentPageNumber = page;
    locationPage = page;
    if (offset !== undefined && pageView) {
      const bounds = pageView.div.getBoundingClientRect();
      container.scrollTop += bounds.top - container.getBoundingClientRect().top + bounds.height * offset;
    }
    if (locationReady) onLocationChange?.({ pageNumber: page, offset: offset ?? 0, zoom: currentZoom() });
  };

  const cancelPendingZoom = () => {
    if (zoomFrameId !== null) cancelAnimationFrame(zoomFrameId);
    if (zoomCommitId !== null) clearTimeout(zoomCommitId);
    zoomFrameId = null;
    zoomCommitId = null;
    if (pendingZoom) clearPdfZoomPreviewPages(pendingZoom.layers);
    pendingZoom = null;
  };

  const flushPendingZoom = () => {
    const pending = pendingZoom;
    if (!pending || destroyed) return;
    const targetX = pending.point[0] - (container.scrollLeft - pending.scrollLeft);
    const targetY = pending.point[1] - (container.scrollTop - pending.scrollTop);
    cancelPendingZoom();
    if (pending.zoom !== pdfViewer.currentScale) {
      // The interaction already supplied the delay. PDF.js keeps its old canvas
      // while rendering the final scale; a second drawingDelay adds another
      // full-document refresh and leaves the text layer hidden longer.
      pdfViewer.updateScale({
        drawingDelay: -1,
        origin: pending.origin,
        scaleFactor: pending.zoom / pdfViewer.currentScale,
      });
    }
    if (pending.anchor) {
      // Page margins and centering do not scale with PDF.js. Preserve the same
      // page-local point, including scrolls and moving pinch origins in preview.
      const { element, x, y } = pending.anchor;
      const rect = element.getBoundingClientRect();
      container.scrollLeft += rect.left + x * rect.width - targetX;
      container.scrollTop += rect.top + y * rect.height - targetY;
    }
    onScaleChange?.(currentZoom());
  };

  const scheduleZoomCommit = () => {
    if (zoomCommitId !== null) clearTimeout(zoomCommitId);
    if (pendingZoom) {
      zoomCommitId = setTimeout(flushPendingZoom, pendingZoom.drawingDelay);
    }
  };

  const applyZoom = (
    requestedZoom: number,
    origin?: [number, number],
    drawingDelay = PDF_ZOOM_DRAWING_DELAY_MS,
    previewZoom?: number,
  ) => {
    if (destroyed || !Number.isFinite(requestedZoom)) return;
    const nextScale =
      Math.round(clampPdfZoom(requestedZoom) * PDF_SCALE_ROUNDING) /
      PDF_SCALE_ROUNDING;
    const nextPreviewScale = clampPdfZoom(previewZoom ?? nextScale);
    if (pdfViewer.currentScale <= 0) return;
    if (
      nextScale === currentZoom() &&
      nextPreviewScale === (pendingZoom?.previewZoom ?? pdfViewer.currentScale)
    ) {
      if (pendingZoom) pendingZoom.drawingDelay = drawingDelay;
      scheduleZoomCommit();
      return;
    }
    const bounds = container.getBoundingClientRect();
    const clientX = bounds.left + (
      origin ? origin[0] - container.offsetLeft : container.clientWidth / 2
    );
    const clientY = bounds.top + (
      origin ? origin[1] - container.offsetTop : container.clientHeight / 2
    );
    if (!pendingZoom) {
      const hitPage = globalThis.document.elementFromPoint?.(clientX, clientY)
        ?.closest<HTMLDivElement>(".page");
      const anchorElement = hitPage && viewer.contains(hitPage)
        ? hitPage
        : pdfViewer.getPageView(pdfViewer.currentPageNumber - 1)?.div;
      const rect = anchorElement?.getBoundingClientRect();
      pendingZoom = {
        zoom: pdfViewer.currentScale,
        previewZoom: pdfViewer.currentScale,
        drawingDelay,
        layers: capturePdfZoomPreviewPages([viewer]),
        anchor: anchorElement && rect && rect.width > 0 && rect.height > 0
          ? {
            element: anchorElement,
            x: (clientX - rect.left) / rect.width,
            y: (clientY - rect.top) / rect.height,
          }
          : undefined,
        point: [clientX, clientY],
        translation: [0, 0],
        scrollLeft: container.scrollLeft,
        scrollTop: container.scrollTop,
      };
    }
    const pending = pendingZoom;
    const factor = nextPreviewScale / pending.previewZoom;
    const dx = container.scrollLeft - pending.scrollLeft;
    const dy = container.scrollTop - pending.scrollTop;
    const layer = pending.layers[0];
    if (layer) {
      pending.translation[0] = factor * pending.translation[0] +
        (1 - factor) * (clientX - layer.left + dx);
      pending.translation[1] = factor * pending.translation[1] +
        (1 - factor) * (clientY - layer.top + dy);
    }
    pending.point[0] = factor * pending.point[0] + (1 - factor) * (clientX + dx);
    pending.point[1] = factor * pending.point[1] + (1 - factor) * (clientY + dy);
    pending.zoom = nextScale;
    pending.previewZoom = nextPreviewScale;
    pending.origin = origin;
    pending.drawingDelay = drawingDelay;
    // Transform one existing layer, including canvas, highlights and text. No
    // PDF.js page updates, layout measurements or page scans in the RAF path.
    if (zoomFrameId === null) {
      zoomFrameId = requestAnimationFrame(() => {
        if (destroyed || pendingZoom !== pending) return;
        zoomFrameId = null;
        if (pending.layers.length) {
          const [x, y] = pending.translation;
          viewer.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${pending.previewZoom / pdfViewer.currentScale})`;
        }
        onScaleChange?.(pending.zoom);
        if (pending.drawingDelay <= 0) flushPendingZoom();
      });
    }
    if (drawingDelay > 0) scheduleZoomCommit();
  };

  const applyScaleFactor = (
    rawFactor: number,
    origin: [number, number],
    accumulator: FactorAccumulator,
  ) => {
    if (destroyed) return;
    const previousScale = currentZoom();
    const scaleFactor = accumulatePdfScaleFactor(
      previousScale,
      rawFactor,
      accumulator,
    );
    if (!Number.isFinite(scaleFactor)) return;
    // Keep the rounding remainder in the visual transform so small pinch
    // deltas move continuously, even while the reported PDF.js scale is 1.00.
    applyZoom(
      previousScale * scaleFactor,
      origin,
      PDF_ZOOM_DRAWING_DELAY_MS,
      previousScale * scaleFactor * accumulator.unusedFactor,
    );
  };

  const applyZoomSteps = (steps: number, origin?: [number, number]) => {
    if (destroyed || !Number.isInteger(steps) || steps === 0) return;
    applyZoom(calculatePdfStepScale(currentZoom(), steps), origin);
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
      flushPendingZoom();
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
    closingZoom = currentZoom();
    cancelPendingZoom();
    reportLocation();
    destroyed = true;
    cancelPendingZoom();
    clearWebKitGesture();
    touchManager?.destroy();
    touchManager = null;
    abortSignal?.removeEventListener("abort", destroyRuntime);
    abortController.abort();
    pdfViewer.setDocument(null as never);
  };
  abortSignal?.addEventListener("abort", destroyRuntime, { once: true });

  const handleControlKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Control") isPhysicalControlKeyDown = true;
  };
  const handleControlKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Control") isPhysicalControlKeyDown = false;
  };
  const handleWindowBlur = () => {
    isPhysicalControlKeyDown = false;
    clearWebKitGesture();
    flushPendingZoom();
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
    // Chromium's synthetic Ctrl wheel remains a pinch at high velocity too.
    // A magnitude cutoff turns fast pinches into stalled, discrete wheel ticks.
    const isTrackpadPinch =
      event.ctrlKey &&
      !isPhysicalControlKeyDown &&
      deltaMode === WheelEvent.DOM_DELTA_PIXEL &&
      event.deltaX === 0 &&
      event.deltaZ === 0;

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
    flushPendingZoom();
    ignoreWheelUntil = performance.now() + WEBKIT_DUPLICATE_WINDOW_MS;
  };

  const handleGestureCancel = (event: WebKitGestureEvent) => {
    event.preventDefault();
    if (!webkitGesture) return;
    clearWebKitGesture();
    flushPendingZoom();
    ignoreWheelUntil = performance.now() + WEBKIT_DUPLICATE_WINDOW_MS;
  };

  eventBus.on(
    "updateviewarea",
    () => {
      if (!locationReady) return;
      // PDF.js location.pageNumber is the first partly visible page, which can
      // differ from its current page (notably at the bottom of the document).
      locationPage = pdfViewer.currentPageNumber;
      scheduleLocation();
    },
    { signal },
  );
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
      if (!destroyed) pdfViewer.currentScale = initialLocation?.zoom ?? 1;
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
  globalThis.window.addEventListener("pagehide", reportLocation, { signal });

  touchManager = new pdfjsLib.TouchManager({
    container,
    onPinchEnd: () => {
      flushPendingZoom();
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
    const documentReady = pdfViewer.firstPagePromise;
    if (!documentReady) {
      throw new Error("PDF.js did not expose a document readiness promise.");
    }
    await Promise.race([documentReady, runtimeAborted]);
    if (destroyed) {
      throw new Error("The PDF viewer runtime was destroyed while loading.");
    }
    pdfViewer.currentScale = initialLocation?.zoom ?? 1;
    if (initialLocation) await Promise.race([navigate(initialLocation.pageNumber, initialLocation.offset), runtimeAborted]);
    locationReady = true;
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
    setPage(pageNumber, offset) {
      if (destroyed || !Number.isFinite(pageNumber)) return;
      flushPendingZoom();
      void navigate(pageNumber, offset).then(scheduleLocation).catch(() => undefined);
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
