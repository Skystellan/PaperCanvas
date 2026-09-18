import "./pdfJsCompatibility";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PdfJsAdapter } from "./PdfViewer";

const { getDocument, GlobalWorkerOptions, TextLayer } = pdfjsLib;

(globalThis as typeof globalThis & { pdfjsLib?: typeof pdfjsLib }).pdfjsLib =
  pdfjsLib;

GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
const MAX_CANVAS_BYTES = 128 * 1024 * 1024;

export const browserPdfJsAdapter: PdfJsAdapter = {
  getDocument: ({ data }) => {
    const task = getDocument({
      canvasMaxAreaInBytes: MAX_CANVAS_BYTES,
      data,
      disableAutoFetch: true,
      maxImageSize: MAX_IMAGE_PIXELS,
    });
    return {
      destroy: () => task.destroy(),
      promise: task.promise.then((document) => ({
        destroy: () => document.cleanup(),
        getPage: async (pageNumber) => {
          const page = await document.getPage(pageNumber);
          return {
            getTextContent: () =>
              page.getTextContent({
                disableNormalization: true,
                includeMarkedContent: true,
              }),
            getViewport: ({ scale }) => page.getViewport({ scale }),
            render: (options) => page.render(options as never),
            renderTextLayer: ({ container, viewport }) => {
              const textLayer = new TextLayer({
                container,
                textContentSource: page.streamTextContent({
                  disableNormalization: true,
                  includeMarkedContent: true,
                }),
                viewport: viewport as never,
              });
              return {
                cancel: () => textLayer.cancel(),
                promise: textLayer.render(),
              };
            },
          };
        },
        numPages: document.numPages,
        viewerDocument: document,
      })),
    };
  },
};
