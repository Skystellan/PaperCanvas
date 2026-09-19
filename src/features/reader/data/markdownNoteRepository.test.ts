import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MarkdownNoteRepository } from "./markdownNoteRepository";
import { NoteFileConflictError } from "../model/noteAutosaveController";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../../data/sqliteDatabase", () => ({ getDatabase: vi.fn().mockResolvedValue({}) }));
beforeEach(() => vi.mocked(invoke).mockReset());

describe("MarkdownNoteRepository", () => {
  it("binds saves to the paper and last successfully read/written content", async () => {
    const repository = new MarkdownNoteRepository();
    vi.mocked(invoke).mockResolvedValueOnce("old").mockResolvedValue(undefined);
    await repository.load("p-1");
    await repository.save("p-1", "new");
    await repository.save("p-1", "newer");
    expect(invoke).toHaveBeenLastCalledWith("save_markdown_note", { paperId: "p-1", content: "newer", expected: "new" });
    await expect(repository.save("p-2", "unloaded")).rejects.toThrow("Load the Markdown");
  });

  it("retains the comparison baseline after a conflict and accepts a reload", async () => {
    const repository = new MarkdownNoteRepository();
    vi.mocked(invoke).mockResolvedValueOnce("old");
    await repository.load("p-1");
    vi.mocked(invoke).mockRejectedValueOnce("NOTE_FILE_CHANGED");
    await expect(repository.save("p-1", "draft")).rejects.toBeInstanceOf(NoteFileConflictError);
    vi.mocked(invoke).mockResolvedValueOnce("external").mockResolvedValue(undefined);
    await repository.load("p-1");
    await repository.save("p-1", "merged");
    expect(invoke).toHaveBeenLastCalledWith("save_markdown_note", { paperId: "p-1", content: "merged", expected: "external" });
  });
});
