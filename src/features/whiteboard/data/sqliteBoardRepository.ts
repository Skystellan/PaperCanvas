import {
  getDatabase,
  type DatabaseProvider,
} from "../../../data/sqliteDatabase";
import type { BoardRepository, BoardSnapshot } from "./boardRepository";
import type { BoardEdgeAnnotations, BoardEdgeRecord, BoardEdgeRelation } from "../model/boardEdge";
import type {
  BoardNodeRecord,
  NodePositionUpdate,
} from "../model/boardNode";

export const DEFAULT_BOARD_ID = "board-default";
export const DEFAULT_NODE_SIZE = { width: 280, height: 128 } as const;

interface BoardNodeRow {
  id: string;
  board_id: string;
  paper_id: string;
  title: string;
  authors: string | null;
  year: number | null;
  file_path: string | null;
  domain_id: string | null;
  created_at: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BoardEdgeRow {
  id: string;
  board_id: string;
  source_node_id: string;
  target_node_id: string;
  relation_type: BoardEdgeRelation;
  explanation: string;
  evidence: string;
}

const SELECT_BOARD_NODES = `
  SELECT
    board_nodes.id,
    board_nodes.board_id,
    board_nodes.paper_id,
    papers.title,
    papers.authors,
    papers.year,
    papers.file_path,
    papers.domain_id,
    papers.created_at,
    board_nodes.x,
    board_nodes.y,
    board_nodes.width,
    board_nodes.height
  FROM board_nodes
  INNER JOIN papers ON papers.id = board_nodes.paper_id
  WHERE board_nodes.board_id = $1
  ORDER BY board_nodes.id
`;

const SELECT_BOARD_NODE_BY_ID = `
  SELECT
    board_nodes.id,
    board_nodes.board_id,
    board_nodes.paper_id,
    papers.title,
    papers.authors,
    papers.year,
    papers.file_path,
    papers.domain_id,
    papers.created_at,
    board_nodes.x,
    board_nodes.y,
    board_nodes.width,
    board_nodes.height
  FROM board_nodes
  INNER JOIN papers ON papers.id = board_nodes.paper_id
  WHERE board_nodes.board_id = $1 AND board_nodes.id = $2
`;

const SELECT_BOARD_EDGES = `
  SELECT id, board_id, source_node_id, target_node_id, relation_type, explanation, evidence
  FROM board_edges
  WHERE board_id = $1
  ORDER BY id
`;

function toBoardNodeRecord(row: BoardNodeRow): BoardNodeRecord {
  return {
    id: row.id,
    boardId: row.board_id,
    paper: {
      id: row.paper_id,
      title: row.title,
      authors: row.authors,
      year: row.year,
      filePath: row.file_path,
      domainId: row.domain_id,
      createdAt: row.created_at,
    },
    position: { x: row.x, y: row.y },
    size: { width: row.width, height: row.height },
  };
}

function toBoardEdgeRecord(row: BoardEdgeRow): BoardEdgeRecord {
  return {
    id: row.id,
    boardId: row.board_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    relation: row.relation_type,
    explanation: row.explanation,
    evidence: row.evidence,
  };
}

function createPositionSnapshotStatement(updates: NodePositionUpdate[]) {
  const boardParameter = updates.length * 3 + 1;
  const values = updates
    .map((_, index) => {
      const firstParameter = index * 3 + 1;
      return `($${firstParameter}, $${firstParameter + 1}, $${firstParameter + 2})`;
    })
    .join(", ");

  return `
    WITH positions(id, x, y) AS (
      VALUES ${values}
    )
    UPDATE board_nodes
    SET
      x = (SELECT positions.x FROM positions WHERE positions.id = board_nodes.id),
      y = (SELECT positions.y FROM positions WHERE positions.id = board_nodes.id)
    WHERE board_nodes.board_id = $${boardParameter}
      AND board_nodes.id IN (SELECT positions.id FROM positions)
      AND (
        SELECT COUNT(*)
        FROM board_nodes AS persisted_nodes
        WHERE persisted_nodes.board_id = $${boardParameter}
          AND persisted_nodes.id IN (SELECT positions.id FROM positions)
      ) = (SELECT COUNT(*) FROM positions)
  `;
}

function createDeleteStatement(table: "board_edges" | "board_nodes", edgeCount: number) {
  const ids = Array.from({ length: edgeCount }, (_, index) => `$${index + 1}`);
  const boardParameter = edgeCount + 1;

  // SQLite binds $N names by first appearance when the backend passes an array.
  return `
    DELETE FROM ${table}
    WHERE id IN (${ids.join(", ")})
      AND board_id = $${boardParameter}
      AND (
        SELECT COUNT(*)
        FROM ${table} AS persisted_edges
        WHERE persisted_edges.board_id = $${boardParameter}
          AND persisted_edges.id IN (${ids.join(", ")})
      ) = ${edgeCount}
  `;
}

export class SqliteBoardRepository implements BoardRepository {
  constructor(
    private readonly databaseProvider: DatabaseProvider = getDatabase,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  async loadBoard(): Promise<BoardSnapshot> {
    const database = await this.databaseProvider();
    const nodeRows = await database.select<BoardNodeRow[]>(SELECT_BOARD_NODES, [
      DEFAULT_BOARD_ID,
    ]);
    const edgeRows = await database.select<BoardEdgeRow[]>(SELECT_BOARD_EDGES, [
      DEFAULT_BOARD_ID,
    ]);

    return {
      nodes: nodeRows.map(toBoardNodeRecord),
      edges: edgeRows.map(toBoardEdgeRecord),
    };
  }

  async saveNodePositions(updates: NodePositionUpdate[]): Promise<void> {
    if (updates.length === 0) return;

    const database = await this.databaseProvider();
    const parameters = [
      ...updates.flatMap(({ id, x, y }) => [id, x, y]),
      DEFAULT_BOARD_ID,
    ];
    const result = await database.execute(
      createPositionSnapshotStatement(updates),
      parameters,
    );

    if (result.rowsAffected !== updates.length) {
      throw new Error(
        `Board node snapshot is stale: ${updates.map(({ id }) => id).join(", ")}`,
      );
    }
  }

  async createPaperNode(
    paperId: string,
    position: { x: number; y: number },
  ): Promise<BoardNodeRecord> {
    if (
      paperId.trim().length === 0 ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y)
    ) {
      throw new Error("Paper node input is invalid.");
    }

    const id = this.createId();
    const database = await this.databaseProvider();
    const result = await database.execute(
      `INSERT INTO board_nodes
       (id, board_id, paper_id, x, y, width, height)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        DEFAULT_BOARD_ID,
        paperId,
        position.x,
        position.y,
        DEFAULT_NODE_SIZE.width,
        DEFAULT_NODE_SIZE.height,
      ],
    );
    if (result.rowsAffected !== 1) {
      throw new Error("The paper card was not created.");
    }

    const rows = await database.select<BoardNodeRow[]>(SELECT_BOARD_NODE_BY_ID, [
      DEFAULT_BOARD_ID,
      id,
    ]);
    const row = rows[0];
    if (!row) throw new Error("The created paper card could not be reloaded.");
    return toBoardNodeRecord(row);
  }

  async createEdge(
    sourceNodeId: string,
    targetNodeId: string,
  ): Promise<BoardEdgeRecord> {
    if (sourceNodeId.trim().length === 0 || targetNodeId.trim().length === 0) {
      throw new Error("Edge endpoints are required.");
    }
    if (sourceNodeId === targetNodeId) {
      throw new Error("A paper card cannot connect to itself.");
    }

    const edge: BoardEdgeRecord = {
      id: this.createId(),
      boardId: DEFAULT_BOARD_ID,
      sourceNodeId,
      targetNodeId,
      relation: null,
      explanation: "",
      evidence: "",
    };
    const database = await this.databaseProvider();
    const result = await database.execute(
      `INSERT INTO board_edges
       (id, board_id, source_node_id, target_node_id, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        edge.id,
        edge.boardId,
        edge.sourceNodeId,
        edge.targetNodeId,
        Date.now(),
      ],
    );
    if (result.rowsAffected !== 1) {
      throw new Error("The paper connection was not created.");
    }
    return edge;
  }

  async updateEdgeRelation(
    edgeId: string,
    relation: BoardEdgeRelation,
  ): Promise<void> {
    if (
      edgeId.trim().length === 0 ||
      (relation !== null && relation !== "support" && relation !== "challenge")
    ) {
      throw new Error("Edge relation input is invalid.");
    }
    const database = await this.databaseProvider();
    const result = await database.execute(
      `UPDATE board_edges
       SET relation_type = $1
       WHERE id = $2 AND board_id = $3`,
      [relation, edgeId, DEFAULT_BOARD_ID],
    );
    if (result.rowsAffected !== 1) {
      throw new Error(`Board edge relation is stale: ${edgeId}`);
    }
  }

  async updateEdgeAnnotations(edgeId: string, annotations: BoardEdgeAnnotations): Promise<void> {
    const database = await this.databaseProvider();
    const result = await database.execute(
      `UPDATE board_edges SET explanation = $1, evidence = $2
       WHERE id = $3 AND board_id = $4`,
      [annotations.explanation, annotations.evidence, edgeId, DEFAULT_BOARD_ID],
    );
    if (result.rowsAffected !== 1) {
      throw new Error(`Board edge annotations are stale: ${edgeId}`);
    }
  }

  async deleteNodes(nodeIds: string[]): Promise<void> {
    const ids = [...new Set(nodeIds)];
    if (ids.length === 0) return;
    const database = await this.databaseProvider();
    // Existing foreign keys cascade only to attached edges, never to papers/PDFs.
    const result = await database.execute(createDeleteStatement("board_nodes", ids.length), [
      ...ids, DEFAULT_BOARD_ID,
    ]);
    if (result.rowsAffected !== ids.length) {
      throw new Error(`Board node deletion is stale: ${ids.join(", ")}`);
    }
  }

  async deleteEdges(edgeIds: string[]): Promise<void> {
    const uniqueEdgeIds = [...new Set(edgeIds)];
    if (uniqueEdgeIds.length === 0) return;

    const database = await this.databaseProvider();
    const result = await database.execute(
      createDeleteStatement("board_edges", uniqueEdgeIds.length),
      [...uniqueEdgeIds, DEFAULT_BOARD_ID],
    );
    if (result.rowsAffected !== uniqueEdgeIds.length) {
      throw new Error(`Board edge deletion is stale: ${uniqueEdgeIds.join(", ")}`);
    }
  }
}

export const boardRepository = new SqliteBoardRepository();
