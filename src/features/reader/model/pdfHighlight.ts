export { MAX_PDF_SELECTION_RECTS } from "./pdfLimits";

import {
  MAX_PDF_HIGHLIGHT_COMMENT_BYTES,
  MAX_PDF_HIGHLIGHT_COMMENT_CHARACTERS,
  MAX_PDF_HIGHLIGHT_ID_CHARACTERS,
  MAX_PDF_HIGHLIGHT_RECTS_JSON_CHARACTERS,
  MAX_PDF_SELECTION_RECTS,
  MAX_PDF_SELECTION_TEXT_BYTES,
  isSupportedPdfPageCount,
  isUtf8WithinLimit,
} from "./pdfLimits";

export interface NormalizedPdfRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface PdfHighlight {
  comment: string;
  createdAt: number;
  id: string;
  pageNumber: number;
  paperId: string;
  rects: NormalizedPdfRect[];
  text: string;
  updatedAt: number;
}

export interface PdfHighlightRepository {
  load(paperId: string): Promise<PdfHighlight[]>;
  remove(paperId: string, highlightId: string): Promise<void>;
  save(highlight: PdfHighlight): Promise<void>;
}

export interface ClientRectLike {
  height: number;
  left: number;
  top: number;
  width: number;
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function normalizePdfClientRects(
  pageBounds: ClientRectLike,
  rects: readonly ClientRectLike[],
): NormalizedPdfRect[] {
  if (
    !Number.isFinite(pageBounds.left) ||
    !Number.isFinite(pageBounds.top) ||
    !isFinitePositive(pageBounds.width) ||
    !isFinitePositive(pageBounds.height)
  ) {
    return [];
  }

  const pageRight = pageBounds.left + pageBounds.width;
  const pageBottom = pageBounds.top + pageBounds.height;

  return rects.slice(0, MAX_PDF_SELECTION_RECTS).flatMap((rect) => {
    if (
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.top) ||
      !isFinitePositive(rect.width) ||
      !isFinitePositive(rect.height)
    ) {
      return [];
    }

    const left = Math.max(pageBounds.left, rect.left);
    const top = Math.max(pageBounds.top, rect.top);
    const right = Math.min(pageRight, rect.left + rect.width);
    const bottom = Math.min(pageBottom, rect.top + rect.height);
    if (right <= left || bottom <= top) return [];

    return [
      {
        height: clampUnit((bottom - top) / pageBounds.height),
        left: clampUnit((left - pageBounds.left) / pageBounds.width),
        top: clampUnit((top - pageBounds.top) / pageBounds.height),
        width: clampUnit((right - left) / pageBounds.width),
      },
    ];
  });
}

function isNormalizedPdfRect(value: unknown): value is NormalizedPdfRect {
  if (!value || typeof value !== "object") return false;
  const rect = value as Partial<NormalizedPdfRect>;
  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !isFinitePositive(rect.width ?? 0) ||
    !isFinitePositive(rect.height ?? 0)
  ) {
    return false;
  }
  const { height, left, top, width } = rect as NormalizedPdfRect;
  return (
    left >= 0 &&
    top >= 0 &&
    width <= 1 &&
    height <= 1 &&
    left + width <= 1.000_001 &&
    top + height <= 1.000_001
  );
}

export function parseNormalizedPdfRects(value: unknown): NormalizedPdfRect[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (value.length > MAX_PDF_HIGHLIGHT_RECTS_JSON_CHARACTERS) return [];
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.slice(0, MAX_PDF_SELECTION_RECTS).filter(isNormalizedPdfRect)
    : [];
}

function isBoundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PDF_HIGHLIGHT_ID_CHARACTERS &&
    isUtf8WithinLimit(value, MAX_PDF_HIGHLIGHT_ID_CHARACTERS * 4)
  );
}

export function isValidPdfHighlightContent(
  highlight: PdfHighlight,
  options: { requireRects?: boolean } = {},
): boolean {
  const parsedRects = parseNormalizedPdfRects(highlight.rects);
  return (
    isBoundedId(highlight.id) &&
    isBoundedId(highlight.paperId) &&
    isSupportedPdfPageCount(highlight.pageNumber) &&
    typeof highlight.text === "string" &&
    highlight.text.trim().length > 0 &&
    isUtf8WithinLimit(highlight.text, MAX_PDF_SELECTION_TEXT_BYTES) &&
    typeof highlight.comment === "string" &&
    highlight.comment.length <= MAX_PDF_HIGHLIGHT_COMMENT_CHARACTERS &&
    isUtf8WithinLimit(highlight.comment, MAX_PDF_HIGHLIGHT_COMMENT_BYTES) &&
    Number.isSafeInteger(highlight.createdAt) &&
    highlight.createdAt >= 0 &&
    Number.isSafeInteger(highlight.updatedAt) &&
    highlight.updatedAt >= 0 &&
    parsedRects.length === highlight.rects.length &&
    (!options.requireRects || parsedRects.length > 0)
  );
}

let fallbackIdSequence = 0;

export function createPdfHighlightId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `highlight-${randomUuid}`;
  fallbackIdSequence += 1;
  return `highlight-${Date.now()}-${fallbackIdSequence}`;
}
