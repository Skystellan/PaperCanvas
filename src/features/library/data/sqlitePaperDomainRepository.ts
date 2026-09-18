import {
  getDatabase,
  type DatabaseProvider,
} from "../../../data/sqliteDatabase";
import type { PaperDomainRepository } from "./paperDomainRepository";
import {
  normalizePaperDomainName,
  type PaperDomain,
} from "../model/paperDomain";

interface PaperDomainRow {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

function requireIdentifier(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${label}不能为空。`);
  }
  return value;
}

function requireSingleRow(rowsAffected: number, message: string): void {
  if (rowsAffected !== 1) {
    throw new Error(message);
  }
}

function toPaperDomain(row: PaperDomainRow): PaperDomain {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqlitePaperDomainRepository implements PaperDomainRepository {
  constructor(
    private readonly databaseProvider: DatabaseProvider = getDatabase,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async list(): Promise<PaperDomain[]> {
    const database = await this.databaseProvider();
    const rows = await database.select<PaperDomainRow[]>(
      `SELECT id, name, created_at, updated_at
       FROM paper_domains
       ORDER BY name COLLATE NOCASE ASC, id ASC`,
    );
    return rows.map(toPaperDomain);
  }

  async create(name: string): Promise<PaperDomain> {
    const normalizedName = normalizePaperDomainName(name);
    const timestamp = this.now();
    const domain: PaperDomain = {
      id: this.createId(),
      name: normalizedName,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const database = await this.databaseProvider();
    const result = await database.execute(
      `INSERT INTO paper_domains (id, name, created_at, updated_at)
       VALUES ($1, $2, $3, $3)`,
      [domain.id, domain.name, domain.createdAt],
    );
    requireSingleRow(result.rowsAffected, "领域未能创建。");
    return domain;
  }

  async rename(domainId: string, name: string): Promise<void> {
    const id = requireIdentifier(domainId, "领域标识");
    const normalizedName = normalizePaperDomainName(name);
    const database = await this.databaseProvider();
    const result = await database.execute(
      `UPDATE paper_domains
       SET name = $1, updated_at = $2
       WHERE id = $3`,
      [normalizedName, this.now(), id],
    );
    requireSingleRow(result.rowsAffected, "找不到要重命名的领域。");
  }

  async delete(domainId: string): Promise<void> {
    const id = requireIdentifier(domainId, "领域标识");
    const database = await this.databaseProvider();
    const result = await database.execute(
      `DELETE FROM paper_domains WHERE id = $1`,
      [id],
    );
    requireSingleRow(result.rowsAffected, "找不到要删除的领域。");
  }

  async assignPaper(paperId: string, domainId: string | null): Promise<void> {
    const paper = requireIdentifier(paperId, "论文标识");
    const domain =
      domainId === null ? null : requireIdentifier(domainId, "领域标识");
    const database = await this.databaseProvider();
    const result = await database.execute(
      `UPDATE papers SET domain_id = $1 WHERE id = $2`,
      [domain, paper],
    );
    requireSingleRow(result.rowsAffected, "找不到要归类的论文。");
  }
}

export const sqlitePaperDomainRepository = new SqlitePaperDomainRepository();
