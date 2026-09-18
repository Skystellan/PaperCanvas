export const MAX_SUPPORTED_PDF_PAGES = 2_000;
export const MAX_PDF_SELECTION_RECTS = 256;
export const MAX_PDF_SELECTION_TEXT_BYTES = 64 * 1024;
export const MAX_PDF_HIGHLIGHT_COMMENT_CHARACTERS = 4_096;
export const MAX_PDF_HIGHLIGHT_COMMENT_BYTES = 16 * 1024;
export const MAX_PDF_SELECTION_QUESTION_CHARACTERS = 4_096;
export const MAX_PDF_HIGHLIGHT_ID_CHARACTERS = 256;
export const MAX_PDF_HIGHLIGHT_RECTS_JSON_CHARACTERS = 64 * 1024;

export function isSupportedPdfPageCount(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_SUPPORTED_PDF_PAGES;
}

function utf8CodePointBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function isUtf8WithinLimit(value: string, maxBytes: number): boolean {
  if (value.length > maxBytes) return false;
  let bytes = 0;
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    bytes += utf8CodePointBytes(codePoint);
    if (bytes > maxBytes) return false;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return true;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const nextBytes = bytes + utf8CodePointBytes(codePoint);
    if (nextBytes > maxBytes) break;
    index += codePoint > 0xffff ? 2 : 1;
    bytes = nextBytes;
    end = index;
  }
  return end === value.length ? value : value.slice(0, end);
}
