import TauriDatabase, { type QueryResult } from "@tauri-apps/plugin-sql";

export default class Database {
  constructor(public path: string) {}

  static async load(path: string) {
    if (!window.paperCanvas) return TauriDatabase.load(path);
    return new Database(await window.paperCanvas.invoke<string>("database_load"));
  }

  select<T>(query: string, values: unknown[] = []): Promise<T> {
    return window.paperCanvas!.invoke<T>("database_select", { query, values });
  }

  execute(query: string, values: unknown[] = []): Promise<QueryResult> {
    return window.paperCanvas!.invoke<QueryResult>("database_execute", { query, values });
  }
}
