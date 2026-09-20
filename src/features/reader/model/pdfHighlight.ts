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

/** Join glyph boxes using their original geometry, not an ever-growing bounding box. */
export function mergePdfClientRects(rects: readonly ClientRectLike[]): ClientRectLike[] {
  const parents = rects.map((_, index) => index);
  const root = (index: number): number => {
    while (parents[index] !== index) index = parents[index];
    return index;
  };
  // Selections are capped at 256 rectangles. Pairwise comparison keeps script and
  // fraction fragments together without making DOM order a proxy for reading order.
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const overlapX = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
      const shortHeight = Math.min(a.height, b.height);
      const sameLine = overlapX >= -shortHeight * 0.45 &&
        overlapY >= shortHeight * 0.2 &&
        Math.abs(a.top + a.height / 2 - b.top - b.height / 2) <= Math.max(a.height, b.height) * 0.65;
      // Close, narrow stacked fragments also cover fractions whose rule is not
      // in the text layer. Ordinary line spacing and column gutters stay open.
      const fraction = overlapX >= Math.min(a.width, b.width) * 0.65 &&
        overlapY >= -shortHeight * 0.25 &&
        a.width <= a.height * 6 && b.width <= b.height * 6;
      if (sameLine || fraction) parents[root(j)] = root(i);
    }
  }
  const groups = new Map<number, ClientRectLike>();
  rects.forEach((rect, index) => {
    const key = root(index), previous = groups.get(key);
    if (!previous) { groups.set(key, { ...rect }); return; }
    const left = Math.min(previous.left, rect.left), top = Math.min(previous.top, rect.top);
    groups.set(key, {
      left, top,
      width: Math.max(previous.left + previous.width, rect.left + rect.width) - left,
      height: Math.max(previous.top + previous.height, rect.top + rect.height) - top,
    });
  });
  return [...groups.values()];
}

/** Also used on stored rectangles so pre-existing annotations benefit at any zoom. */
export function mergeNormalizedPdfRects(
  rects: readonly NormalizedPdfRect[], width: number, height: number,
): NormalizedPdfRect[] {
  return mergePdfClientRects(rects.map((rect) => ({
    left: rect.left * width, top: rect.top * height,
    width: rect.width * width, height: rect.height * height,
  }))).map((rect) => ({
    left: rect.left / width, top: rect.top / height,
    width: rect.width / width, height: rect.height / height,
  }));
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

  const clipped = rects.slice(0, MAX_PDF_SELECTION_RECTS).flatMap((rect) => {
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
  return mergeNormalizedPdfRects(clipped, pageBounds.width, pageBounds.height);
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
