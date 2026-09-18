import { describe, expect, it } from "vitest";
import {
  capturePdfZoomPreviewPages,
  clearPdfZoomPreviewPages,
  paintPdfZoomPreviewPages,
} from "./pdfZoomPreview";

describe("PDF zoom preview layers", () => {
  it("restores the transform and preview class state owned by the caller", () => {
    const existingPreviewPage = document.createElement("div");
    existingPreviewPage.classList.add("is-zoom-preview");
    existingPreviewPage.style.setProperty(
      "transform",
      "rotate(3deg)",
      "important",
    );
    existingPreviewPage.getBoundingClientRect = () =>
      DOMRect.fromRect({ height: 800, width: 600, x: 100, y: 80 });

    const plainPage = document.createElement("div");
    plainPage.getBoundingClientRect = () =>
      DOMRect.fromRect({ height: 800, width: 600, x: 100, y: 904 });

    const pages = capturePdfZoomPreviewPages([
      existingPreviewPage,
      plainPage,
    ]);
    paintPdfZoomPreviewPages(pages, 300, 240, 1.2);
    clearPdfZoomPreviewPages(pages);

    expect(existingPreviewPage.style.getPropertyValue("transform")).toBe(
      "rotate(3deg)",
    );
    expect(existingPreviewPage.style.getPropertyPriority("transform")).toBe(
      "important",
    );
    expect(existingPreviewPage).toHaveClass("is-zoom-preview");
    expect(plainPage.style.getPropertyValue("transform")).toBe("");
    expect(plainPage).not.toHaveClass("is-zoom-preview");
  });
});
