import { beforeEach, describe, expect, it, vi } from "vitest";

const pdfJs = vi.hoisted(() => ({
  cleanup: vi.fn(),
  destroy: vi.fn(),
  getDocument: vi.fn(),
  getPage: vi.fn(),
  getTextContent: vi.fn(),
  getViewport: vi.fn(),
  render: vi.fn(),
  renderTextLayer: vi.fn(),
  cancelTextLayer: vi.fn(),
  streamTextContent: vi.fn(),
  textLayerOptions: [] as unknown[],
  workerOptions: { workerSrc: "" },
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: pdfJs.getDocument,
  GlobalWorkerOptions: pdfJs.workerOptions,
  TextLayer: class {
    constructor(options: unknown) {
      pdfJs.textLayerOptions.push(options);
    }
    cancel() {
      pdfJs.cancelTextLayer();
    }
    render() {
      return pdfJs.renderTextLayer();
    }
  },
}));

vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({
  default: "local-pdf-worker.mjs",
}));

import { browserPdfJsAdapter } from "./pdfJsAdapter";

describe("browserPdfJsAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pdfJs.cleanup.mockResolvedValue(undefined);
    pdfJs.destroy.mockResolvedValue(undefined);
    pdfJs.getViewport.mockReturnValue({ height: 800, width: 600 });
    pdfJs.getTextContent.mockResolvedValue({ items: [{ str: "Extractable text" }] });
    pdfJs.render.mockReturnValue({ cancel: vi.fn(), promise: Promise.resolve() });
    pdfJs.renderTextLayer.mockResolvedValue(undefined);
    pdfJs.streamTextContent.mockReturnValue({ stream: true });
    pdfJs.textLayerOptions.length = 0;
    pdfJs.getPage.mockResolvedValue({
      getTextContent: pdfJs.getTextContent,
      getViewport: pdfJs.getViewport,
      render: pdfJs.render,
      streamTextContent: pdfJs.streamTextContent,
    });
    pdfJs.getDocument.mockReturnValue({
      destroy: pdfJs.destroy,
      promise: Promise.resolve({
        cleanup: pdfJs.cleanup,
        getPage: pdfJs.getPage,
        numPages: 4,
      }),
    });
  });

  it("uses the bundled worker and adapts PDF.js lifecycle objects", async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const task = browserPdfJsAdapter.getDocument({ data: bytes });
    const document = await task.promise;
    const page = await document.getPage(2);
    const textContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1.25 });
    const renderOptions = {
      canvas: globalThis.document.createElement("canvas"),
      canvasContext: {} as CanvasRenderingContext2D,
      viewport,
    };

    page.render(renderOptions);
    const textContainer = globalThis.document.createElement("div");
    const textTask = page.renderTextLayer({
      container: textContainer,
      viewport,
    });
    await textTask.promise;
    textTask.cancel();
    await task.destroy();
    await document.destroy();

    expect(pdfJs.workerOptions.workerSrc).toBe("local-pdf-worker.mjs");
    expect(pdfJs.getDocument).toHaveBeenCalledWith({
      canvasMaxAreaInBytes: 128 * 1024 * 1024,
      data: bytes,
      disableAutoFetch: true,
      maxImageSize: 32 * 1024 * 1024,
    });
    expect(document.viewerDocument).toEqual(
      expect.objectContaining({ getPage: pdfJs.getPage, numPages: 4 }),
    );
    expect(pdfJs.getPage).toHaveBeenCalledWith(2);
    expect(pdfJs.getViewport).toHaveBeenCalledWith({ scale: 1.25 });
    expect(textContent).toEqual({ items: [{ str: "Extractable text" }] });
    expect(pdfJs.getTextContent).toHaveBeenCalledWith({
      disableNormalization: true,
      includeMarkedContent: true,
    });
    expect(pdfJs.render).toHaveBeenCalledWith(renderOptions);
    expect(pdfJs.streamTextContent).toHaveBeenCalledWith({
      disableNormalization: true,
      includeMarkedContent: true,
    });
    expect(pdfJs.textLayerOptions).toContainEqual({
      container: textContainer,
      textContentSource: { stream: true },
      viewport,
    });
    expect(pdfJs.cancelTextLayer).toHaveBeenCalledOnce();
    expect(pdfJs.destroy).toHaveBeenCalledOnce();
    expect(pdfJs.cleanup).toHaveBeenCalledOnce();
  });
});
