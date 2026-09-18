export interface PaperLibraryMutator {
  deletePaper(paperId: string): Promise<void>;
  reconcileStorage(): Promise<void>;
}
