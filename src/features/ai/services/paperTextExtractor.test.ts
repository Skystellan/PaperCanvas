import { BaseDirectory } from "@tauri-apps/plugin-fs";
import { describe, expect, it, vi } from "vitest";
import type { Paper } from "../../library";
import { MAX_SUPPORTED_PDF_PAGES } from "../../reader/model/pdfLimits";
import {
  MAX_EXTRACTED_PAPER_CHARACTERS,
  MAX_PDF_TEXT_ITEMS_PER_DOCUMENT,
  MAX_PDF_TEXT_ITEMS_PER_PAGE,
  PaperTextExtractionError,
  extractFullPaperText,
} from "./paperTextExtractor";

const paper: Paper = {
  id: "paper-1",
  title: "Local paper",
  authors: null,
  year: null,
  filePath: "papers/paper-1.pdf",
  domainId: null,
  createdAt: 1,
};

describe("extractFullPaperText", () => {
  it("reads an app-owned PDF and preserves every page with explicit separators", async () => {
    const destroyDocument = vi.fn();
    const destroyTask = vi.fn();
    const getPage = vi
      .fn()
      .mockResolvedValueOnce({
        getTextContent: vi.fn().mockResolvedValue({
          items: [{ str: "First" }, { hasEOL: true, str: "  page " }, { str: "line" }],
        }),
      })
      .mockResolvedValueOnce({
        getTextContent: vi.fn().mockResolvedValue({
          items: [{ str: "Second page" }],
        }),
      });
    const pdfJs = {
      getDocument: vi.fn().mockReturnValue({
        promise: Promise.resolve({ numPages: 2, getPage, destroy: destroyDocument }),
        destroy: destroyTask,
      }),
    };
    const readPdfFile = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));

    await expect(
      extractFullPaperText(paper, { pdfJs, readPdfFile }),
    ).resolves.toEqual({
      content: "--- Page 1 ---\nFirst page\nline\n\n--- Page 2 ---\nSecond page",
      pageCount: 2,
    });

    expect(readPdfFile).toHaveBeenCalledWith("papers/paper-1.pdf", {
      baseDir: BaseDirectory.AppData,
    });
    expect(getPage).toHaveBeenCalledTimes(2);
    expect(destroyDocument).toHaveBeenCalledOnce();
    expect(destroyTask).toHaveBeenCalledOnce();
  });

  it("refuses a legacy record without a local PDF", async () => {
    await expect(
      extractFullPaperText(
        { ...paper, filePath: null },
        {
          pdfJs: { getDocument: vi.fn() },
          readPdfFile: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({ code: "missing_pdf" });
  });

  it("fails explicitly when the complete paper is too large and never truncates", async () => {
    const destroy = vi.fn();
    const pdfJs = {
      getDocument: vi.fn().mockReturnValue({
        promise: Promise.resolve({
          numPages: 1,
          getPage: vi.fn().mockResolvedValue({
            getTextContent: vi.fn().mockResolvedValue({
              items: [{ str: "x".repeat(MAX_EXTRACTED_PAPER_CHARACTERS + 1) }],
            }),
          }),
          destroy,
        }),
        destroy: vi.fn(),
      }),
    };

    const error = await extractFullPaperText(paper, {
      pdfJs,
      readPdfFile: vi.fn().mockResolvedValue(new Uint8Array([1])),
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(PaperTextExtractionError);
    expect(error).toMatchObject({ code: "too_large", pageCount: 1 });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("reports scanned or image-only PDFs instead of attaching empty context", async () => {
    const pdfJs = {
      getDocument: vi.fn().mockReturnValue({
        promise: Promise.resolve({
          numPages: 1,
          getPage: vi.fn().mockResolvedValue({
            getTextContent: vi.fn().mockResolvedValue({ items: [] }),
          }),
          destroy: vi.fn(),
        }),
        destroy: vi.fn(),
      }),
    };

    await expect(
      extractFullPaperText(paper, {
        pdfJs,
        readPdfFile: vi.fn().mockResolvedValue(new Uint8Array([1])),
      }),
    ).rejects.toMatchObject({ code: "no_text" });
  });

  it("rejects an implausible page count before iterating a hostile PDF", async () => {
    const destroy = vi.fn();
    const getPage = vi.fn();
    const pdfJs = {
      getDocument: vi.fn().mockReturnValue({
        promise: Promise.resolve({
          numPages: MAX_SUPPORTED_PDF_PAGES + 1,
          getPage,
          destroy,
        }),
        destroy: vi.fn(),
      }),
    };

    await expect(
      extractFullPaperText(paper, {
        pdfJs,
        readPdfFile: vi.fn().mockResolvedValue(new Uint8Array([1])),
      }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(getPage).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("rejects a page with an implausible number of text items", async () => {
    const destroy = vi.fn();
    const pdfJs = {
      getDocument: vi.fn().mockReturnValue({
        promise: Promise.resolve({
          numPages: 1,
          getPage: vi.fn().mockResolvedValue({
            getTextContent: vi.fn().mockResolvedValue({
              items: new Array(MAX_PDF_TEXT_ITEMS_PER_PAGE + 1),
            }),
          }),
          destroy,
        }),
        destroy: vi.fn(),
      }),
    };

    await expect(
      extractFullPaperText(paper, {
        pdfJs,
        readPdfFile: vi.fn().mockResolvedValue(new Uint8Array([1])),
      }),
    ).rejects.toMatchObject({ code: "too_large", pageCount: 1 });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("bounds fragmented text items across the complete document", async () => {
    const destroy = vi.fn();
    const itemsPerPage = MAX_PDF_TEXT_ITEMS_PER_PAGE;
    const pageCount = Math.floor(MAX_PDF_TEXT_ITEMS_PER_DOCUMENT / itemsPerPage) + 1;
    const items = new Array(itemsPerPage);
    const getPage = vi.fn().mockResolvedValue({
      getTextContent: vi.fn().mockResolvedValue({ items }),
    });
    const pdfJs = {
      getDocument: vi.fn().mockReturnValue({
        promise: Promise.resolve({ numPages: pageCount, getPage, destroy }),
        destroy: vi.fn(),
      }),
    };

    await expect(
      extractFullPaperText(paper, {
        pdfJs,
        readPdfFile: vi.fn().mockResolvedValue(new Uint8Array([1])),
      }),
    ).rejects.toMatchObject({ code: "too_large", pageCount });
    expect(getPage).toHaveBeenCalledTimes(pageCount);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("stops between pages when extraction is cancelled", async () => {
    const abort = new AbortController();
    const destroy = vi.fn();
    const destroyTask = vi.fn();
    const getPage = vi.fn().mockResolvedValue({
      getTextContent: vi.fn().mockImplementation(async () => {
        abort.abort();
        return { items: [{ str: "First page" }] };
      }),
    });
    const pdfJs = {
      getDocument: vi.fn().mockReturnValue({
        promise: Promise.resolve({ numPages: 20, getPage, destroy }),
        destroy: destroyTask,
      }),
    };

    await expect(
      extractFullPaperText(paper, {
        pdfJs,
        readPdfFile: vi.fn().mockResolvedValue(new Uint8Array([1])),
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroyTask).toHaveBeenCalledOnce();
  });
});
