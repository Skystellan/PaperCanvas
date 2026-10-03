import { executeWorkspaceCommand, type WorkspaceCommandRunner, type WorkspaceRequest } from "../../../data/workspaceClient";
import type { BoardRepository, BoardSnapshot } from "./boardRepository";
import type { BoardEdgeAnnotations, BoardEdgeRecord, BoardEdgeRelation } from "../model/boardEdge";
import type { BoardNodeRecord, NodePositionUpdate } from "../model/boardNode";

export const DEFAULT_BOARD_ID = "board-default";
export const DEFAULT_NODE_SIZE = { width: 280, height: 128 } as const;

// Each adapter owns the revision of its loaded board. Unrelated reads must never
// silently advance this baseline and allow stale UI drafts to overwrite a newer board.
export class SqliteBoardRepository implements BoardRepository {
  private revision: number | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly command: WorkspaceCommandRunner = executeWorkspaceCommand) {}

  private run<T>(request: WorkspaceRequest, read = false): Promise<T> {
    const operation = this.queue.then(async () => {
      if (!read && this.revision === undefined) throw new Error("Load the board before editing it.");
      const response = await this.command<T>(request, read ? undefined : this.revision);
      this.revision = response.revision;
      return response.value;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  loadBoard(): Promise<BoardSnapshot> {
    return this.run({ type: "load_board" }, true);
  }

  async updatePaperGithub(paperId: string, githubUrl: string | null, githubStars: number | null): Promise<void> {
    await this.run({ type: "update_paper_github", paperId, githubUrl, githubStars });
  }

  async updatePaperGithubStars(paperId: string, githubUrl: string, githubStars: number): Promise<void> {
    await this.run({ type: "update_paper_github_stars", paperId, githubUrl, githubStars });
  }

  async saveNodePositions(updates: NodePositionUpdate[]): Promise<void> {
    if (updates.length) await this.run({ type: "save_node_positions", updates });
  }

  createPaperNode(paperId: string, position: { x: number; y: number }): Promise<BoardNodeRecord> {
    return this.run({ type: "create_paper_node", paperId, position });
  }

  createEdge(sourceNodeId: string, targetNodeId: string): Promise<BoardEdgeRecord> {
    return this.run({ type: "create_edge", sourceNodeId, targetNodeId });
  }

  async updateEdgeRelation(edgeId: string, relation: BoardEdgeRelation): Promise<void> {
    await this.run({ type: "update_edge_relation", edgeId, relation });
  }

  async updateEdgeAnnotations(edgeId: string, annotations: BoardEdgeAnnotations): Promise<void> {
    await this.run({ type: "update_edge_annotations", edgeId, annotations });
  }

  async deleteNodes(nodeIds: string[]): Promise<void> {
    if (nodeIds.length) await this.run({ type: "delete_nodes", nodeIds: [...new Set(nodeIds)] });
  }

  async deleteEdges(edgeIds: string[]): Promise<void> {
    if (edgeIds.length) await this.run({ type: "delete_edges", edgeIds: [...new Set(edgeIds)] });
  }
}

export const boardRepository = new SqliteBoardRepository();
