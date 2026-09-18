import type { Paper } from "../model/paper";

export interface PaperImportOptions {
  domainId?: string | null;
}

export interface PaperImporter {
  chooseAndImport(options?: PaperImportOptions): Promise<Paper[]>;
  importPaths(
    paths: readonly string[],
    options?: PaperImportOptions,
  ): Promise<Paper[]>;
}
