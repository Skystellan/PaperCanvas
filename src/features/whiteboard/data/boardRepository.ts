import type {
  BoardNodeRecord,
  NodePositionUpdate,
} from "../model/boardNode";
import type { BoardEdgeRecord, BoardEdgeRelation } from "../model/boardEdge";

export interface BoardSnapshot {
  nodes: BoardNodeRecord[];
  edges: BoardEdgeRecord[];
}

export interface BoardRepository {
  loadBoard(): Promise<BoardSnapshot>;
  saveNodePositions(updates: NodePositionUpdate[]): Promise<void>;
  createPaperNode(
    paperId: string,
    position: { x: number; y: number },
  ): Promise<BoardNodeRecord>;
  createEdge(
    sourceNodeId: string,
    targetNodeId: string,
  ): Promise<BoardEdgeRecord>;
  updateEdgeRelation(edgeId: string, relation: BoardEdgeRelation): Promise<void>;
  deleteEdges(edgeIds: string[]): Promise<void>;
}
