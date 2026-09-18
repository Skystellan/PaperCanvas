import type { Node } from "@xyflow/react";
import type { Paper } from "../../library";

export type PaperSummary = Paper;

export interface BoardNodeRecord {
  id: string;
  boardId: string;
  paper: PaperSummary;
  position: {
    x: number;
    y: number;
  };
  size: {
    width: number;
    height: number;
  };
}

export interface PaperNodeData extends Record<string, unknown> {
  onKeyboardConnectionSelect?: (nodeId: string) => void;
  paper: PaperSummary;
}

export type PaperFlowNode = Node<PaperNodeData, "paper">;

export interface NodePositionUpdate {
  id: string;
  x: number;
  y: number;
}

export function toFlowNode(record: BoardNodeRecord): PaperFlowNode {
  return {
    id: record.id,
    type: "paper",
    position: { ...record.position },
    data: { paper: record.paper },
    deletable: false,
    style: {
      width: record.size.width,
      height: record.size.height,
    },
  };
}

export function toPositionUpdates(
  nodes: PaperFlowNode[],
): NodePositionUpdate[] {
  return nodes.map((node) => ({
    id: node.id,
    x: node.position.x,
    y: node.position.y,
  }));
}
