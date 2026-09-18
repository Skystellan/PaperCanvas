import {
  getDatabase,
  type DatabaseProvider,
} from "../../../data/sqliteDatabase";
import type { Paper } from "../model/paper";
import type { PaperRepository } from "./paperRepository";

interface PaperRow {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  file_path: string | null;
  domain_id: string | null;
  created_at: number;
}

const PAPER_COLUMNS = `
  id,
  title,
  authors,
  year,
  file_path,
  domain_id,
  created_at
`;

function toPaper(row: PaperRow): Paper {
  return {
    id: row.id,
    title: row.title,
    authors: row.authors,
    year: row.year,
    filePath: row.file_path,
    domainId: row.domain_id,
    createdAt: row.created_at,
  };
}

export class SqlitePaperRepository implements PaperRepository {
  constructor(private readonly databaseProvider: DatabaseProvider = getDatabase) {}

  async list(searchTerm = ""): Promise<Paper[]> {
    const database = await this.databaseProvider();
    const searchPattern = `%${searchTerm.trim()}%`;
    const rows = await database.select<PaperRow[]>(
      `
        SELECT ${PAPER_COLUMNS}
        FROM papers
        WHERE title LIKE ?1 COLLATE NOCASE
           OR COALESCE(authors, '') LIKE ?1 COLLATE NOCASE
        ORDER BY created_at DESC, title COLLATE NOCASE ASC
      `,
      [searchPattern],
    );

    return rows.map(toPaper);
  }

  async getById(id: string): Promise<Paper | null> {
    const database = await this.databaseProvider();
    const rows = await database.select<PaperRow[]>(
      `
        SELECT ${PAPER_COLUMNS}
        FROM papers
        WHERE id = ?1
        LIMIT 1
      `,
      [id],
    );

    return rows[0] ? toPaper(rows[0]) : null;
  }
}
