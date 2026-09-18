import type { Edge, Node } from "@xyflow/react";
import type { MindMapTree } from "./mindMap";
import { MIND_MAP_NODE_HEIGHT, MIND_MAP_NODE_WIDTH } from "./mindMapLayout";

export interface MindMapNodeData extends Record<string, unknown> {
  details: string;
  isRoot: boolean;
  title: string;
}

export type MindMapFlowNode = Node<MindMapNodeData, "mind-map">;
export type MindMapFlowEdge = Edge<Record<string, never>, "straight">;

export function toMindMapFlowNodes(tree: MindMapTree): MindMapFlowNode[] {
  return tree.nodes.map((node) => ({
    id: node.id,
    type: "mind-map",
    position: { x: node.x, y: node.y },
    data: {
      details: node.details,
      isRoot: node.parentId === null,
      title: node.title,
    },
    deletable: false,
    style: {
      height: MIND_MAP_NODE_HEIGHT,
      width: MIND_MAP_NODE_WIDTH,
    },
  }));
}

export function toMindMapFlowEdges(tree: MindMapTree): MindMapFlowEdge[] {
  return tree.nodes.flatMap((node) =>
    node.parentId === null
      ? []
      : [
          {
            id: `mind-map-edge:${node.id}`,
            source: node.parentId,
            target: node.id,
            type: "straight" as const,
            deletable: false,
            selectable: false,
          },
        ],
  );
}
