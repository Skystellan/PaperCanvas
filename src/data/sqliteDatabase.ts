import Database from "@tauri-apps/plugin-sql";

export const DATABASE_URL = "sqlite:papercanvas.db";

export type SqliteDatabase = Awaited<ReturnType<typeof Database.load>>;
export type DatabaseProvider = () => Promise<SqliteDatabase>;

export class SqliteDatabaseProvider {
  private connectionPromise: Promise<SqliteDatabase> | undefined;

  getDatabase(): Promise<SqliteDatabase> {
    if (!this.connectionPromise) {
      const connectionPromise = Database.load(DATABASE_URL);
      this.connectionPromise = connectionPromise;
      void connectionPromise.catch(() => {
        if (this.connectionPromise === connectionPromise) {
          this.connectionPromise = undefined;
        }
      });
    }

    return this.connectionPromise;
  }
}

const sharedDatabaseProvider = new SqliteDatabaseProvider();

export const getDatabase: DatabaseProvider = () =>
  sharedDatabaseProvider.getDatabase();
