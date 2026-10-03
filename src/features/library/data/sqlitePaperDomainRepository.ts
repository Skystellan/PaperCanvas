import { executeWorkspaceCommand, type WorkspaceCommandRunner } from "../../../data/workspaceClient";
import type { PaperDomainRepository } from "./paperDomainRepository";
import type { PaperDomain } from "../model/paperDomain";

export class SqlitePaperDomainRepository implements PaperDomainRepository {
  constructor(private readonly command: WorkspaceCommandRunner = executeWorkspaceCommand) {}

  async list(): Promise<PaperDomain[]> {
    return (await this.command<PaperDomain[]>({ type: "list_domains" })).value;
  }

  async create(name: string): Promise<PaperDomain> {
    return (await this.command<PaperDomain>({ type: "create_domain", name })).value;
  }

  async rename(domainId: string, name: string): Promise<void> {
    await this.command({ type: "rename_domain", domainId, name });
  }

  async delete(domainId: string): Promise<void> {
    await this.command({ type: "delete_domain", domainId });
  }

  async assignPaper(paperId: string, domainId: string | null): Promise<void> {
    await this.command({ type: "assign_paper", paperId, domainId });
  }
}

export const sqlitePaperDomainRepository = new SqlitePaperDomainRepository();
