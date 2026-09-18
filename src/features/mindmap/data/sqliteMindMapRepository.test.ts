import { describe, expect, it, vi } from "vitest";
import type { MindMapTree } from "../model/mindMap";
import {
  MindMapRevisionConflictError,
  SqliteMindMapRepository,
} from "./sqliteMindMapRepository";

const tree: MindMapTree = {
  schemaVersion: 1,
  revision: 2,
  sourcePrompt: "Explain the evidence",
  nodes: [
    {
      id: "root",
      title: "Evidence",
      details: "",
      parentId: null,
      x: 0,
      y: 0,
    },
  ],
  updatedAt: 900,
};

describe("SqliteMindMapRepository", () => {
  it("loads one paper-scoped JSON tree through a bound parameter", async () => {
    const select = vi.fn().mockResolvedValue([
      {
        tree_json: JSON.stringify(tree),
        schema_version: 1,
        revision: 2,
        updated_at: 900,
      },
    ]);
    const repository = new SqliteMindMapRepository(
      async () => ({ select }) as never,
    );

    await expect(repository.load("paper-1")).resolves.toEqual(tree);
    expect(select).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE paper_id = \$1/),
      ["paper-1"],
    );
  });

  it("returns null when the paper has no mind map", async () => {
    const select = vi.fn().mockResolvedValue([]);
    const repository = new SqliteMindMapRepository(
      async () => ({ select }) as never,
    );
    await expect(repository.load("paper-1")).resolves.toBeNull();
  });

  it("rejects corrupted metadata instead of trusting JSON alone", async () => {
    const select = vi.fn().mockResolvedValue([
      {
        tree_json: JSON.stringify(tree),
        schema_version: 1,
        revision: 99,
        updated_at: 900,
      },
    ]);
    const repository = new SqliteMindMapRepository(
      async () => ({ select }) as never,
    );

    await expect(repository.load("paper-1")).rejects.toThrow(/revision/i);
  });

  it("rejects malformed stored JSON", async () => {
    const select = vi.fn().mockResolvedValue([
      {
        tree_json: "{broken-json",
        schema_version: 1,
        revision: 1,
        updated_at: 1,
      },
    ]);
    const repository = new SqliteMindMapRepository(
      async () => ({ select }) as never,
    );

    await expect(repository.load("paper-1")).rejects.toThrow(/JSON/i);
  });

  it("atomically upserts a whole tree with compare-and-swap revision semantics", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
    const repository = new SqliteMindMapRepository(
      async () => ({ execute }) as never,
    );

    await repository.save("paper-1", tree, 1);

    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(
        /WHERE \$6 = 0\s+OR EXISTS[\s\S]*ON CONFLICT[\s\S]*WHERE paper_mind_maps\.revision = \$6/,
      ),
      ["paper-1", JSON.stringify(tree), 1, 2, 900, 1],
    );
    expect(execute.mock.calls[0]?.[0]).not.toContain(tree.sourcePrompt);
  });

  it("reports stale revisions and never retries with a blind overwrite", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 0 });
    const repository = new SqliteMindMapRepository(
      async () => ({ execute }) as never,
    );

    await expect(repository.save("paper-1", tree, 1)).rejects.toBeInstanceOf(
      MindMapRevisionConflictError,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("validates revision progression and paper IDs before opening the database", async () => {
    const databaseProvider = vi.fn();
    const repository = new SqliteMindMapRepository(databaseProvider);

    await expect(repository.save("paper-1", tree, 0)).rejects.toThrow(
      /revision/i,
    );
    await expect(repository.load(" paper-1 ")).rejects.toThrow(/paper/i);
    expect(databaseProvider).not.toHaveBeenCalled();
  });
});
