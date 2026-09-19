import { BaseDirectory, readFile } from "../../../platform/fs";
import type { Paper } from "../../library";
import { isSupportedPdfPageCount } from "../../reader/model/pdfLimits";

export const MAX_EXTRACTED_PAPER_CHARACTERS = 480_000;
export const MAX_PDF_TEXT_ITEMS_PER_DOCUMENT = 250_000;
export const MAX_PDF_TEXT_ITEMS_PER_PAGE = 50_000;

export type PaperTextExtractionErrorCode =
  | "missing_pdf"
  | "no_text"
  | "open_failed"
  | "too_large";

export class PaperTextExtractionError extends Error {
  constructor(
    public readonly code: PaperTextExtractionErrorCode,
    message: string,
    public readonly pageCount = 0,
    public readonly charCount = 0,
  ) {
    super(message);
    this.name = "PaperTextExtractionError";
  }
}

export class PaperTextExtractionCancelledError extends Error {
  constructor() {
    super("Paper text extraction was cancelled.");
    this.name = "AbortError";
  }
}

interface PdfTextItemLike {
  hasEOL?: boolean;
  str: string;
}

interface PdfTextPageLike {
  getTextContent(): Promise<{ items: unknown[] }>;
}

interface PdfTextDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfTextPageLike>;
  destroy(): Promise<void> | void;
}

interface PdfTextLoadingTaskLike {
  promise: Promise<PdfTextDocumentLike>;
  destroy(): Promise<void> | void;
}

export interface PdfTextJsAdapter {
  getDocument(options: { data: Uint8Array }): PdfTextLoadingTaskLike;
}

export type PaperPdfFileReader = (
  path: string,
  options: { baseDir: BaseDirectory },
) => Promise<Uint8Array>;

export interface PaperTextExtractorDependencies {
  pdfJs?: PdfTextJsAdapter;
  readPdfFile?: PaperPdfFileReader;
  signal?: AbortSignal;
}

function isTextItem(value: unknown): value is PdfTextItemLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "str" in value &&
    typeof value.str === "string"
  );
}

function normalizePageText(items: readonly unknown[]): string {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    if (!isTextItem(item)) continue;
    const text = item.str.replace(/\s+/g, " ").trim();
    if (text) line = line ? `${line} ${text}` : text;
    if (item.hasEOL && line) {
      lines.push(line);
      line = "";
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PaperTextExtractionCancelledError();
}

function waitForCancellation<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  throwIfCancelled(signal);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => reject(new PaperTextExtractionCancelledError()));

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function loadDefaultPdfJs(): Promise<PdfTextJsAdapter> {
  const module = await import("../../reader/pdfJsAdapter");
  return module.browserPdfJsAdapter;
}

export async function extractFullPaperText(
  paper: Paper,
  dependencies: PaperTextExtractorDependencies = {},
): Promise<{ content: string; pageCount: number }> {
  if (!paper.filePath) {
    throw new PaperTextExtractionError(
      "missing_pdf",
      "This paper has no app-owned PDF to extract.",
    );
  }

  const readPdfFile = dependencies.readPdfFile ?? readFile;
  const { signal } = dependencies;
  let loadingTask: PdfTextLoadingTaskLike | undefined;
  let document: PdfTextDocumentLike | undefined;
  try {
    throwIfCancelled(signal);
    const [data, pdfJs] = await waitForCancellation(
      Promise.all([
        readPdfFile(paper.filePath, { baseDir: BaseDirectory.AppData }),
        dependencies.pdfJs
          ? Promise.resolve(dependencies.pdfJs)
          : loadDefaultPdfJs(),
      ]),
      signal,
    );
    loadingTask = pdfJs.getDocument({ data });
    document = await waitForCancellation(loadingTask.promise, signal);
    if (!isSupportedPdfPageCount(document.numPages)) {
      throw new PaperTextExtractionError(
        "too_large",
        "The paper has more pages than PaperCanvas can process safely.",
        document.numPages,
      );
    }

    const pages: string[] = [];
    let charCount = 0;
    let totalTextItems = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await waitForCancellation(document.getPage(pageNumber), signal);
      const textContent = await waitForCancellation(page.getTextContent(), signal);
      throwIfCancelled(signal);
      if (textContent.items.length > MAX_PDF_TEXT_ITEMS_PER_PAGE) {
        throw new PaperTextExtractionError(
          "too_large",
          "A PDF page contains too many text fragments to process safely.",
          document.numPages,
          charCount,
        );
      }
      totalTextItems += textContent.items.length;
      if (totalTextItems > MAX_PDF_TEXT_ITEMS_PER_DOCUMENT) {
        throw new PaperTextExtractionError(
          "too_large",
          "The PDF contains too many text fragments to process safely.",
          document.numPages,
          charCount,
        );
      }
      let rawPageCharacters = 0;
      for (const item of textContent.items) {
        if (!isTextItem(item)) continue;
        rawPageCharacters += item.str.length;
        if (
          rawPageCharacters > MAX_EXTRACTED_PAPER_CHARACTERS ||
          charCount + rawPageCharacters > MAX_EXTRACTED_PAPER_CHARACTERS
        ) {
          throw new PaperTextExtractionError(
            "too_large",
            "The complete paper exceeds the explicit Codex context limit.",
            document.numPages,
            charCount + rawPageCharacters,
          );
        }
      }
      const pageText = normalizePageText(textContent.items);
      const block = `--- Page ${pageNumber} ---\n${pageText}`;
      charCount += block.length + (pages.length > 0 ? 2 : 0);
      if (charCount > MAX_EXTRACTED_PAPER_CHARACTERS) {
        throw new PaperTextExtractionError(
          "too_large",
          "The complete paper exceeds the explicit Codex context limit.",
          document.numPages,
          charCount,
        );
      }
      pages.push(block);
    }

    const content = pages.join("\n\n");
    if (!content.replace(/--- Page \d+ ---/g, "").trim()) {
      throw new PaperTextExtractionError(
        "no_text",
        "No selectable text was found. OCR is not enabled in this version.",
        document.numPages,
        0,
      );
    }
    return { content, pageCount: document.numPages };
  } catch (error) {
    if (error instanceof PaperTextExtractionCancelledError) throw error;
    if (error instanceof PaperTextExtractionError) throw error;
    throw new PaperTextExtractionError(
      "open_failed",
      "The local PDF could not be extracted.",
      document?.numPages ?? 0,
    );
  } finally {
    try {
      if (loadingTask) await loadingTask.destroy();
    } catch {
      // Cleanup failures must not replace the actionable extraction result.
    }
    try {
      if (document) await document.destroy();
    } catch {
      // The loading task already received the stronger worker teardown signal.
    }
  }
}
