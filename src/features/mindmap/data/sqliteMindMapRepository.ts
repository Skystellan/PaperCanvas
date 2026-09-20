import { getDatabase, type DatabaseProvider } from "../../../data/sqliteDatabase";
import { legacyMindMapToMarkdown } from "../model/legacyMindMap";
import type { MindMapRepository } from "./mindMapRepository";

function validatePaperId(paperId: string): void {
  if (!paperId.trim() || paperId !== paperId.trim() || paperId.length > 256) {
    throw new Error("A valid paper ID is required to store a mind map.");
  }
}

export class SqliteMindMapRepository implements MindMapRepository {
  constructor(private readonly databaseProvider: DatabaseProvider = getDatabase) {}

  async load(paperId: string): Promise<string | null> {
    validatePaperId(paperId);
    const database = await this.databaseProvider();
    const rows = await database.select<{ source: string }[]>(
      "SELECT source FROM paper_mermaid_maps WHERE paper_id = $1",
      [paperId],
    );
    if (rows[0]) return rows[0].source;

    const legacy = await database.select<{ tree_json: string; updated_at: number }[]>(
      "SELECT tree_json, updated_at FROM paper_mind_maps WHERE paper_id = $1",
      [paperId],
    );
    if (!legacy[0]) return null;
    const source = legacyMindMapToMarkdown(legacy[0].tree_json);
    // Never overwrite a newer source save or alter the historical JSON row.
    await database.execute(
      `INSERT INTO paper_mermaid_maps (paper_id, source, updated_at)
       VALUES ($1, $2, $3) ON CONFLICT (paper_id) DO NOTHING`,
      [paperId, source, legacy[0].updated_at],
    );
    const migrated = await database.select<{ source: string }[]>(
      "SELECT source FROM paper_mermaid_maps WHERE paper_id = $1",
      [paperId],
    );
    return migrated[0]?.source ?? null;
  }

  async save(paperId: string, source: string): Promise<void> {
    validatePaperId(paperId);
    const database = await this.databaseProvider();
    await database.execute(
      `INSERT INTO paper_mermaid_maps (paper_id, source, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (paper_id) DO UPDATE SET
         source = excluded.source, updated_at = excluded.updated_at`,
      [paperId, source, Date.now()],
    );
  }
}

export const sqliteMindMapRepository = new SqliteMindMapRepository();
