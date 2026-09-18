import { invoke } from "@tauri-apps/api/core";
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
