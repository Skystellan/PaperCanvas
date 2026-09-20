import type { PdfReadingLocation } from "./model/readerState";
import type { NoteCitation } from "./model/noteCitation";
import { BaseDirectory, readFile } from "../../platform/fs";
import {
  type CSSProperties,
  type RefCallback,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { PdfSelectionPopover } from "./PdfSelectionPopover";
import {
  normalizePdfClientRects,
  mergeNormalizedPdfRects,
  type PdfHighlight,
} from "./model/pdfHighlight";
import {
  isSupportedPdfPageCount,
  MAX_PDF_SELECTION_RECTS,
  MAX_PDF_SELECTION_TEXT_BYTES,
  truncateUtf8,
} from "./model/pdfLimits";
import type {
  PdfSelectionActions,
  PdfTextSelection,
} from "./model/pdfSelection";
import {
  createPdfViewerRuntime,
  PDF_MAX_ZOOM,
  PDF_MIN_ZOOM,
  type PdfViewerRuntime,
} from "./pdfViewerRuntime";
import {
  capturePdfZoomPreviewPages,
  clearPdfZoomPreviewPages,
  paintPdfZoomPreviewPages,
  type PdfZoomPreviewPage,
} from "./pdfZoomPreview";
import "pdfjs-dist/legacy/web/pdf_viewer.css";
import "./reader.css";

export type {
  PdfSelectionActions,
  PdfSelectionAnchor,
  PdfSelectionNoteRequest,
  PdfTextSelection,
} from "./model/pdfSelection";

const MIN_ZOOM = PDF_MIN_ZOOM;
const MAX_ZOOM = PDF_MAX_ZOOM;
const ZOOM_STEP_FACTOR = 1.1;
const ZOOM_RENDER_SETTLE_MS = 400;
const INPUT_STREAM_DUPLICATE_WINDOW_MS = 500;
const ZOOM_PREVIEW_PAGE_OVERSCAN = 4;
const MAX_PAGE_CANVAS_BYTES = 128 * 1024 * 1024;
// Unit tests use a lightweight document double that cannot instantiate the
// real PDF.js viewer. Production must always use the official viewer runtime.
const ENABLE_TEST_ONLY_PDF_RENDERER = import.meta.env.MODE === "test";

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function quantizeZoom(value: number): number {
  return clampZoom(Math.round(clampZoom(value) * 100) / 100);
}

function trackpadZoomFactor(event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
    return Math.exp(-event.deltaY / 100);
  }
  const steps =
    event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? -Math.sign(event.deltaY)
      : Math.max(-10, Math.min(10, -event.deltaY));
  return 1.1 ** steps;
}

interface WebKitGestureEvent extends Event {
  clientX?: number;
  clientY?: number;
  scale?: number;
}

type ZoomPreviewSource = "toolbar" | "trackpad" | "webkit";

interface ZoomPreview {
  anchorPageNumber: number | null;
  anchorPageX: number;
  anchorPageY: number;
  pointerClientX: number;
  pointerClientY: number;
  pointerX: number;
  pointerY: number;
  previewPages: PdfZoomPreviewPage[];
  rawTargetZoom: number;
  scrollLeft: number;
  scrollTop: number;
  source: ZoomPreviewSource;
  startZoom: number;
  targetZoom: number;
}

function rectDistanceSquared(
  rect: Pick<PdfZoomPreviewPage, "bottom" | "left" | "right" | "top">,
  clientX: number,
  clientY: number,
) {
  const deltaX =
    clientX < rect.left
      ? rect.left - clientX
      : clientX > rect.right
        ? clientX - rect.right
        : 0;
  const deltaY =
    clientY < rect.top
      ? rect.top - clientY
      : clientY > rect.bottom
        ? clientY - rect.bottom
        : 0;
  return deltaX * deltaX + deltaY * deltaY;
}

export interface PdfViewportLike {
  height: number;
  scale?: number;
  width: number;
}

export interface PdfRenderTaskLike {
  promise: Promise<unknown>;
  cancel(): void;
}

export interface PdfTextLayerTaskLike {
  promise: Promise<unknown>;
  cancel(): void;
}

export interface PdfPageLike {
  getTextContent(): Promise<{ items: unknown[] }>;
  getViewport(options: { scale: number }): PdfViewportLike;
  render(options: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewportLike;
    transform?: number[];
  }): PdfRenderTaskLike;
  renderTextLayer(options: {
    container: HTMLElement;
    viewport: PdfViewportLike;
  }): PdfTextLayerTaskLike;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy(): Promise<void> | void;
  viewerDocument?: unknown;
}

export interface PdfLoadingTaskLike {
  promise: Promise<PdfDocumentLike>;
  destroy(): Promise<void> | void;
}

export interface PdfJsAdapter {
  getDocument(options: { data: Uint8Array }): PdfLoadingTaskLike;
}

export type PdfFileReader = (
  path: string,
  options: { baseDir: BaseDirectory },
) => Promise<Uint8Array>;

export interface PdfViewerProps {
  filePath: string | null;
  initialLocation?: PdfReadingLocation;
  onLocationChange?: (location: PdfReadingLocation) => void;
  navigationTarget?: NoteCitation | null;
  focusedHighlightId?: string | null;
  highlights?: PdfHighlight[];
  pdfJs?: PdfJsAdapter;
  readPdfFile?: PdfFileReader;
  selectionActions?: PdfSelectionActions;
  viewerRuntimeFactory?: typeof createPdfViewerRuntime;
}

interface PdfSelectionHighlight {
  height: number;
  left: number;
  top: number;
  width: number;
}

interface ActivePdfTextSelection {
  highlights: PdfSelectionHighlight[];
  selection: PdfTextSelection;
}

interface PdfPageCanvasProps {
  displayScale: number;
  document: PdfDocumentLike;
  focusedHighlightId?: string | null;
  highlights: PdfHighlight[];
  pageNumber: number;
  renderScale: number;
  registerPage: (pageNumber: number) => RefCallback<HTMLDivElement>;
  onVisible: (pageNumber: number) => void;
  onTextSelection: (selection: ActivePdfTextSelection) => void;
}

async function loadDefaultPdfJs(): Promise<PdfJsAdapter> {
  const module = await import("./pdfJsAdapter");
  return module.browserPdfJsAdapter;
}

function ignoreCleanupFailure(value: Promise<void> | void): void {
  void Promise.resolve(value).catch(() => undefined);
}

function getCanvasMetrics(page: PdfPageLike, scale: number) {
  const viewport = page.getViewport({ scale });
  const deviceScale = globalThis.devicePixelRatio;
  const outputScale =
    Number.isFinite(deviceScale) && deviceScale > 1 ? deviceScale : 1;
  const outputWidth = Math.floor(viewport.width * outputScale);
  const outputHeight = Math.floor(viewport.height * outputScale);
  const outputBytes = outputWidth * outputHeight * 4;

  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    !Number.isSafeInteger(outputWidth) ||
    !Number.isSafeInteger(outputHeight) ||
    outputWidth <= 0 ||
    outputHeight <= 0 ||
    !Number.isSafeInteger(outputBytes) ||
    outputBytes > MAX_PAGE_CANVAS_BYTES
  ) {
    throw new RangeError("PDF page canvas exceeds the local rendering limit.");
  }

  return { outputHeight, outputScale, outputWidth, viewport };
}

function PdfPageCanvas({
  displayScale,
  document,
  focusedHighlightId,
  highlights,
  onVisible,
  onTextSelection,
  pageNumber,
  registerPage,
  renderScale,
}: PdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [page, setPage] = useState<PdfPageLike | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(pageNumber === 1);
  const [renderError, setRenderError] = useState(false);
  const [renderedTextScale, setRenderedTextScale] = useState<number | null>(null);

  const setWrapperRef = useCallback<RefCallback<HTMLDivElement>>(
    (element) => {
      wrapperRef.current = element;
      registerPage(pageNumber)(element);
    },
    [pageNumber, registerPage],
  );

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) onVisible(pageNumber);
      },
      { threshold: 0.1 },
    );
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [onVisible, pageNumber]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof IntersectionObserver === "undefined") {
      setIsNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => setIsNearViewport(entry?.isIntersecting === true),
      { rootMargin: "1200px 0px", threshold: 0 },
    );
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isNearViewport || page) return;

    let active = true;
    void document
      .getPage(pageNumber)
      .then((loadedPage) => {
        if (active) setPage(loadedPage);
      })
      .catch(() => {
        if (active) setRenderError(true);
      });

    return () => {
      active = false;
    };
  }, [document, isNearViewport, page, pageNumber]);

  useEffect(() => {
    const visibleCanvas = canvasRef.current;
    if (!visibleCanvas || !page || !isNearViewport) {
      if (visibleCanvas) {
        visibleCanvas.width = 0;
        visibleCanvas.height = 0;
      }
      return;
    }

    let active = true;
    let renderTask: PdfRenderTaskLike | undefined;
    const reportRenderError = () => {
      queueMicrotask(() => {
        if (active) setRenderError(true);
      });
    };
    setRenderError(false);
    const stagedCanvas = globalThis.document.createElement("canvas");
    const stagedContext = stagedCanvas.getContext("2d");
    if (!stagedContext) {
      reportRenderError();
      return () => {
        active = false;
      };
    }

    try {
      const { outputHeight, outputScale, outputWidth, viewport } =
        getCanvasMetrics(page, renderScale);
      stagedCanvas.width = outputWidth;
      stagedCanvas.height = outputHeight;
      const transform =
        outputScale === 1
          ? undefined
          : [outputScale, 0, 0, outputScale, 0, 0];
      renderTask = page.render({
        canvas: stagedCanvas,
        canvasContext: stagedContext,
        transform,
        viewport,
      });
      void renderTask.promise.then(
        () => {
          if (!active) return;
          const visibleContext = visibleCanvas.getContext("2d");
          if (!visibleContext) {
            setRenderError(true);
            return;
          }
          visibleCanvas.width = outputWidth;
          visibleCanvas.height = outputHeight;
          visibleContext.drawImage?.(stagedCanvas, 0, 0);
        },
        () => {
          if (active) setRenderError(true);
        },
      );
    } catch {
      reportRenderError();
    }

    return () => {
      active = false;
      renderTask?.cancel();
      stagedCanvas.width = 0;
      stagedCanvas.height = 0;
    };
  }, [isNearViewport, page, renderScale]);

  useEffect(() => {
    const container = textLayerRef.current;
    if (!container || !page || !isNearViewport) {
      container?.replaceChildren();
      return;
    }

    let active = true;
    let textLayerTask: PdfTextLayerTaskLike | undefined;
    const stagedContainer = globalThis.document.createElement("div");
    try {
      const viewport = page.getViewport({ scale: renderScale });
      textLayerTask = page.renderTextLayer({ container: stagedContainer, viewport });
      void textLayerTask.promise.then(
        () => {
          if (!active) return;
          container.replaceChildren(...stagedContainer.childNodes);
          setRenderedTextScale(renderScale);
        },
        () => {
          if (active) container.replaceChildren();
        },
      );
    } catch {
      container.replaceChildren();
    }

    return () => {
      active = false;
      textLayerTask?.cancel();
      stagedContainer.replaceChildren();
    };
  }, [isNearViewport, page, renderScale]);

  let viewport: PdfViewportLike = {
    height: 800 * displayScale,
    width: 600 * displayScale,
  };
  if (page) {
    try {
      viewport = page.getViewport({ scale: displayScale });
    } catch {
      // The rendering effect reports the page-level error.
    }
  }
  const pageStyle = {
    height: viewport.height,
    width: viewport.width,
    "--scale-round-x": "1px",
    "--scale-round-y": "1px",
    "--total-scale-factor":
      typeof viewport.scale === "number" && Number.isFinite(viewport.scale)
        ? viewport.scale
        : displayScale,
  } as CSSProperties;

  const captureTextSelection = useCallback(() => {
    const selection = window.getSelection();
    const text = selection
      ? truncateUtf8(selection.toString(), MAX_PDF_SELECTION_TEXT_BYTES)
          .replace(/\s+/g, " ")
          .trim()
      : "";
    if (!selection || selection.isCollapsed || !text) return;
    const layerBounds = textLayerRef.current?.getBoundingClientRect();
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
    const selectionLayer = textLayerRef.current;
    if (
      !selectionLayer ||
      !layerBounds ||
      (range?.startContainer && !selectionLayer.contains(range.startContainer)) ||
      (range?.endContainer && !selectionLayer.contains(range.endContainer))
    ) {
      return;
    }
    const rangeBounds = range?.getBoundingClientRect();
    const bounds =
      rangeBounds &&
      Number.isFinite(rangeBounds.left) &&
      Number.isFinite(rangeBounds.right) &&
      Number.isFinite(rangeBounds.bottom)
        ? rangeBounds
        : layerBounds;
    if (!bounds) return;
    const clientRects: DOMRect[] = [];
    if (range && typeof range.getClientRects === "function") {
      const rectList = range.getClientRects();
      const rectCount = Math.min(rectList.length, MAX_PDF_SELECTION_RECTS);
      for (let index = 0; index < rectCount; index += 1) {
        const rect = rectList[index];
        if (rect) clientRects.push(rect);
      }
    }
    const highlightBounds = (clientRects.length > 0 ? clientRects : [bounds])
      .filter(
        (rect) =>
          Number.isFinite(rect.left) &&
          Number.isFinite(rect.top) &&
          Number.isFinite(rect.width) &&
          Number.isFinite(rect.height) &&
          rect.width > 0 &&
          rect.height > 0,
      )
      .map(({ height, left, top, width }) => ({ height, left, top, width }));
    const normalizedRects = normalizePdfClientRects(layerBounds, highlightBounds);
    if (normalizedRects.length === 0) return;
    const clippedHighlightBounds = normalizedRects.map((rect) => ({
      height: rect.height * layerBounds.height,
      left: layerBounds.left + rect.left * layerBounds.width,
      top: layerBounds.top + rect.top * layerBounds.height,
      width: rect.width * layerBounds.width,
    }));
    onTextSelection({
      highlights: clippedHighlightBounds,
      selection: {
        anchor: {
          x: bounds.left + bounds.width / 2,
          y: bounds.bottom,
        },
        pageNumber,
        rects: normalizedRects,
        text,
      },
    });
  }, [onTextSelection, pageNumber]);

  return (
    <div
      className="pdf-viewer__page"
      data-page-number={pageNumber}
      data-testid="pdf-page"
      ref={setWrapperRef}
      style={pageStyle}
    >
      <canvas
        aria-label={`PDF page ${pageNumber}`}
        ref={canvasRef}
        role="img"
        style={{ height: viewport.height, width: viewport.width }}
      />
      <div aria-hidden="true" className="pdf-viewer__persisted-highlights">
        {highlights.flatMap((highlight) =>
          mergeNormalizedPdfRects(highlight.rects, viewport.width, viewport.height).map((rect, index) => (
            <span
              className={focusedHighlightId === highlight.id ? "is-focused" : undefined}
              data-testid={`pdf-persisted-highlight-${highlight.id}`}
              key={`${highlight.id}:${index}`}
              style={{
                height: `${rect.height * 100}%`,
                left: `${rect.left * 100}%`,
                top: `${rect.top * 100}%`,
                width: `${rect.width * 100}%`,
              }}
            />
          )),
        )}
      </div>
      <div
        aria-label={`Selectable text for PDF page ${pageNumber}`}
        className={`pdf-viewer__text-layer${
          renderedTextScale === displayScale ? "" : " is-zoom-preview"
        }`}
        data-testid={`pdf-text-layer-${pageNumber}`}
        onMouseUp={captureTextSelection}
        ref={textLayerRef}
      />
      {renderError && (
        <p className="pdf-viewer__page-error" role="alert">
          Page {pageNumber} could not be rendered.
        </p>
      )}
    </div>
  );
}

export function PdfViewer({
  filePath,
  initialLocation,
  onLocationChange,
  navigationTarget,
  focusedHighlightId,
  highlights = [],
  pdfJs,
  readPdfFile = readFile,
  selectionActions,
  viewerRuntimeFactory = createPdfViewerRuntime,
}: PdfViewerProps) {
  if (!filePath) {
    return (
      <section className="pdf-viewer pdf-viewer--empty" aria-label="PDF viewer">
        <p role="alert">This legacy paper has no local PDF.</p>
      </section>
    );
  }

  return (
    <PdfViewerFile
      filePath={filePath}
      initialLocation={initialLocation}
      onLocationChange={onLocationChange}
      navigationTarget={navigationTarget}
      focusedHighlightId={focusedHighlightId}
      highlights={highlights}
      key={filePath}
      pdfJs={pdfJs}
      readPdfFile={readPdfFile}
      selectionActions={selectionActions}
      viewerRuntimeFactory={viewerRuntimeFactory}
    />
  );
}

function syncOfficialHighlightLayers(
  viewer: HTMLDivElement,
  highlightsByPage: ReadonlyMap<number, readonly PdfHighlight[]>,
  focusedHighlightId?: string | null,
  renderedPageNumber?: number,
): void {
  const pages = renderedPageNumber
    ? [
        viewer.querySelector<HTMLElement>(
          `.page[data-page-number="${renderedPageNumber}"]`,
        ),
      ].filter((page): page is HTMLElement => page !== null)
    : Array.from(
        viewer.querySelectorAll<HTMLElement>(".page[data-page-number]"),
      );
  for (const page of pages) {
    const pageNumber = Number(page.dataset.pageNumber);
    const canvasWrapper = page.querySelector<HTMLElement>(".canvasWrapper");
    if (!canvasWrapper || !Number.isSafeInteger(pageNumber)) continue;

    let layer = canvasWrapper.querySelector<HTMLElement>(
      ":scope > .pdf-viewer__persisted-highlights",
    );
    if (!layer) {
      layer = globalThis.document.createElement("div");
      layer.ariaHidden = "true";
      layer.className = "pdf-viewer__persisted-highlights";
      canvasWrapper.append(layer);
    }
    const fragments = (highlightsByPage.get(pageNumber) ?? [])
      .flatMap((highlight) =>
        mergeNormalizedPdfRects(highlight.rects, canvasWrapper.clientWidth || 600, canvasWrapper.clientHeight || 800).map((rect) => {
          const marker = globalThis.document.createElement("span");
          if (focusedHighlightId === highlight.id) {
            marker.classList.add("is-focused");
          }
          marker.dataset.testid = `pdf-persisted-highlight-${highlight.id}`;
          marker.style.height = `${rect.height * 100}%`;
          marker.style.left = `${rect.left * 100}%`;
          marker.style.top = `${rect.top * 100}%`;
          marker.style.width = `${rect.width * 100}%`;
          return marker;
        }),
      );
    layer.replaceChildren(...fragments);
  }
}

function indexHighlightsByPage(
  highlights: readonly PdfHighlight[],
): ReadonlyMap<number, readonly PdfHighlight[]> {
  const indexed = new Map<number, PdfHighlight[]>();
  for (const highlight of highlights) {
    const pageHighlights = indexed.get(highlight.pageNumber);
    if (pageHighlights) {
      pageHighlights.push(highlight);
    } else {
      indexed.set(highlight.pageNumber, [highlight]);
    }
  }
  return indexed;
}

function captureOfficialTextSelection(
  viewer: HTMLDivElement,
): ActivePdfTextSelection | null {
  const selection = window.getSelection();
  const text = selection
    ? truncateUtf8(selection.toString(), MAX_PDF_SELECTION_TEXT_BYTES)
        .replace(/\s+/g, " ")
        .trim()
    : "";
  if (!selection || selection.isCollapsed || !text || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const elementForNode = (node: Node) =>
    node instanceof Element ? node : node.parentElement;
  const startLayer = elementForNode(range.startContainer)?.closest(".textLayer");
  const endLayer = elementForNode(range.endContainer)?.closest(".textLayer");
  if (!startLayer || startLayer !== endLayer || !viewer.contains(startLayer)) {
    return null;
  }
  const page = startLayer.closest<HTMLElement>(".page[data-page-number]");
  const layerBounds = page
    ?.querySelector<HTMLElement>(".canvasWrapper")
    ?.getBoundingClientRect();
  const pageNumber = Number(page?.dataset.pageNumber);
  if (!layerBounds || !Number.isSafeInteger(pageNumber) || pageNumber <= 0) {
    return null;
  }

  const rangeBounds = range.getBoundingClientRect();
  const bounds =
    Number.isFinite(rangeBounds.left) &&
    Number.isFinite(rangeBounds.bottom) &&
    Number.isFinite(rangeBounds.width)
      ? rangeBounds
      : layerBounds;
  const clientRects: DOMRect[] = [];
  const rectList = range.getClientRects();
  const rectCount = Math.min(rectList.length, MAX_PDF_SELECTION_RECTS);
  for (let index = 0; index < rectCount; index += 1) {
    const rect = rectList[index];
    if (rect) clientRects.push(rect);
  }
  const highlightBounds = (clientRects.length > 0 ? clientRects : [bounds])
    .filter(
      (rect) =>
        Number.isFinite(rect.left) &&
        Number.isFinite(rect.top) &&
        Number.isFinite(rect.width) &&
        Number.isFinite(rect.height) &&
        rect.width > 0 &&
        rect.height > 0,
    )
    .map(({ height, left, top, width }) => ({ height, left, top, width }));
  const normalizedRects = normalizePdfClientRects(layerBounds, highlightBounds);
  if (normalizedRects.length === 0) return null;

  return {
    highlights: normalizedRects.map((rect) => ({
      height: rect.height * layerBounds.height,
      left: layerBounds.left + rect.left * layerBounds.width,
      top: layerBounds.top + rect.top * layerBounds.height,
      width: rect.width * layerBounds.width,
    })),
    selection: {
      anchor: {
        x: bounds.left + bounds.width / 2,
        y: bounds.bottom,
      },
      pageNumber,
      rects: normalizedRects,
      text,
    },
  };
}

const OfficialPdfPages = memo(function OfficialPdfPages({
  document,
  initialLocation,
  onLocationChange,
  navigationTarget,
  focusedHighlightId,
  highlights,
  onError,
  onInteraction,
  onPageChange,
  onRuntimeChange,
  onScroll,
  onTextSelection,
  onZoomChange,
  viewerRuntimeFactory,
}: {
  document: unknown;
  initialLocation?: PdfReadingLocation;
  onLocationChange?: (location: PdfReadingLocation) => void;
  navigationTarget?: NoteCitation | null;
  focusedHighlightId?: string | null;
  highlights: PdfHighlight[];
  onError: () => void;
  onInteraction: () => void;
  onPageChange: (pageNumber: number) => void;
  onRuntimeChange: (runtime: PdfViewerRuntime | null) => void;
  onScroll?: () => void;
  onTextSelection: (selection: ActivePdfTextSelection) => void;
  onZoomChange: (zoom: number) => void;
  viewerRuntimeFactory: typeof createPdfViewerRuntime;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<PdfViewerRuntime | null>(null);
  const highlightsByPage = useMemo(
    () => indexHighlightsByPage(highlights),
    [highlights],
  );
  const latestTargetRef = useRef(navigationTarget);
  const latestHighlightsRef = useRef(highlights);
  const latestHighlightsByPageRef = useRef(highlightsByPage);
  const latestFocusedHighlightIdRef = useRef(focusedHighlightId);

  useEffect(() => {
    latestTargetRef.current = navigationTarget;
    latestHighlightsRef.current = highlights;
    latestHighlightsByPageRef.current = highlightsByPage;
    latestFocusedHighlightIdRef.current = focusedHighlightId;
  }, [focusedHighlightId, highlights, highlightsByPage, navigationTarget]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const viewer = viewerRef.current;
    if (!container || !viewer) return;
    let active = true;
    let runtime: PdfViewerRuntime | null = null;
    const runtimeAbortController = new AbortController();
    void viewerRuntimeFactory({
      abortSignal: runtimeAbortController.signal,
      container,
      document: document as never,
      initialLocation,
      onLocationChange,
      onInteraction,
      onPageChange,
      onPageRendered: (pageNumber) => {
        syncOfficialHighlightLayers(
          viewer,
          latestHighlightsByPageRef.current,
          latestFocusedHighlightIdRef.current,
          pageNumber,
        );
      },
      onScaleChange: onZoomChange,
      viewer,
    }).then(
      (createdRuntime) => {
        if (!active) {
          createdRuntime.destroy();
          return;
        }
        runtime = createdRuntime;
        runtimeRef.current = createdRuntime;
        onRuntimeChange(createdRuntime);
        onPageChange(createdRuntime.currentPage);
        onZoomChange(createdRuntime.currentZoom);
        syncOfficialHighlightLayers(
          viewer,
          latestHighlightsByPageRef.current,
          latestFocusedHighlightIdRef.current,
        );
        const focusedHighlight = latestHighlightsRef.current.find(
          (highlight) =>
            highlight.id === latestFocusedHighlightIdRef.current,
        );
        if (focusedHighlight) { createdRuntime.setPage(focusedHighlight.pageNumber, Math.max(0, (focusedHighlight.rects[0]?.top ?? 0) - 0.08)); onPageChange(focusedHighlight.pageNumber); }
        else if (latestTargetRef.current) createdRuntime.setPage(latestTargetRef.current.pageNumber);
      },
      () => {
        if (active) onError();
      },
    );
    return () => {
      active = false;
      runtimeAbortController.abort();
      runtimeRef.current = null;
      onRuntimeChange(null);
      runtime?.destroy();
    };
  }, [
    document,
    initialLocation,
    onLocationChange,
    onError,
    onInteraction,
    onPageChange,
    onRuntimeChange,
    onZoomChange,
    viewerRuntimeFactory,
  ]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer) {
      syncOfficialHighlightLayers(
        viewer,
        highlightsByPage,
        focusedHighlightId,
      );
    }
    const focusedHighlight = highlights.find(
      (highlight) => highlight.id === focusedHighlightId,
    );
    if (focusedHighlight) runtimeRef.current?.setPage(focusedHighlight.pageNumber, Math.max(0, (focusedHighlight.rects[0]?.top ?? 0) - 0.08));
    else if (navigationTarget) runtimeRef.current?.setPage(navigationTarget.pageNumber);
  }, [focusedHighlightId, highlights, highlightsByPage, navigationTarget]);

  return (
    <div className="pdf-viewer__official-stage">
      <div
        aria-label="PDF pages"
        className="pdf-viewer__pages pdf-viewer__pages--official"
        onMouseUp={() => {
          const viewer = viewerRef.current;
          if (!viewer) return;
          const selection = captureOfficialTextSelection(viewer);
          if (selection) onTextSelection(selection);
        }}
        onScroll={onScroll}
        ref={containerRef}
      >
        <div className="pdfViewer" ref={viewerRef} />
      </div>
    </div>
  );
});

function PdfViewerFile({
  filePath,
  initialLocation,
  onLocationChange,
  navigationTarget,
  focusedHighlightId,
  highlights,
  pdfJs,
  readPdfFile,
  selectionActions = {},
  viewerRuntimeFactory,
}: {
  filePath: string;
  initialLocation?: PdfReadingLocation;
  onLocationChange?: (location: PdfReadingLocation) => void;
  navigationTarget?: NoteCitation | null;
  focusedHighlightId?: string | null;
  highlights: PdfHighlight[];
  pdfJs?: PdfJsAdapter;
  readPdfFile: PdfFileReader;
  selectionActions?: PdfSelectionActions;
  viewerRuntimeFactory: typeof createPdfViewerRuntime;
}) {
  const [document, setDocument] = useState<PdfDocumentLike | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [currentPage, setCurrentPage] = useState(initialLocation?.pageNumber ?? 1);
  const [zoom, setZoom] = useState(initialLocation?.zoom ?? 1);
  const [renderZoom, setRenderZoom] = useState(initialLocation?.zoom ?? 1);
  const [textSelection, setTextSelection] =
    useState<ActivePdfTextSelection | null>(null);
  const pageElementsRef = useRef(new Map<number, HTMLDivElement>());
  const currentPageRef = useRef(initialLocation?.pageNumber ?? 1);
  const pagesRef = useRef<HTMLDivElement>(null);
  const zoomLabelRef = useRef<HTMLSpanElement>(null);
  const zoomRef = useRef(initialLocation?.zoom ?? 1);
  const zoomPreviewRef = useRef<ZoomPreview | null>(null);
  const zoomPreviewFrameRef = useRef<number | null>(null);
  const ignoreTrackpadUntilRef = useRef(0);
  const lastTrackpadTimeRef = useRef(Number.NEGATIVE_INFINITY);
  const renderCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const officialRuntimeRef = useRef<PdfViewerRuntime | null>(null);

  useEffect(() => {
    let active = true;
    let loadingTask: PdfLoadingTaskLike | undefined;
    let loadedDocument: PdfDocumentLike | undefined;

    void (async () => {
      try {
        const [data, adapter] = await Promise.all([
          readPdfFile(filePath, { baseDir: BaseDirectory.AppData }),
          pdfJs ? Promise.resolve(pdfJs) : loadDefaultPdfJs(),
        ]);
        if (!active) return;

        loadingTask = adapter.getDocument({ data });
        loadedDocument = await loadingTask.promise;
        if (!isSupportedPdfPageCount(loadedDocument.numPages)) {
          ignoreCleanupFailure(loadedDocument.destroy());
          loadedDocument = undefined;
          throw new Error("The PDF page count is outside the supported range.");
        }
        if (
          !loadedDocument.viewerDocument &&
          !ENABLE_TEST_ONLY_PDF_RENDERER
        ) {
          ignoreCleanupFailure(loadedDocument.destroy());
          loadedDocument = undefined;
          throw new Error(
            "The production PDF adapter must expose a PDF.js viewer document.",
          );
        }
        if (!active) {
          ignoreCleanupFailure(loadedDocument.destroy());
          return;
        }

        if (initialLocation) {
          const page = Math.min(initialLocation.pageNumber, loadedDocument.numPages);
          currentPageRef.current = page;
          setCurrentPage(page);
        }
        setDocument(loadedDocument);
        setIsLoading(false);
      } catch {
        if (!active) return;
        setDocument(null);
        setIsLoading(false);
        setLoadError(true);
      }
    })();

    return () => {
      active = false;
      if (loadingTask) ignoreCleanupFailure(loadingTask.destroy());
      if (loadedDocument) ignoreCleanupFailure(loadedDocument.destroy());
    };
  }, [filePath, initialLocation, pdfJs, readPdfFile]);

  const registerPage = useCallback(
    (pageNumber: number): RefCallback<HTMLDivElement> =>
      (element) => {
        if (element) pageElementsRef.current.set(pageNumber, element);
        else pageElementsRef.current.delete(pageNumber);
      },
    [],
  );

  const handlePageVisible = useCallback((pageNumber: number) => {
    if (zoomPreviewRef.current) return;
    currentPageRef.current = pageNumber;
    setCurrentPage(pageNumber);
  }, []);

  const clearTextSelection = useCallback(() => {
    setTextSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const handleOfficialPageChange = useCallback((pageNumber: number) => {
    currentPageRef.current = pageNumber;
    setCurrentPage(pageNumber);
  }, []);

  const handleOfficialZoomChange = useCallback((nextZoom: number) => {
    zoomRef.current = nextZoom;
    setZoom(nextZoom);
  }, []);

  const handleOfficialRuntimeChange = useCallback(
    (runtime: PdfViewerRuntime | null) => {
      officialRuntimeRef.current = runtime;
    },
    [],
  );

  const handleOfficialRuntimeError = useCallback(() => {
    setLoadError(true);
  }, []);

  const clearRenderCommitTimer = useCallback(() => {
    if (renderCommitTimerRef.current !== null) {
      clearTimeout(renderCommitTimerRef.current);
      renderCommitTimerRef.current = null;
    }
  }, []);

  const beginZoomPreview = useCallback(
    (source: ZoomPreviewSource, clientX: number, clientY: number) => {
      const existingPreview = zoomPreviewRef.current;
      if (existingPreview) return existingPreview;

      const pages = pagesRef.current;
      if (!pages) return null;

      const pagesBounds = pages.getBoundingClientRect();
      const candidatePageNumbers = new Set<number>();
      const addPageNeighborhood = (pageNumber: number) => {
        for (
          let offset = -ZOOM_PREVIEW_PAGE_OVERSCAN;
          offset <= ZOOM_PREVIEW_PAGE_OVERSCAN;
          offset += 1
        ) {
          candidatePageNumbers.add(pageNumber + offset);
        }
      };
      if (typeof globalThis.document.elementFromPoint === "function") {
        const hitPage = globalThis.document
          .elementFromPoint(clientX, clientY)
          ?.closest<HTMLElement>(".pdf-viewer__page");
        const hitPageNumber = Number(hitPage?.dataset.pageNumber);
        if (Number.isSafeInteger(hitPageNumber) && hitPageNumber > 0) {
          addPageNeighborhood(hitPageNumber);
        }
      }
      addPageNeighborhood(currentPageRef.current);

      let closestPage:
        | { distance: number; pageNumber: number; rect: DOMRect }
        | undefined;
      const candidateElements: HTMLDivElement[] = [];
      for (const pageNumber of candidatePageNumbers) {
        const element = pageElementsRef.current.get(pageNumber);
        if (!element) continue;
        candidateElements.push(element);
      }
      const previewPages = capturePdfZoomPreviewPages(candidateElements);
      for (const page of previewPages) {
        const pageNumber = Number(page.element.dataset.pageNumber);
        const distance = rectDistanceSquared(page, clientX, clientY);
        if (!closestPage || distance < closestPage.distance) {
          closestPage = {
            distance,
            pageNumber,
            rect: DOMRect.fromRect({
              height: page.height,
              width: page.width,
              x: page.left,
              y: page.top,
            }),
          };
        }
      }

      const preview: ZoomPreview = {
        anchorPageNumber: closestPage?.pageNumber ?? null,
        anchorPageX: closestPage
          ? (clientX - closestPage.rect.left) / closestPage.rect.width
          : 0,
        anchorPageY: closestPage
          ? (clientY - closestPage.rect.top) / closestPage.rect.height
          : 0,
        pointerClientX: clientX,
        pointerClientY: clientY,
        pointerX: clientX - (Number.isFinite(pagesBounds.left) ? pagesBounds.left : 0),
        pointerY: clientY - (Number.isFinite(pagesBounds.top) ? pagesBounds.top : 0),
        previewPages,
        rawTargetZoom: zoomRef.current,
        scrollLeft: pages.scrollLeft,
        scrollTop: pages.scrollTop,
        source,
        startZoom: zoomRef.current,
        targetZoom: zoomRef.current,
      };
      zoomPreviewRef.current = preview;
      return preview;
    },
    [],
  );

  const scheduleZoomPreviewPaint = useCallback((preview: ZoomPreview) => {
    if (zoomPreviewFrameRef.current === null) {
      zoomPreviewFrameRef.current = requestAnimationFrame(() => {
        zoomPreviewFrameRef.current = null;
        if (zoomPreviewRef.current !== preview) return;
        const previewScale = preview.targetZoom / preview.startZoom;
        paintPdfZoomPreviewPages(
          preview.previewPages,
          preview.pointerClientX,
          preview.pointerClientY,
          previewScale,
        );
      });
    }
    if (zoomLabelRef.current) {
      zoomLabelRef.current.textContent = `${Math.round(preview.targetZoom * 100)}%`;
    }
  }, []);

  const updateZoomPreview = useCallback(
    (preview: ZoomPreview, requestedZoom: number) => {
      if (!Number.isFinite(requestedZoom) || requestedZoom <= 0) {
        return preview.targetZoom;
      }
      preview.rawTargetZoom = clampZoom(requestedZoom);
      const targetZoom = quantizeZoom(preview.rawTargetZoom);
      if (targetZoom === preview.targetZoom) return targetZoom;
      preview.targetZoom = targetZoom;
      scheduleZoomPreviewPaint(preview);
      return preview.targetZoom;
    },
    [scheduleZoomPreviewPaint],
  );

  const cancelZoomPreview = useCallback(() => {
    clearRenderCommitTimer();
    if (zoomPreviewFrameRef.current !== null) {
      cancelAnimationFrame(zoomPreviewFrameRef.current);
      zoomPreviewFrameRef.current = null;
    }
    const preview = zoomPreviewRef.current;
    zoomPreviewRef.current = null;
    if (preview) clearPdfZoomPreviewPages(preview.previewPages);
    if (zoomLabelRef.current) {
      zoomLabelRef.current.textContent = `${Math.round(zoomRef.current * 100)}%`;
    }
  }, [clearRenderCommitTimer]);

  const commitZoomPreview = useCallback(() => {
    clearRenderCommitTimer();
    const preview = zoomPreviewRef.current;
    if (!preview) return;

    if (zoomPreviewFrameRef.current !== null) {
      cancelAnimationFrame(zoomPreviewFrameRef.current);
      zoomPreviewFrameRef.current = null;
    }
    zoomPreviewRef.current = null;
    clearPdfZoomPreviewPages(preview.previewPages);

    const nextZoom = preview.targetZoom;
    const previousZoom = preview.startZoom;
    zoomRef.current = nextZoom;
    if (nextZoom !== previousZoom) {
      flushSync(() => {
        setZoom(nextZoom);
        setRenderZoom(nextZoom);
      });
    } else if (zoomLabelRef.current) {
      zoomLabelRef.current.textContent = `${Math.round(nextZoom * 100)}%`;
    }

    const pages = pagesRef.current;
    if (!pages) return;
    const anchorPage =
      preview.anchorPageNumber === null
        ? undefined
        : pageElementsRef.current.get(preview.anchorPageNumber);
    const anchorBounds = anchorPage?.getBoundingClientRect();
    if (
      anchorBounds &&
      Number.isFinite(anchorBounds.width) &&
      Number.isFinite(anchorBounds.height) &&
      anchorBounds.width > 0 &&
      anchorBounds.height > 0
    ) {
      const anchoredClientX =
        anchorBounds.left + anchorBounds.width * preview.anchorPageX;
      const anchoredClientY =
        anchorBounds.top + anchorBounds.height * preview.anchorPageY;
      pages.scrollLeft += anchoredClientX - preview.pointerClientX;
      pages.scrollTop += anchoredClientY - preview.pointerClientY;
      return;
    }

    const ratio = nextZoom / previousZoom;
    pages.scrollLeft =
      (preview.scrollLeft + preview.pointerX) * ratio - preview.pointerX;
    pages.scrollTop =
      (preview.scrollTop + preview.pointerY) * ratio - preview.pointerY;
  }, [clearRenderCommitTimer]);

  const scheduleZoomPreviewCommit = useCallback(() => {
    clearRenderCommitTimer();
    renderCommitTimerRef.current = setTimeout(() => {
      renderCommitTimerRef.current = null;
      commitZoomPreview();
    }, ZOOM_RENDER_SETTLE_MS);
  }, [clearRenderCommitTimer, commitZoomPreview]);

  const showPage = useCallback(
    (pageNumber: number) => {
      if (!document) return;
      clearTextSelection();
      const boundedPage = Math.min(Math.max(pageNumber, 1), document.numPages);
      currentPageRef.current = boundedPage;
      const officialRuntime = officialRuntimeRef.current;
      if (officialRuntime) {
        officialRuntime.setPage(boundedPage);
        setCurrentPage(boundedPage);
        return;
      }
      const pageElement = pageElementsRef.current.get(boundedPage);
      if (typeof pageElement?.scrollIntoView === "function") {
        pageElement.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      setCurrentPage(boundedPage);
    },
    [clearTextSelection, document],
  );

  const changeZoom = useCallback(
    (direction: -1 | 1) => {
      clearTextSelection();
      const officialRuntime = officialRuntimeRef.current;
      if (officialRuntime) {
        officialRuntime.stepZoom(direction);
        return;
      }
      const nextZoom = quantizeZoom(
        zoomRef.current *
          (direction > 0 ? ZOOM_STEP_FACTOR : 1 / ZOOM_STEP_FACTOR),
      );
      if (zoomPreviewRef.current) commitZoomPreview();
      const pages = pagesRef.current;
      if (!pages) return;
      const bounds = pages.getBoundingClientRect();
      const clientX = bounds.left + pages.clientWidth / 2;
      const clientY = bounds.top + pages.clientHeight / 2;
      const preview = beginZoomPreview("toolbar", clientX, clientY);
      if (!preview) return;
      updateZoomPreview(preview, nextZoom);
      commitZoomPreview();
    },
    [
      beginZoomPreview,
      clearTextSelection,
      commitZoomPreview,
      updateZoomPreview,
    ],
  );

  useLayoutEffect(() => {
    const pages = pagesRef.current;
    if (!pages || !document) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
      const now = performance.now();
      if (now < ignoreTrackpadUntilRef.current) return;
      const activePreview = zoomPreviewRef.current;
      if (activePreview?.source === "webkit") return;

      let preview = activePreview;
      let clientX = event.clientX;
      let clientY = event.clientY;
      if (clientX === 0 && clientY === 0 && preview) {
        clientX = preview.pointerClientX;
        clientY = preview.pointerClientY;
      }
      if (!preview) {
        clearTextSelection();
        const bounds = pages.getBoundingClientRect();
        if (clientX === 0 && clientY === 0) {
          clientX = bounds.left + pages.clientWidth / 2;
          clientY = bounds.top + pages.clientHeight / 2;
        }
        preview = beginZoomPreview("trackpad", clientX, clientY);
      }
      if (!preview) return;
      lastTrackpadTimeRef.current = now;
      updateZoomPreview(
        preview,
        preview.rawTargetZoom * trackpadZoomFactor(event),
      );
      scheduleZoomPreviewCommit();
    };

    const handleGestureStart = (event: WebKitGestureEvent) => {
      event.preventDefault();
      const now = performance.now();
      const activePreview = zoomPreviewRef.current;
      if (
        activePreview?.source === "trackpad" &&
        now - lastTrackpadTimeRef.current <
          INPUT_STREAM_DUPLICATE_WINDOW_MS
      ) {
        return;
      }
      clearTextSelection();
      if (activePreview?.source === "trackpad") commitZoomPreview();
      else cancelZoomPreview();
      const bounds = pages.getBoundingClientRect();
      const eventClientX = event.clientX;
      const eventClientY = event.clientY;
      const hasEventPoint =
        Number.isFinite(eventClientX) &&
        Number.isFinite(eventClientY) &&
        (eventClientX !== 0 || eventClientY !== 0);
      beginZoomPreview(
        "webkit",
        hasEventPoint ? eventClientX! : bounds.left + pages.clientWidth / 2,
        hasEventPoint ? eventClientY! : bounds.top + pages.clientHeight / 2,
      );
    };

    const handleGestureChange = (event: WebKitGestureEvent) => {
      event.preventDefault();
      const scale = event.scale;
      if (!Number.isFinite(scale) || !scale || scale <= 0) return;
      const preview = zoomPreviewRef.current;
      if (!preview || preview.source !== "webkit") return;
      updateZoomPreview(preview, preview.startZoom * scale);
    };

    const handleGestureEnd = (event: WebKitGestureEvent) => {
      event.preventDefault();
      if (zoomPreviewRef.current?.source === "webkit") {
        commitZoomPreview();
        ignoreTrackpadUntilRef.current =
          performance.now() + INPUT_STREAM_DUPLICATE_WINDOW_MS;
      }
    };

    const handleGestureCancel = (event: WebKitGestureEvent) => {
      event.preventDefault();
      if (zoomPreviewRef.current?.source !== "webkit") return;
      cancelZoomPreview();
      ignoreTrackpadUntilRef.current =
        performance.now() + INPUT_STREAM_DUPLICATE_WINDOW_MS;
    };

    pages.addEventListener("wheel", handleWheel, { passive: false });
    pages.addEventListener("gesturestart", handleGestureStart as EventListener, {
      passive: false,
    });
    pages.addEventListener("gesturechange", handleGestureChange as EventListener, {
      passive: false,
    });
    pages.addEventListener("gestureend", handleGestureEnd as EventListener, {
      passive: false,
    });
    pages.addEventListener(
      "gesturecancel",
      handleGestureCancel as EventListener,
      { passive: false },
    );
    return () => {
      pages.removeEventListener("wheel", handleWheel);
      pages.removeEventListener("gesturestart", handleGestureStart as EventListener);
      pages.removeEventListener("gesturechange", handleGestureChange as EventListener);
      pages.removeEventListener("gestureend", handleGestureEnd as EventListener);
      pages.removeEventListener(
        "gesturecancel",
        handleGestureCancel as EventListener,
      );
    };
  }, [
    beginZoomPreview,
    cancelZoomPreview,
    clearRenderCommitTimer,
    clearTextSelection,
    commitZoomPreview,
    document,
    scheduleZoomPreviewCommit,
    updateZoomPreview,
  ]);

  useEffect(
    () => () => {
      if (zoomPreviewFrameRef.current !== null) {
        cancelAnimationFrame(zoomPreviewFrameRef.current);
      }
      if (renderCommitTimerRef.current !== null) {
        clearTimeout(renderCommitTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!document || document.viewerDocument) return;
    const highlight = highlights.find(({ id }) => id === focusedHighlightId);
    const target = highlight ?? navigationTarget;
    if (!target) return;
    const page = pageElementsRef.current.get(Math.min(target.pageNumber, document.numPages));
    page?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [document, focusedHighlightId, highlights, navigationTarget]);

  useEffect(() => {
    if (!document || document.viewerDocument) return;
    const page = Math.min(initialLocation?.pageNumber ?? 1, document.numPages);
    const element = pageElementsRef.current.get(page);
    const container = pagesRef.current;
    if (initialLocation && element && container) {
      element.scrollIntoView?.({ block: "start" });
      container.scrollTop += initialLocation.offset * element.getBoundingClientRect().height;
    }
    const capture = () => {
      const bounds = pageElementsRef.current.get(currentPageRef.current)?.getBoundingClientRect();
      if (!bounds || bounds.height <= 0 || !container || zoomPreviewRef.current) return;
      onLocationChange?.({ pageNumber: currentPageRef.current, offset: Math.min(1, Math.max(0, (container.getBoundingClientRect().top - bounds.top) / bounds.height)), zoom: zoomRef.current });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(capture, 150); };
    container?.addEventListener("scroll", schedule);
    window.addEventListener("pagehide", capture);
    return () => { clearTimeout(timer); capture(); container?.removeEventListener("scroll", schedule); window.removeEventListener("pagehide", capture); };
  }, [document, initialLocation, onLocationChange]);

  return (
    <section className="pdf-viewer" aria-label="PDF viewer">
      <div className="pdf-viewer__toolbar" aria-label="PDF controls">
        <button
          aria-label="Previous page"
          disabled={!document || currentPage <= 1}
          onClick={() => showPage(currentPage - 1)}
          type="button"
        >
          ←
        </button>
        <span>{document ? `${currentPage} / ${document.numPages}` : "— / —"}</span>
        <button
          aria-label="Next page"
          disabled={!document || currentPage >= document.numPages}
          onClick={() => showPage(currentPage + 1)}
          type="button"
        >
          →
        </button>
        <span className="pdf-viewer__toolbar-spacer" />
        <button
          aria-label="Zoom out"
          disabled={zoom <= MIN_ZOOM}
          onClick={() => changeZoom(-1)}
          type="button"
        >
          −
        </button>
        <span ref={zoomLabelRef}>{Math.round(zoom * 100)}%</span>
        <button
          aria-label="Zoom in"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => changeZoom(1)}
          type="button"
        >
          +
        </button>
      </div>

      {textSelection && (
        <>
          <div aria-hidden="true" className="pdf-selection-highlights">
            {textSelection.highlights.map((highlight, index) => (
              <span
                data-testid="pdf-selection-highlight"
                key={`${highlight.left}:${highlight.top}:${index}`}
                style={highlight}
              />
            ))}
          </div>
          <PdfSelectionPopover
            actions={selectionActions}
            onClose={clearTextSelection}
            selection={textSelection.selection}
          />
        </>
      )}

      {isLoading && <p role="status">Loading PDF…</p>}
      {loadError && <p role="alert">The local PDF could not be opened.</p>}
      {document?.viewerDocument ? (
        <OfficialPdfPages
          document={document.viewerDocument}
          initialLocation={initialLocation}
          onLocationChange={onLocationChange}
          navigationTarget={navigationTarget}
          focusedHighlightId={focusedHighlightId}
          highlights={highlights}
          onError={handleOfficialRuntimeError}
          onInteraction={clearTextSelection}
          onPageChange={handleOfficialPageChange}
          onRuntimeChange={handleOfficialRuntimeChange}
          onScroll={textSelection ? clearTextSelection : undefined}
          onTextSelection={setTextSelection}
          onZoomChange={handleOfficialZoomChange}
          viewerRuntimeFactory={viewerRuntimeFactory}
        />
      ) : ENABLE_TEST_ONLY_PDF_RENDERER && document ? (
        <div
          aria-label="PDF pages"
          className="pdf-viewer__pages"
          onScroll={textSelection ? clearTextSelection : undefined}
          ref={pagesRef}
        >
          <div className="pdf-viewer__pages-content">
            {Array.from({ length: document.numPages }, (_, index) => (
              <PdfPageCanvas
                displayScale={zoom}
                document={document}
                focusedHighlightId={focusedHighlightId}
                highlights={highlights.filter(
                  (highlight) => highlight.pageNumber === index + 1,
                )}
                key={index + 1}
                onVisible={handlePageVisible}
                onTextSelection={setTextSelection}
                pageNumber={index + 1}
                registerPage={registerPage}
                renderScale={renderZoom}
              />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
