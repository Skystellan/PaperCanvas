import type { MindMapTree } from "../model/mindMap";

export interface MindMapRepository {
  load(paperId: string): Promise<MindMapTree | null>;
  save(
    paperId: string,
    tree: MindMapTree,
    expectedRevision: number,
  ): Promise<void>;
}
