import {
  getDatabase,
  type DatabaseProvider,
} from "../../../data/sqliteDatabase";
import {
  MindMapValidationError,
  validateMindMapPaperId,
  validateMindMapTree,
  type MindMapTree,
} from "../model/mindMap";
import type { MindMapRepository } from "./mindMapRepository";

interface MindMapRow {
  tree_json: string;
  schema_version: number;
  revision: number;
  updated_at: number;
}

export class MindMapRevisionConflictError extends Error {
  constructor() {
    super("The mind map changed in another operation. Reload it before saving.");
    this.name = "MindMapRevisionConflictError";
  }
}

function parseStoredTree(row: MindMapRow): MindMapTree {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.tree_json);
  } catch {
    throw new MindMapValidationError("Stored mind map JSON is not valid.");
  }
  const tree = validateMindMapTree(parsed);
  if (
    row.schema_version !== tree.schemaVersion ||
    row.revision !== tree.revision ||
    row.updated_at !== tree.updatedAt
  ) {
    throw new MindMapValidationError(
      "Stored mind map revision metadata does not match its JSON document.",
    );
  }
  return tree;
}

export class SqliteMindMapRepository implements MindMapRepository {
  constructor(private readonly databaseProvider: DatabaseProvider = getDatabase) {}

  async load(paperId: string): Promise<MindMapTree | null> {
    const validatedPaperId = validateMindMapPaperId(paperId);
    const database = await this.databaseProvider();
    const rows = await database.select<MindMapRow[]>(
      `SELECT tree_json, schema_version, revision, updated_at
       FROM paper_mind_maps
       WHERE paper_id = $1`,
      [validatedPaperId],
    );
    return rows[0] ? parseStoredTree(rows[0]) : null;
  }

  async save(
    paperId: string,
    value: MindMapTree,
    expectedRevision: number,
  ): Promise<void> {
    const validatedPaperId = validateMindMapPaperId(paperId);
    const tree = validateMindMapTree(value);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new MindMapValidationError(
        "expectedRevision must be a non-negative integer.",
      );
    }
    if (tree.revision !== expectedRevision + 1) {
      throw new MindMapValidationError(
        "Mind map revision must advance expectedRevision by exactly one.",
      );
    }

    const database = await this.databaseProvider();
    const result = await database.execute(
      `INSERT INTO paper_mind_maps (
         paper_id, tree_json, schema_version, revision, updated_at
       )
       SELECT $1, $2, $3, $4, $5
       WHERE $6 = 0
          OR EXISTS (
            SELECT 1
            FROM paper_mind_maps
            WHERE paper_id = $1 AND revision = $6
          )
       ON CONFLICT (paper_id) DO UPDATE SET
         tree_json = excluded.tree_json,
         schema_version = excluded.schema_version,
         revision = excluded.revision,
         updated_at = excluded.updated_at
       WHERE paper_mind_maps.revision = $6`,
      [
        validatedPaperId,
        JSON.stringify(tree),
        tree.schemaVersion,
        tree.revision,
        tree.updatedAt,
        expectedRevision,
      ],
    );
    if (result.rowsAffected !== 1) throw new MindMapRevisionConflictError();
  }
}

export const sqliteMindMapRepository = new SqliteMindMapRepository();
