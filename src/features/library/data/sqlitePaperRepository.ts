import { executeWorkspaceCommand, type WorkspaceCommandRunner } from "../../../data/workspaceClient";
import type { Paper } from "../model/paper";
import type { PaperRepository } from "./paperRepository";

export class SqlitePaperRepository implements PaperRepository {
  constructor(private readonly command: WorkspaceCommandRunner = executeWorkspaceCommand) {}

  async list(searchTerm = ""): Promise<Paper[]> {
    return (await this.command<Paper[]>({ type: "list_papers", searchTerm })).value;
  }

  async getById(id: string): Promise<Paper | null> {
    return (await this.command<Paper | null>({ type: "get_paper", id })).value;
  }
}
