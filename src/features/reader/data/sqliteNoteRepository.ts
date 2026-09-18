import {
  getDatabase,
  type DatabaseProvider,
} from "../../../data/sqliteDatabase";
import type { NoteRepository } from "../model/noteAutosaveController";

interface NoteRow {
  body: string;
}

export class SqliteNoteRepository implements NoteRepository {
  constructor(private readonly databaseProvider: DatabaseProvider = getDatabase) {}

  async load(paperId: string): Promise<string> {
    const database = await this.databaseProvider();
    const rows = await database.select<NoteRow[]>(
      `SELECT content AS body
       FROM notes
       WHERE paper_id = $1
       LIMIT 1`,
      [paperId],
    );

    return rows[0]?.body ?? "";
  }

  async save(paperId: string, content: string): Promise<void> {
    const database = await this.databaseProvider();
    await database.execute(
      `INSERT INTO notes (id, paper_id, content, updated_at)
       VALUES ('note-' || $1, $1, $2, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
       ON CONFLICT (paper_id) DO UPDATE SET
         content = excluded.content,
         updated_at = excluded.updated_at`,
      [paperId, content],
    );
  }
}

export const sqliteNoteRepository = new SqliteNoteRepository();
