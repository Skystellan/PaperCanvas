import {
  getDatabase,
  type DatabaseProvider,
} from "../../../data/sqliteDatabase";
import {
  isValidPdfHighlightContent,
  parseNormalizedPdfRects,
  type PdfHighlight,
  type PdfHighlightRepository,
} from "../model/pdfHighlight";

interface HighlightRow {
  comment: string;
  created_at: number;
  id: string;
  page_number: number;
  paper_id: string;
  rects_json: string;
  selected_text: string;
  updated_at: number;
}

function toHighlight(row: HighlightRow): PdfHighlight | null {
  const highlight: PdfHighlight = {
    comment: row.comment,
    createdAt: row.created_at,
    id: row.id,
    pageNumber: row.page_number,
    paperId: row.paper_id,
    rects: parseNormalizedPdfRects(row.rects_json),
    text: row.selected_text,
    updatedAt: row.updated_at,
  };
  return isValidPdfHighlightContent(highlight) ? highlight : null;
}

export class SqliteHighlightRepository implements PdfHighlightRepository {
  constructor(private readonly databaseProvider: DatabaseProvider = getDatabase) {}

  async load(paperId: string): Promise<PdfHighlight[]> {
    const database = await this.databaseProvider();
    const rows = await database.select<HighlightRow[]>(
      `SELECT id, paper_id, page_number, selected_text, comment, rects_json,
              created_at, updated_at
       FROM pdf_highlights
       WHERE paper_id = $1
       ORDER BY page_number ASC, created_at ASC`,
      [paperId],
    );
    return rows.flatMap((row) => {
      const highlight = toHighlight(row);
      return highlight ? [highlight] : [];
    });
  }

  async save(highlight: PdfHighlight): Promise<void> {
    if (!isValidPdfHighlightContent(highlight, { requireRects: true })) {
      throw new Error("The highlight exceeds PaperCanvas safety limits.");
    }
    const database = await this.databaseProvider();
    await database.execute(
      `INSERT INTO pdf_highlights (
         id, paper_id, page_number, selected_text, comment, rects_json,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         page_number = excluded.page_number,
         selected_text = excluded.selected_text,
         comment = excluded.comment,
         rects_json = excluded.rects_json,
         updated_at = excluded.updated_at`,
      [
        highlight.id,
        highlight.paperId,
        highlight.pageNumber,
        highlight.text,
        highlight.comment,
        JSON.stringify(highlight.rects),
        highlight.createdAt,
        highlight.updatedAt,
      ],
    );
  }

  async remove(paperId: string, highlightId: string): Promise<void> {
    const database = await this.databaseProvider();
    await database.execute(
      `DELETE FROM pdf_highlights
       WHERE paper_id = $1 AND id = $2`,
      [paperId, highlightId],
    );
  }
}

export const sqliteHighlightRepository = new SqliteHighlightRepository();
