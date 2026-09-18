import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseProvider } from "../../../data/sqliteDatabase";
import { SqlitePaperDomainRepository } from "./sqlitePaperDomainRepository";

const database = {
  execute: vi.fn(),
  select: vi.fn(),
};

const getDatabase = vi.fn(async () => database) as unknown as DatabaseProvider;

describe("SqlitePaperDomainRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.execute.mockResolvedValue({ rowsAffected: 1 });
  });

  it("lists domains in a stable, case-insensitive name order", async () => {
    database.select.mockResolvedValue([
      {
        id: "domain-ai",
        name: "AI",
        created_at: 10,
        updated_at: 20,
      },
    ]);
    const repository = new SqlitePaperDomainRepository(getDatabase);

    await expect(repository.list()).resolves.toEqual([
      {
        id: "domain-ai",
        name: "AI",
        createdAt: 10,
        updatedAt: 20,
      },
    ]);
    expect(database.select).toHaveBeenCalledWith(
      expect.stringMatching(/ORDER BY name COLLATE NOCASE/),
    );
  });

  it("normalizes a valid name and inserts it with generated metadata", async () => {
    const repository = new SqlitePaperDomainRepository(
      getDatabase,
      () => "domain-generated",
      () => 123,
    );

    await expect(repository.create("  Human–AI  ")).resolves.toEqual({
      id: "domain-generated",
      name: "Human–AI",
      createdAt: 123,
      updatedAt: 123,
    });
    expect(database.execute).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO paper_domains/),
      ["domain-generated", "Human–AI", 123],
    );
  });

  it.each(["", "   ", "a".repeat(81)])(
    "rejects an invalid domain name before opening the database: %j",
    async (name) => {
      const repository = new SqlitePaperDomainRepository(getDatabase);

      await expect(repository.create(name)).rejects.toThrow(/领域名称/);
      expect(getDatabase).not.toHaveBeenCalled();
    },
  );

  it("renames, deletes, and assigns with parameterized identifiers", async () => {
    const repository = new SqlitePaperDomainRepository(
      getDatabase,
      () => "unused",
      () => 456,
    );

    await repository.rename("domain-' OR 1=1 --", "  Systems  ");
    await repository.assignPaper("paper-' OR 1=1 --", "domain-ai");
    await repository.assignPaper("paper-2", null);
    await repository.delete("domain-ai");

    expect(database.execute.mock.calls).toEqual([
      [
        expect.stringMatching(/UPDATE paper_domains/),
        ["Systems", 456, "domain-' OR 1=1 --"],
      ],
      [
        expect.stringMatching(/UPDATE papers/),
        ["domain-ai", "paper-' OR 1=1 --"],
      ],
      [expect.stringMatching(/UPDATE papers/), [null, "paper-2"]],
      [expect.stringMatching(/DELETE FROM paper_domains/), ["domain-ai"]],
    ]);
    for (const [query] of database.execute.mock.calls as [string, unknown[]][]) {
      expect(query).not.toContain("' OR 1=1 --");
    }
  });

  it("reports stale identifiers instead of silently claiming success", async () => {
    database.execute.mockResolvedValue({ rowsAffected: 0 });
    const repository = new SqlitePaperDomainRepository(getDatabase);

    await expect(repository.rename("missing", "New name")).rejects.toThrow();
    await expect(repository.assignPaper("missing", null)).rejects.toThrow();
    await expect(repository.delete("missing")).rejects.toThrow();
  });
});
