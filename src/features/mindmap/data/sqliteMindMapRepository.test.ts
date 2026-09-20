import { describe, expect, it, vi } from "vitest";
import type { DatabaseProvider } from "../../../data/sqliteDatabase";
import { SqliteMindMapRepository } from "./sqliteMindMapRepository";

const legacyTree = {
  schemaVersion: 1, revision: 3, updatedAt: 123, sourcePrompt: "Historical prompt",
  nodes: [
    { id: "root", title: 'A "paper" <tag>', details: "A & B", parentId: null, x: 0, y: 0 },
    { id: "child", title: "Evidence", details: "First\nSecond", parentId: "root", x: 200, y: 0 },
  ],
};

function setup() {
  const select = vi.fn().mockResolvedValue([]);
  const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
  const provider = vi.fn(async () => ({ select, execute })) as unknown as DatabaseProvider;
  return { select, execute, provider, repository: new SqliteMindMapRepository(provider) };
}

describe("SqliteMindMapRepository", () => {
  it("loads paper-scoped source including an intentionally empty map without reviving legacy data", async () => {
    const { select, repository } = setup();
    select.mockResolvedValue([{ source: "" }]);
    expect(await repository.load("paper-1")).toBe("");
    expect(select).toHaveBeenCalledExactlyOnceWith(
      "SELECT source FROM paper_mermaid_maps WHERE paper_id = $1", ["paper-1"],
    );
  });

  it("returns null when neither a Markdown source nor a historical map exists", async () => {
    const { repository, execute } = setup();
    expect(await repository.load("paper-1")).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("stores the exact fenced or unfinished source with bound parameters", async () => {
    const { repository, execute } = setup();
    const source = "```markdown\n# Paper\n- unfinished\n```";
    await repository.save("paper-1", source);
    expect(execute).toHaveBeenCalledWith(expect.stringMatching(/ON CONFLICT \(paper_id\) DO UPDATE/),
      ["paper-1", source, expect.any(Number)]);
    expect(execute.mock.calls[0][0]).not.toContain(source);
  });

  it("converts historical title/details/topology once without changing JSON or overwriting a concurrent save", async () => {
    const { repository, select, execute } = setup();
    select.mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tree_json: JSON.stringify(legacyTree), updated_at: 123 }])
      .mockResolvedValueOnce([{ source: "A newer concurrently saved source" }]);
    expect(await repository.load("paper-1")).toBe("A newer concurrently saved source");
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("ON CONFLICT (paper_id) DO NOTHING"), [
      "paper-1",
      '- A "paper" \\<tag\\> — A \\& B\n  - Evidence — First — Second',
      123,
    ]);
    expect(execute.mock.calls[0][0]).not.toContain("paper_mind_maps");
  });

  it("reports invalid legacy data without writing a replacement", async () => {
    const { repository, select, execute } = setup();
    select.mockResolvedValueOnce([]).mockResolvedValueOnce([{ tree_json: "{broken", updated_at: 123 }]);
    await expect(repository.load("paper-1")).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates paper IDs before accessing storage and propagates write failure", async () => {
    const { repository, provider, execute } = setup();
    await expect(repository.load(" paper-1 ")).rejects.toThrow(/paper/i);
    expect(provider).not.toHaveBeenCalled();
    execute.mockRejectedValueOnce(new Error("disk full"));
    await expect(repository.save("paper-1", "unfinished[")).rejects.toThrow("disk full");
  });
});
