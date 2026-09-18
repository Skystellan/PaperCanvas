import { describe, expect, it, vi } from "vitest";
import { SqliteHighlightRepository } from "./sqliteHighlightRepository";
import type { PdfHighlight } from "../model/pdfHighlight";
import { MAX_PDF_SELECTION_TEXT_BYTES } from "../model/pdfLimits";

const highlight: PdfHighlight = {
  comment: "Important boundary condition",
  createdAt: 100,
  id: "highlight-1",
  pageNumber: 3,
  paperId: "paper-1",
  rects: [{ height: 0.03, left: 0.1, top: 0.2, width: 0.4 }],
  text: "A durable quoted passage",
  updatedAt: 120,
};

describe("SqliteHighlightRepository", () => {
  it("loads highlights with parameter binding and tolerates malformed rectangle JSON", async () => {
    const select = vi.fn().mockResolvedValue([
      {
        comment: highlight.comment,
        created_at: highlight.createdAt,
        id: highlight.id,
        page_number: highlight.pageNumber,
        paper_id: highlight.paperId,
        rects_json: JSON.stringify(highlight.rects),
        selected_text: highlight.text,
        updated_at: highlight.updatedAt,
      },
      {
        comment: "Still searchable",
        created_at: 200,
        id: "highlight-with-bad-json",
        page_number: 4,
        paper_id: highlight.paperId,
        rects_json: "{not-json",
        selected_text: "Keep the annotation row",
        updated_at: 200,
      },
    ]);
    const repository = new SqliteHighlightRepository(
      async () => ({ select }) as never,
    );

    await expect(repository.load("paper-1")).resolves.toEqual([
      highlight,
      expect.objectContaining({ id: "highlight-with-bad-json", rects: [] }),
    ]);
    expect(select).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE paper_id = \$1/),
      ["paper-1"],
    );
  });

  it("upserts all user content through parameters", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
    const repository = new SqliteHighlightRepository(
      async () => ({ execute }) as never,
    );

    await repository.save(highlight);

    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/ON CONFLICT\s*\(id\)/),
      [
        highlight.id,
        highlight.paperId,
        highlight.pageNumber,
        highlight.text,
        highlight.comment,
        JSON.stringify(highlight.rects),
        highlight.createdAt,
        highlight.updatedAt,
      ],
    );
    expect(execute.mock.calls[0]?.[0]).not.toContain(highlight.text);
  });

  it("deletes only a paper-scoped highlight through parameters", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
    const repository = new SqliteHighlightRepository(
      async () => ({ execute }) as never,
    );

    await repository.remove("paper-1", "highlight-1");

    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE paper_id = \$1 AND id = \$2/),
      ["paper-1", "highlight-1"],
    );
  });

  it("drops oversized stored content and refuses to persist it again", async () => {
    const oversizedText = "x".repeat(MAX_PDF_SELECTION_TEXT_BYTES + 1);
    const select = vi.fn().mockResolvedValue([
      {
        comment: highlight.comment,
        created_at: highlight.createdAt,
        id: highlight.id,
        page_number: highlight.pageNumber,
        paper_id: highlight.paperId,
        rects_json: JSON.stringify(highlight.rects),
        selected_text: oversizedText,
        updated_at: highlight.updatedAt,
      },
    ]);
    const execute = vi.fn();
    const repository = new SqliteHighlightRepository(
      async () => ({ execute, select }) as never,
    );

    await expect(repository.load(highlight.paperId)).resolves.toEqual([]);
    await expect(
      repository.save({ ...highlight, text: oversizedText }),
    ).rejects.toThrow(/safety limits/i);
    expect(execute).not.toHaveBeenCalled();
  });
});
