export interface NoteRepository {
  load(paperId: string): Promise<string>;
  save(paperId: string, content: string): Promise<void>;
  reveal?(paperId: string): Promise<void>;
}

export class NoteFileConflictError extends Error {
  constructor() {
    super("This Markdown file changed outside PaperCanvas. Copy your draft before reloading the file, then merge your changes.");
  }
}

export interface NoteAutosaveSnapshot {
  draft: string;
  isLoading: boolean;
  loadError: string | null;
  saveError: string | null;
  isSaving: boolean;
}

type Listener = () => void;

const NOTE_LOAD_ERROR = "Your note could not be loaded.";
const NOTE_SAVE_ERROR =
  "Your note could not be saved. Retry when local storage is available.";

export class NoteAutosaveController {
  private readonly listeners = new Set<Listener>();
  private snapshot: NoteAutosaveSnapshot = {
    draft: "",
    isLoading: true,
    loadError: null,
    saveError: null,
    isSaving: false,
  };
  private revision = 0;
  private persistedRevision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saveOperation: Promise<void> | undefined;
  private loadGeneration = 0;
  private isDisposed = false;
  private discardOnLoad = false;

  constructor(
    private readonly paperId: string,
    private readonly repository: NoteRepository,
    private readonly debounceMilliseconds = 500,
  ) {}

  getSnapshot = (): NoteAutosaveSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  isDirty = (): boolean => this.revision > this.persistedRevision;

  load = async (discardDraft = false): Promise<void> => {
    this.discardOnLoad ||= discardDraft;
    const generation = ++this.loadGeneration;
    this.updateSnapshot({ isLoading: true, loadError: null });
    if (this.discardOnLoad) {
      this.clearScheduledSave();
      await this.saveOperation?.catch(() => undefined);
    }

    try {
      const content = await this.repository.load(this.paperId);
      if (this.isDisposed || generation !== this.loadGeneration) return;

      // Preserve edits during initial loading; only an explicit reload discards them.
      if (this.revision === 0 || this.discardOnLoad) {
        this.revision = 0;
        this.persistedRevision = 0;
        this.discardOnLoad = false;
        this.snapshot = {
          ...this.snapshot,
          draft: content,
          saveError: null,
          isLoading: false,
          loadError: null,
        };
      } else {
        this.snapshot = {
          ...this.snapshot,
          isLoading: false,
          loadError: null,
        };
      }
      this.emit();
    } catch {
      if (this.isDisposed || generation !== this.loadGeneration) return;
      this.updateSnapshot({ isLoading: false, loadError: NOTE_LOAD_ERROR });
    }
  };

  setDraft = (draft: string): void => {
    if (this.isDisposed || draft === this.snapshot.draft) return;

    this.revision += 1;
    this.updateSnapshot({ draft, saveError: null });
    this.scheduleSave();
  };

  flush = (): Promise<void> => {
    this.clearScheduledSave();
    if (this.saveOperation) return this.saveOperation;
    if (!this.isDirty()) return Promise.resolve();

    const operation = this.persistLatest();
    this.saveOperation = operation;
    void operation.then(
      () => {
        if (this.saveOperation === operation) this.saveOperation = undefined;
      },
      () => {
        if (this.saveOperation === operation) this.saveOperation = undefined;
      },
    );
    return operation;
  };

  dispose(): void {
    this.isDisposed = true;
    this.loadGeneration += 1;
    this.clearScheduledSave();
    this.listeners.clear();
  }

  private async persistLatest(): Promise<void> {
    this.updateSnapshot({ isSaving: true });

    try {
      while (this.isDirty()) {
        const targetRevision = this.revision;
        const content = this.snapshot.draft;
        await this.repository.save(this.paperId, content);
        this.persistedRevision = targetRevision;
      }
      this.updateSnapshot({ isSaving: false, saveError: null });
    } catch (error) {
      this.updateSnapshot({ isSaving: false, saveError: error instanceof NoteFileConflictError ? error.message : NOTE_SAVE_ERROR });
      throw error;
    }
  }

  private scheduleSave(): void {
    this.clearScheduledSave();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => undefined);
    }, this.debounceMilliseconds);
  }

  private clearScheduledSave(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private updateSnapshot(update: Partial<NoteAutosaveSnapshot>): void {
    if (this.isDisposed) return;
    this.snapshot = { ...this.snapshot, ...update };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
