import { describe, expect, it } from "vitest";
import {
  toFlowNode,
  toPositionUpdates,
  type BoardNodeRecord,
} from "./boardNode";

const persistedNode: BoardNodeRecord = {
  id: "node-attention",
  boardId: "board-default",
  paper: {
    id: "paper-attention",
    title: "Attention Is All You Need",
    authors: "Vaswani et al.",
    year: 2017,
    filePath: "papers/attention.pdf",
    domainId: null,
    createdAt: 1,
  },
  position: { x: 120, y: 80 },
  size: { width: 280, height: 128 },
};

describe("board node mapping", () => {
  it("keeps the persisted node id, paper, position, and size", () => {
    const flowNode = toFlowNode(persistedNode);

    expect(flowNode).toMatchObject({
      id: "node-attention",
      type: "paper",
      position: { x: 120, y: 80 },
      data: { paper: persistedNode.paper },
      deletable: true,
      style: { width: 280, height: 128 },
    });
  });

  it("maps every dragged node to a persistence update", () => {
    const firstNode = toFlowNode(persistedNode);
    const secondNode = {
      ...firstNode,
      id: "node-bert",
      position: { x: 640.5, y: -12.25 },
    };

    expect(toPositionUpdates([firstNode, secondNode])).toEqual([
      { id: "node-attention", x: 120, y: 80 },
      { id: "node-bert", x: 640.5, y: -12.25 },
    ]);
  });
});
