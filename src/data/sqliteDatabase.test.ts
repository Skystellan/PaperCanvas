import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: sql.load },
}));

import {
  DATABASE_URL,
  SqliteDatabaseProvider,
} from "./sqliteDatabase";

describe("SqliteDatabaseProvider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shares one connection promise across repositories", async () => {
    const database = { select: vi.fn(), execute: vi.fn() };
    sql.load.mockResolvedValue(database);
    const provider = new SqliteDatabaseProvider();

    const [first, second] = await Promise.all([
      provider.getDatabase(),
      provider.getDatabase(),
    ]);

    expect(first).toBe(database);
    expect(second).toBe(database);
    expect(sql.load).toHaveBeenCalledOnce();
    expect(sql.load).toHaveBeenCalledWith(DATABASE_URL);
  });

  it("retries after a failed initial connection", async () => {
    const database = { select: vi.fn(), execute: vi.fn() };
    sql.load
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(database);
    const provider = new SqliteDatabaseProvider();

    await expect(provider.getDatabase()).rejects.toThrow("offline");
    await expect(provider.getDatabase()).resolves.toBe(database);
    expect(sql.load).toHaveBeenCalledTimes(2);
  });
});
