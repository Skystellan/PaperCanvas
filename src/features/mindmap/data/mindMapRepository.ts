export interface MindMapRepository {
  load(paperId: string): Promise<string | null>;
  save(paperId: string, source: string): Promise<void>;
}
