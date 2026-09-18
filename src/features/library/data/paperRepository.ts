import type { Paper } from "../model/paper";

export interface PaperRepository {
  list(searchTerm?: string): Promise<Paper[]>;
  getById(id: string): Promise<Paper | null>;
}
