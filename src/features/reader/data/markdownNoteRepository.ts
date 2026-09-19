import { invoke } from "../../../platform/core";
import { getDatabase } from "../../../data/sqliteDatabase";
import { NoteFileConflictError, type NoteRepository } from "../model/noteAutosaveController";

export class MarkdownNoteRepository implements NoteRepository {
  private readonly loaded = new Map<string, string>();

  async load(paperId: string): Promise<string> {
    await getDatabase();
    const content = await invoke<string>("load_markdown_note", { paperId });
    this.loaded.set(paperId, content);
    return content;
  }

  async save(paperId: string, content: string): Promise<void> {
    const expected = this.loaded.get(paperId);
    if (expected === undefined) throw new Error("Load the Markdown file before saving.");
    try {
      await invoke("save_markdown_note", { paperId, content, expected });
      this.loaded.set(paperId, content);
    } catch (error) {
      if (error === "NOTE_FILE_CHANGED") throw new NoteFileConflictError();
      throw error;
    }
  }

  async reveal(paperId: string): Promise<void> {
    await invoke("reveal_markdown_note", { paperId });
  }
}

export const markdownNoteRepository = new MarkdownNoteRepository();
