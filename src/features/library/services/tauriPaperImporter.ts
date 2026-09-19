import { invoke } from "../../../platform/core";
import { open } from "../../../platform/dialog";

import type { Paper } from "../model/paper";
import type { PaperImporter, PaperImportOptions } from "./paperImporter";

const IMPORT_ERROR_MESSAGE = "无法导入 PDF，请确认文件有效且未损坏。";

export class PaperImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaperImportError";
  }
}

export class PaperBatchImportError extends PaperImportError {
  readonly importedPapers: readonly Paper[];
  readonly failedCount: number;

  constructor(importedPapers: readonly Paper[], failedCount = 1) {
    super(IMPORT_ERROR_MESSAGE);
    this.name = "PaperBatchImportError";
    this.importedPapers = [...importedPapers];
    this.failedCount = failedCount;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableIdentifier(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && value.trim().length > 0 && value.length <= 128)
  );
}

function isNullableYear(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value));
}

function parseImportedPaper(value: unknown): Paper {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.title !== "string" ||
    value.title.length === 0 ||
    !isNullableString(value.authors) ||
    !isNullableYear(value.year) ||
    typeof value.filePath !== "string" ||
    value.filePath.length === 0 ||
    !isNullableIdentifier(value.domainId) ||
    typeof value.createdAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0
  ) {
    throw new PaperImportError(IMPORT_ERROR_MESSAGE);
  }

  return {
    id: value.id,
    title: value.title,
    authors: value.authors,
    year: value.year,
    filePath: value.filePath,
    domainId: value.domainId,
    createdAt: value.createdAt,
  };
}

function getDomainId(options: PaperImportOptions): string | null {
  const domainId = options.domainId ?? null;
  if (!isNullableIdentifier(domainId)) {
    throw new PaperImportError(IMPORT_ERROR_MESSAGE);
  }
  return domainId;
}

export class TauriPaperImporter implements PaperImporter {
  async chooseAndImport(options: PaperImportOptions = {}): Promise<Paper[]> {
    const domainId = getDomainId(options);
    let sourcePaths: string[] | null;

    try {
      sourcePaths = await open({
        directory: false,
        multiple: true,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
    } catch {
      throw new PaperImportError("无法打开文件选择器，请重试。");
    }

    if (sourcePaths === null) {
      return [];
    }

    return this.importPaths(sourcePaths, { domainId });
  }

  async importPaths(
    paths: readonly string[],
    options: PaperImportOptions = {},
  ): Promise<Paper[]> {
    const domainId = getDomainId(options);
    const papers: Paper[] = [];
    let failedCount = 0;
    for (const path of paths) {
      try {
        papers.push(await this.importPath(path, domainId));
      } catch {
        failedCount += 1;
      }
    }
    if (failedCount > 0) {
      throw new PaperBatchImportError(papers, failedCount);
    }
    return papers;
  }

  private async importPath(
    sourcePath: string,
    domainId: string | null,
  ): Promise<Paper> {
    try {
      const result = await invoke<unknown>("import_pdf", {
        sourcePath,
        domainId,
      });
      return parseImportedPaper(result);
    } catch (error) {
      if (error instanceof PaperImportError) {
        throw error;
      }
      throw new PaperImportError(IMPORT_ERROR_MESSAGE);
    }
  }
}
