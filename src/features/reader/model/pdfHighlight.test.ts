import { describe, expect, it } from "vitest";
import {
  MAX_PDF_SELECTION_RECTS,
  normalizePdfClientRects,
  parseNormalizedPdfRects,
} from "./pdfHighlight";
import {
  MAX_PDF_SELECTION_TEXT_BYTES,
  isUtf8WithinLimit,
  truncateUtf8,
} from "./pdfLimits";

describe("normalizePdfClientRects", () => {
  it("clips viewport rectangles to the PDF page and converts them to 0..1", () => {
    expect(
      normalizePdfClientRects(
        { height: 200, left: 100, top: 50, width: 400 },
        [
          { height: 40, left: 80, top: 30, width: 120 },
          { height: 20, left: 300, top: 150, width: 100 },
        ],
      ),
    ).toEqual([
      { height: 0.1, left: 0, top: 0, width: 0.25 },
      { height: 0.1, left: 0.5, top: 0.5, width: 0.25 },
    ]);
  });

  it("drops invalid, zero-area, and fully out-of-page rectangles", () => {
    expect(
      normalizePdfClientRects(
        { height: 200, left: 100, top: 50, width: 400 },
        [
          { height: 10, left: 10, top: 10, width: 10 },
          { height: 0, left: 120, top: 80, width: 20 },
          { height: 10, left: Number.NaN, top: 80, width: 20 },
        ],
      ),
    ).toEqual([]);
  });

  it("rejects invalid page bounds and filters malformed persisted entries", () => {
    expect(
      normalizePdfClientRects(
        { height: 0, left: 0, top: 0, width: 100 },
        [{ height: 10, left: 1, top: 1, width: 10 }],
      ),
    ).toEqual([]);
    expect(
      parseNormalizedPdfRects([
        { height: 0.1, left: 0.2, top: 0.3, width: 0.4 },
        { height: 0.5, left: 0.8, top: 0.8, width: 0.5 },
        null,
      ]),
    ).toEqual([{ height: 0.1, left: 0.2, top: 0.3, width: 0.4 }]);
    expect(parseNormalizedPdfRects({})).toEqual([]);
  });

  it("bounds hostile selection and stored-rectangle arrays", () => {
    const rectangles = Array.from(
      { length: MAX_PDF_SELECTION_RECTS + 20 },
      () => ({ height: 1, left: 0, top: 0, width: 1 }),
    );

    expect(
      normalizePdfClientRects(
        { height: 100, left: 0, top: 0, width: 100 },
        rectangles,
      ),
    ).toHaveLength(MAX_PDF_SELECTION_RECTS);
    expect(parseNormalizedPdfRects(rectangles)).toHaveLength(
      MAX_PDF_SELECTION_RECTS,
    );
  });

  it("bounds UTF-8 selection text without splitting a code point", () => {
    const clipped = truncateUtf8(
      `${"a".repeat(MAX_PDF_SELECTION_TEXT_BYTES - 2)}论文`,
      MAX_PDF_SELECTION_TEXT_BYTES,
    );

    expect(clipped).toBe("a".repeat(MAX_PDF_SELECTION_TEXT_BYTES - 2));
    expect(isUtf8WithinLimit(clipped, MAX_PDF_SELECTION_TEXT_BYTES)).toBe(true);
    expect(
      isUtf8WithinLimit(`${clipped}论`, MAX_PDF_SELECTION_TEXT_BYTES),
    ).toBe(false);
  });
});
