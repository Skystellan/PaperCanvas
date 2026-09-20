import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import type {
  DatabaseProvider,
  SqliteDatabase,
} from "../../../data/sqliteDatabase";
import {
  DEFAULT_BOARD_ID,
  SqliteBoardRepository,
} from "./sqliteBoardRepository";

const sql = {
  select: vi.fn(),
  execute: vi.fn(),
};

function createRepository(ids = ["generated-node", "generated-edge"]) {
  const database = sql as unknown as SqliteDatabase;
  const getDatabase: DatabaseProvider = vi.fn().mockResolvedValue(database);
  const createId = vi.fn(() => {
    const id = ids.shift();
    if (!id) throw new Error("test ran out of IDs");
    return id;
  });
  return {
    repository: new SqliteBoardRepository(getDatabase, createId),
    getDatabase,
  };
}

const paperNodeRow = {
  id: "node-attention",
  board_id: DEFAULT_BOARD_ID,
  paper_id: "paper-attention",
  title: "Attention Is All You Need",
  authors: "Vaswani et al.",
  year: 2017,
  file_path: "papers/attention.pdf",
  domain_id: "domain-ml",
  created_at: 1_700_000_000_000,
  x: 120,
  y: 80,
  width: 280,
  height: 128,
};

describe("SqliteBoardRepository", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads one board snapshot with persisted nodes and edges", async () => {
    sql.select
      .mockResolvedValueOnce([paperNodeRow])
      .mockResolvedValueOnce([
        {
          id: "edge-1",
          board_id: DEFAULT_BOARD_ID,
          source_node_id: "node-attention",
          target_node_id: "node-bert",
          relation_type: "challenge",
          explanation: "Different result",
          evidence: "Page 7",
        },
      ]);
    const { repository, getDatabase } = createRepository();

    await expect(repository.loadBoard()).resolves.toEqual({
      nodes: [
        {
          id: "node-attention",
          boardId: DEFAULT_BOARD_ID,
          paper: {
            id: "paper-attention",
            title: "Attention Is All You Need",
            authors: "Vaswani et al.",
            year: 2017,
            filePath: "papers/attention.pdf",
            domainId: "domain-ml",
            createdAt: 1_700_000_000_000,
          },
          position: { x: 120, y: 80 },
          size: { width: 280, height: 128 },
        },
      ],
      edges: [
        {
          id: "edge-1",
          boardId: DEFAULT_BOARD_ID,
          sourceNodeId: "node-attention",
          targetNodeId: "node-bert",
          relation: "challenge",
          explanation: "Different result",
          evidence: "Page 7",
        },
      ],
    });
    expect(getDatabase).toHaveBeenCalledOnce();
    expect(sql.select).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM board_nodes"),
      [DEFAULT_BOARD_ID],
    );
    expect(sql.select).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM board_edges"),
      [DEFAULT_BOARD_ID],
    );
  });

  it("persists a position snapshot with one atomic, board-scoped statement", async () => {
    sql.execute.mockResolvedValue({ rowsAffected: 2 });
    const { repository } = createRepository();

    await repository.saveNodePositions([
      { id: "node-attention", x: 310, y: 220 },
      { id: "node-bert", x: 720, y: 410 },
    ]);

    expect(sql.execute).toHaveBeenCalledWith(
      expect.stringMatching(
        /WITH positions[\s\S]*UPDATE board_nodes[\s\S]*board_nodes\.board_id/,
      ),
      [
        "node-attention",
        310,
        220,
        "node-bert",
        720,
        410,
        DEFAULT_BOARD_ID,
      ],
    );
  });

  it("rejects the whole snapshot when any stable node is missing", async () => {
    sql.execute.mockResolvedValue({ rowsAffected: 0 });
    const { repository } = createRepository();

    await expect(
      repository.saveNodePositions([
        { id: "node-missing", x: 10, y: 20 },
        { id: "node-attention", x: 30, y: 40 },
      ]),
    ).rejects.toThrow("node-missing");
  });

  it("creates a paper node DB-first and returns its persisted identifier", async () => {
    sql.execute.mockResolvedValue({ rowsAffected: 1 });
    sql.select.mockResolvedValue([
      { ...paperNodeRow, id: "generated-node", x: 44, y: 72 },
    ]);
    const { repository } = createRepository();

    await expect(
      repository.createPaperNode("paper-attention", { x: 44, y: 72 }),
    ).resolves.toMatchObject({
      id: "generated-node",
      paper: { id: "paper-attention" },
      position: { x: 44, y: 72 },
    });
    expect(sql.execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO board_nodes"),
      [
        "generated-node",
        DEFAULT_BOARD_ID,
        "paper-attention",
        44,
        72,
        280,
        128,
      ],
    );
    expect(sql.select).toHaveBeenCalledWith(
      expect.stringContaining("board_nodes.id = $2"),
      [DEFAULT_BOARD_ID, "generated-node"],
    );
  });

  it("does not return a ghost paper node when insertion fails", async () => {
    sql.execute.mockRejectedValue(new Error("duplicate paper"));
    const { repository } = createRepository();

    await expect(
      repository.createPaperNode("paper-attention", { x: 44, y: 72 }),
    ).rejects.toThrow("duplicate paper");
    expect(sql.select).not.toHaveBeenCalled();
  });

  it("creates an ordinary edge with one stable persisted id", async () => {
    sql.execute.mockResolvedValue({ rowsAffected: 1 });
    const { repository } = createRepository(["edge-generated"]);

    await expect(
      repository.createEdge("node-attention", "node-bert"),
    ).resolves.toEqual({
      id: "edge-generated",
      boardId: DEFAULT_BOARD_ID,
      sourceNodeId: "node-attention",
      targetNodeId: "node-bert",
      relation: null,
      explanation: "",
      evidence: "",
    });
    expect(sql.execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO board_edges"),
      [
        "edge-generated",
        DEFAULT_BOARD_ID,
        "node-attention",
        "node-bert",
        expect.any(Number),
      ],
    );
  });

  it("rejects malformed and self-referencing edges before opening SQLite", async () => {
    const { repository, getDatabase } = createRepository();

    await expect(repository.createEdge("", "node-b")).rejects.toThrow(
      "endpoints",
    );
    await expect(repository.createEdge("node-a", "node-a")).rejects.toThrow(
      "itself",
    );
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it("updates one edge relation inside the default board", async () => {
    sql.execute.mockResolvedValue({ rowsAffected: 1 });
    const { repository } = createRepository();

    expect(repository).toHaveProperty("updateEdgeRelation");
    if (!("updateEdgeRelation" in repository)) return;
    await (
      repository as typeof repository & {
        updateEdgeRelation(edgeId: string, relation: "support"): Promise<void>;
      }
    ).updateEdgeRelation("edge-1", "support");

    expect(sql.execute).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE board_edges[\s\S]*board_id/),
      ["support", "edge-1", DEFAULT_BOARD_ID],
    );
  });

  it("deletes an exact edge batch atomically and board-scoped", async () => {
    sql.execute.mockResolvedValue({ rowsAffected: 2 });
    const { repository } = createRepository();

    await repository.deleteEdges(["edge-a", "edge-b", "edge-a"]);

    expect(sql.execute).toHaveBeenCalledOnce();
    expect(sql.execute).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM board_edges[\s\S]*board_id/),
      ["edge-a", "edge-b", DEFAULT_BOARD_ID],
    );
  });

  it("reports stale edge deletion and skips empty writes", async () => {
    sql.execute.mockResolvedValue({ rowsAffected: 0 });
    const { repository, getDatabase } = createRepository();

    await expect(repository.deleteEdges(["edge-missing"])).rejects.toThrow(
      "edge-missing",
    );
    await expect(repository.deleteEdges([])).resolves.toBeUndefined();
    expect(getDatabase).toHaveBeenCalledOnce();
  });

  it("removes only card rows with a scoped atomic batch, retaining library papers", async () => {
    sql.execute.mockResolvedValue({ rowsAffected: 2 });
    const { repository } = createRepository();
    await repository.deleteNodes(["node-a", "node-b", "node-a"]);
    expect(sql.execute).toHaveBeenCalledOnce();
    expect(sql.execute).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM board_nodes[\s\S]*board_id/),
      ["node-a", "node-b", DEFAULT_BOARD_ID],
    );
    expect(sql.execute.mock.calls[0][0]).not.toMatch(/DELETE FROM papers/);
    sql.select.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(repository.loadBoard()).resolves.toEqual({ nodes: [], edges: [] });
    expect(sql.execute).toHaveBeenCalledOnce();
  });

  it("rejects a stale node batch and skips empty deletion", async () => {
    const { repository, getDatabase } = createRepository();
    sql.execute.mockResolvedValue({ rowsAffected: 0 });
    await expect(repository.deleteNodes(["missing", "present"])).rejects.toThrow("missing");
    await repository.deleteNodes([]);
    expect(getDatabase).toHaveBeenCalledOnce();
  });

  it("saves explanation and evidence together and reads them back unchanged", async () => {
    const { repository } = createRepository();
    const annotations = { explanation: "支持相同结论", evidence: "第 4 页：原文\n包含引号 ' 和换行" };
    sql.execute.mockResolvedValue({ rowsAffected: 1 });
    await repository.updateEdgeAnnotations("edge-a", annotations);
    expect(sql.execute).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE board_edges SET explanation = \$1, evidence = \$2[\s\S]*board_id = \$4/),
      [annotations.explanation, annotations.evidence, "edge-a", DEFAULT_BOARD_ID],
    );
    sql.select.mockResolvedValueOnce([]).mockResolvedValueOnce([{
      id: "edge-a", board_id: DEFAULT_BOARD_ID, source_node_id: "a", target_node_id: "b",
      relation_type: "support", ...annotations,
    }]);
    expect((await repository.loadBoard()).edges[0]).toMatchObject(annotations);
    sql.execute.mockResolvedValue({ rowsAffected: 0 });
    await expect(repository.updateEdgeAnnotations("missing", annotations)).rejects.toThrow("stale");
  });
});

it("round-trips annotations and card removal through real migrated SQLite, preserving papers for drag-back", async () => {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  try {
    const migrationDirectory = resolve("src-tauri/migrations");
    for (const file of readdirSync(migrationDirectory).filter((file) => /^\d+.*\.sql$/.test(file) && Number(file.slice(0, 4)) <= 16).sort()) {
      database.exec(readFileSync(join(migrationDirectory, file), "utf8"));
    }
    // rusqlite/sqlx bind the array by SQLite parameter index. For named $N
    // parameters, indices follow first appearance in SQL, not the N suffix.
    const positionalBindings = (query: string, values: SQLInputValue[]) =>
      Object.fromEntries([...new Set(query.match(/\$\d+/g))].map((name, i) => [name, values[i]]));
    const adapter = {
      select: async (query: string, values: SQLInputValue[] = []) => database.prepare(query).all(positionalBindings(query, values)),
      execute: async (query: string, values: SQLInputValue[] = []) => ({
        rowsAffected: Number(database.prepare(query).run(positionalBindings(query, values)).changes),
      }),
    } as unknown as SqliteDatabase;
    let revision = 0;
    const repository = new SqliteBoardRepository(async () => adapter, () => `created-${++revision}`);
    database.exec("UPDATE papers SET file_path = 'papers/attention.pdf' WHERE id = 'paper-attention'");
    const papersBefore = database.prepare("SELECT * FROM papers ORDER BY id").all();
    const edge = await repository.createEdge("node-attention", "node-bert");
    const annotations = { explanation: "支持这个结论", evidence: "第 4 页\n原文摘录" };
    await repository.updateEdgeAnnotations(edge.id, annotations);
    const reloaded = new SqliteBoardRepository(async () => adapter);
    expect((await reloaded.loadBoard()).edges[0]).toMatchObject(annotations);

    const retainedEdge = await repository.createEdge("node-bert", "node-resnet");
    const otherEdge = await repository.createEdge("node-attention", "node-resnet");
    await expect(repository.deleteEdges([edge.id, "missing"])).rejects.toThrow("stale");
    expect((await reloaded.loadBoard()).edges).toHaveLength(3);
    await repository.deleteEdges([edge.id, otherEdge.id]);
    expect((await reloaded.loadBoard()).edges.map(({ id }) => id)).toEqual([retainedEdge.id]);

    await expect(repository.deleteNodes(["node-attention", "missing"])).rejects.toThrow("stale");
    expect((await reloaded.loadBoard()).nodes).toHaveLength(3);
    await repository.deleteNodes(["node-attention", "node-bert"]);
    const after = await reloaded.loadBoard();
    expect(after.nodes.map(({ id }) => id)).toEqual(["node-resnet"]);
    expect(after.edges).toEqual([]);
    expect(database.prepare("SELECT * FROM papers ORDER BY id").all()).toEqual(papersBefore);

    await repository.createPaperNode("paper-attention", { x: 30, y: 50 });
    const restored = (await reloaded.loadBoard()).nodes.find(({ paper }) => paper.id === "paper-attention");
    expect(restored).toMatchObject({ position: { x: 30, y: 50 }, paper: { filePath: "papers/attention.pdf" } });
    expect(restored?.id).not.toBe("node-attention");
  } finally {
    database.close();
  }
});
