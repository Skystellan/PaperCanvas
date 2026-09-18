export interface PdfZoomPreviewPage {
  bottom: number;
  element: HTMLDivElement;
  height: number;
  hadPreviewClass: boolean;
  left: number;
  previousTransformPriority: string;
  previousTransformValue: string;
  right: number;
  top: number;
  width: number;
}

export function capturePdfZoomPreviewPages(
  elements: Iterable<HTMLDivElement>,
): PdfZoomPreviewPage[] {
  const pages: PdfZoomPreviewPage[] = [];
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.top) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      continue;
    }
    const page = {
      bottom: rect.bottom,
      element,
      height: rect.height,
      hadPreviewClass: element.classList.contains("is-zoom-preview"),
      left: rect.left,
      previousTransformPriority:
        element.style.getPropertyPriority("transform"),
      previousTransformValue: element.style.getPropertyValue("transform"),
      right: rect.right,
      top: rect.top,
      width: rect.width,
    };
    pages.push(page);
    element.classList.add("is-zoom-preview");
  }
  return pages;
}

export function paintPdfZoomPreviewPages(
  pages: readonly PdfZoomPreviewPage[],
  pointerClientX: number,
  pointerClientY: number,
  previewScale: number,
): void {
  for (const { element, left, top } of pages) {
    const translateX = (1 - previewScale) * (pointerClientX - left);
    const translateY = (1 - previewScale) * (pointerClientY - top);
    element.style.transform =
      `translate3d(${translateX}px, ${translateY}px, 0) scale(${previewScale})`;
  }
}

export function clearPdfZoomPreviewPages(
  pages: readonly PdfZoomPreviewPage[],
): void {
  for (const {
    element,
    hadPreviewClass,
    previousTransformPriority,
    previousTransformValue,
  } of pages) {
    if (previousTransformValue) {
      element.style.setProperty(
        "transform",
        previousTransformValue,
        previousTransformPriority,
      );
    } else {
      element.style.removeProperty("transform");
    }
    if (!hadPreviewClass) element.classList.remove("is-zoom-preview");
  }
}
