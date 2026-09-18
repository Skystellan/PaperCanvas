import { invoke } from "@tauri-apps/api/core";

import type { PaperLibraryMutator } from "./paperLibraryMutator";

export class TauriPaperLibraryMutator implements PaperLibraryMutator {
  private reconciliationOperation: Promise<void> | null = null;

  async deletePaper(paperId: string): Promise<void> {
    await invoke<void>("delete_paper", { paperId });
  }

  reconcileStorage(): Promise<void> {
    if (!this.reconciliationOperation) {
      this.reconciliationOperation = Promise.resolve().then(() =>
        invoke<void>("reconcile_pdf_storage"),
      );
    }
    return this.reconciliationOperation;
  }
}
