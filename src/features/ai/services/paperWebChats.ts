import { invoke } from "../../../platform/core";
import { getDatabase } from "../../../data/sqliteDatabase";

export interface PaperWebChat {
  id: string;
  paperId: string;
  title: string;
  url: string | null;
  lastOpenedAt: number;
}

export async function listPaperWebChats(paperId: string): Promise<PaperWebChat[]> {
  await getDatabase(); // Applies schema migrations before Rust reads the same database.
  return invoke("list_paper_web_chats", { paperId });
}

// Serialize native view updates, including cleanup, to prevent an old panel showing over a new one.
let layoutQueue = Promise.resolve();
export function layoutPaperWebChat(id: string, bounds: { x: number; y: number; width: number; height: number; viewportHeight: number } | null): Promise<void> {
  const next = layoutQueue.then(() => invoke<void>("layout_paper_web_chat", { id, bounds }));
  layoutQueue = next.catch(() => {});
  return next;
}

export interface RecentPaperWebChat extends PaperWebChat {
  paperTitle: string;
}

export async function listRecentPaperWebChats(limit = 6): Promise<RecentPaperWebChat[]> {
  const database = await getDatabase();
  return database.select<RecentPaperWebChat[]>(
    `SELECT c.id, c.paper_id AS paperId, c.title, c.url,
            c.last_opened_at AS lastOpenedAt, p.title AS paperTitle
     FROM paper_web_chats c JOIN papers p ON p.id = c.paper_id
     ORDER BY c.last_opened_at DESC, c.created_at DESC, c.id
     LIMIT $1`,
    [Math.max(0, Math.floor(limit))],
  );
}
