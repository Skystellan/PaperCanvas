import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseProvider } from "../../../data/sqliteDatabase";
import { SqlitePaperRepository } from "./sqlitePaperRepository";

const database = {
  select: vi.fn(),
};

const getDatabase = vi.fn(async () => database) as unknown as DatabaseProvider;

describe("SqlitePaperRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists papers using a parameterized search and maps nullable metadata", async () => {
    database.select.mockResolvedValue([
      {
        id: "paper-1",
        title: "Attention Is All You Need",
        authors: null,
        year: null,
        file_path: "papers/paper-1.pdf",
        domain_id: "domain-ai",
        created_at: 1_774_000_000_000,
      },
      {
        id: "paper-legacy",
        title: "A legacy paper",
        authors: "A. Researcher",
        year: 1999,
        file_path: null,
        domain_id: null,
        created_at: 1,
      },
    ]);
    const repository = new SqlitePaperRepository(getDatabase);

    await expect(repository.list("attention")).resolves.toEqual([
      {
        id: "paper-1",
        title: "Attention Is All You Need",
        authors: null,
        year: null,
        filePath: "papers/paper-1.pdf",
        domainId: "domain-ai",
        createdAt: 1_774_000_000_000,
      },
      {
        id: "paper-legacy",
        title: "A legacy paper",
        authors: "A. Researcher",
        year: 1999,
        filePath: null,
        domainId: null,
        createdAt: 1,
      },
    ]);
    expect(database.select).toHaveBeenCalledWith(
      expect.stringMatching(/FROM papers[\s\S]*LIKE/),
      ["%attention%"],
    );
  });

  it("uses an empty parameterized pattern when listing every paper", async () => {
    database.select.mockResolvedValue([]);
    const repository = new SqlitePaperRepository(getDatabase);

    await expect(repository.list()).resolves.toEqual([]);

    expect(database.select).toHaveBeenCalledWith(expect.any(String), ["%%"]);
  });

  it("gets one paper by its stable id without interpolating it into SQL", async () => {
    database.select.mockResolvedValue([
      {
        id: "paper-' OR 1=1 --",
        title: "Parameterized",
        authors: "Safe Author",
        year: 2026,
        file_path: "papers/safe.pdf",
        domain_id: null,
        created_at: 1_774_000_000_000,
      },
    ]);
    const repository = new SqlitePaperRepository(getDatabase);

    await expect(repository.getById("paper-' OR 1=1 --")).resolves.toMatchObject({
      id: "paper-' OR 1=1 --",
      title: "Parameterized",
    });
    const [query, parameters] = database.select.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(query).not.toContain("paper-' OR 1=1 --");
    expect(parameters).toEqual(["paper-' OR 1=1 --"]);
  });

  it("returns null when a paper id is unknown", async () => {
    database.select.mockResolvedValue([]);
    const repository = new SqlitePaperRepository(getDatabase);

    await expect(repository.getById("missing")).resolves.toBeNull();
  });
});
