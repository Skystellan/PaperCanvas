import { invoke, isTauri } from "../platform/core";
import { listen } from "../platform/event";
import { getDatabase } from "./sqliteDatabase";
import type { NodePositionUpdate } from "../features/whiteboard/model/boardNode";
import type { BoardEdgeAnnotations, BoardEdgeRelation } from "../features/whiteboard/model/boardEdge";
import type { CodeReviewUpdate, ResearchBatchInput, ResearchContextIntent } from "../features/research/research";

export type WorkspaceRequest =
  | { type: "import_research_batch"; batch: ResearchBatchInput }
  | { type: "read_research_context"; intent: ResearchContextIntent; paperIds?: string[] }
  | { type: "save_paper_code_reviews"; reviews: CodeReviewUpdate[] }
  | { type: "list_research_batches" }
  | { type: "undo_research_batch"; batchId: string }
  | { type: "load_board" | "list_domains" }
  | { type: "list_papers"; searchTerm?: string }
  | { type: "get_paper"; id: string }
  | { type: "create_domain"; name: string }
  | { type: "rename_domain"; domainId: string; name: string }
  | { type: "delete_domain"; domainId: string }
  | { type: "assign_paper"; paperId: string; domainId: string | null }
  | { type: "update_paper_title"; paperId: string; title: string }
  | { type: "update_paper_github"; paperId: string; githubUrl: string | null; githubStars: number | null }
  | { type: "create_paper_node"; paperId: string; position: { x: number; y: number } }
  | { type: "create_edge"; sourceNodeId: string; targetNodeId: string }
  | { type: "update_edge_relation"; edgeId: string; relation: BoardEdgeRelation }
  | { type: "update_edge_annotations"; edgeId: string; annotations: BoardEdgeAnnotations }
  | { type: "save_node_positions"; updates: NodePositionUpdate[] }
  | { type: "delete_nodes"; nodeIds: string[] }
  | { type: "delete_edges"; edgeIds: string[] };

export interface WorkspaceResponse<T> {
  revision: number;
  value: T;
}

export type WorkspaceCommandRunner = <T>(request: WorkspaceRequest, expectedRevision?: number) => Promise<WorkspaceResponse<T>>;

export class WorkspaceConflictError extends Error {
  constructor() {
    super("工作区已被其他操作修改，当前未保存内容已保留。请重新载入后再操作。");
    this.name = "WorkspaceConflictError";
  }
}

// Attribution prevents our own completed operations from reloading in-flight UI drafts.
// This token is not an authorization credential.
export const workspaceOrigin = crypto.randomUUID();

export const executeWorkspaceCommand: WorkspaceCommandRunner = async <T>(
  request: WorkspaceRequest,
  expectedRevision?: number,
) => {
  await getDatabase(); // Applies Tauri migrations before the shared service opens SQLite.
  try {
    return await invoke<WorkspaceResponse<T>>("workspace_command", {
      request, origin: workspaceOrigin,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
  } catch (error) {
    if (error === "WORKSPACE_CONFLICT") throw new WorkspaceConflictError();
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export function listenForExternalWorkspaceChanges(onChange: () => void) {
  if (!isTauri()) return Promise.resolve(() => {});
  return listen<{ revision: number; origin?: string | null }>("workspace-changed", ({ payload }) => {
    if (payload.origin !== workspaceOrigin) onChange();
  });
}
