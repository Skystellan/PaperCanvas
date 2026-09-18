import { describe, expect, it, vi } from "vitest";
import { SqliteNoteRepository } from "./sqliteNoteRepository";

describe("SqliteNoteRepository", () => {
  it("loads the primary note with a parameterized paper id", async () => {
    const select = vi.fn().mockResolvedValue([{ body: "A durable note" }]);
    const repository = new SqliteNoteRepository(async () => ({ select }) as never);

    await expect(repository.load("paper-1")).resolves.toBe("A durable note");
    expect(select).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE paper_id = \$1/),
      ["paper-1"],
    );
  });

  it("returns an empty draft when a paper has no note", async () => {
    const select = vi.fn().mockResolvedValue([]);
    const repository = new SqliteNoteRepository(async () => ({ select }) as never);

    await expect(repository.load("paper-without-note")).resolves.toBe("");
  });

  it("upserts one primary note without interpolating user content", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
    const repository = new SqliteNoteRepository(async () => ({ execute }) as never);
    const hostileDraft = "'); DROP TABLE papers; --";

    await repository.save("paper-1", hostileDraft);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/ON CONFLICT\s*\(paper_id\)/),
      ["paper-1", hostileDraft],
    );
    expect(execute.mock.calls[0]?.[0]).not.toContain(hostileDraft);
  });
});
