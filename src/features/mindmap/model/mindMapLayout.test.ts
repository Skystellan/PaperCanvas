import { describe, expect, it } from "vitest";
import {
  MIND_MAP_NODE_HEIGHT,
  MIND_MAP_NODE_WIDTH,
  findNonOverlappingMindMapPosition,
  layoutMindMapTree,
} from "./mindMapLayout";
import type { MindMapTree } from "./mindMap";

function unorderedTree(): MindMapTree {
  return {
    schemaVersion: 1,
    revision: 1,
    sourcePrompt: "Analyze",
    updatedAt: 10,
    nodes: [
      { id: "b", title: "B", details: "", parentId: "root", x: 9, y: 9 },
      { id: "root", title: "Root", details: "", parentId: null, x: 8, y: 8 },
      { id: "a2", title: "A2", details: "", parentId: "a", x: 7, y: 7 },
      { id: "a", title: "A", details: "", parentId: "root", x: 6, y: 6 },
      { id: "a1", title: "A1", details: "", parentId: "a", x: 5, y: 5 },
    ],
  };
}

describe("layoutMindMapTree", () => {
  it("produces the same stable left-to-right layout for equivalent input orderings", () => {
    const first = unorderedTree();
    const second = { ...first, nodes: [...first.nodes].reverse() };

    const firstPositions = new Map(
      layoutMindMapTree(first).nodes.map(({ id, x, y }) => [id, { x, y }]),
    );
    const secondPositions = new Map(
      layoutMindMapTree(second).nodes.map(({ id, x, y }) => [id, { x, y }]),
    );

    expect(secondPositions).toEqual(firstPositions);
    expect(firstPositions.get("root")?.x).toBe(0);
    expect(firstPositions.get("a")!.x).toBeGreaterThan(0);
    expect(firstPositions.get("a1")!.x).toBeGreaterThan(
      firstPositions.get("a")!.x,
    );
  });

  it("keeps every laid-out node rectangle mutually exclusive", () => {
    const nodes = layoutMindMapTree(unorderedTree()).nodes;

    for (const [index, node] of nodes.entries()) {
      for (const other of nodes.slice(index + 1)) {
        const separated =
          node.x + MIND_MAP_NODE_WIDTH <= other.x ||
          other.x + MIND_MAP_NODE_WIDTH <= node.x ||
          node.y + MIND_MAP_NODE_HEIGHT <= other.y ||
          other.y + MIND_MAP_NODE_HEIGHT <= node.y;
        expect(separated, `${node.id} overlaps ${other.id}`).toBe(true);
      }
    }
  });
});

describe("findNonOverlappingMindMapPosition", () => {
  it("keeps a free manual position and snaps an overlap to the nearest stable slot", () => {
    const nodes = [
      { id: "root", x: 0, y: 0 },
      { id: "method", x: 300, y: 0 },
    ];

    expect(
      findNonOverlappingMindMapPosition("method", { x: 600, y: 10 }, nodes),
    ).toEqual({ x: 600, y: 10 });

    const snapped = findNonOverlappingMindMapPosition(
      "method",
      { x: 0, y: 0 },
      nodes,
    );
    expect(snapped).not.toEqual({ x: 0, y: 0 });
    expect(
      snapped.x + MIND_MAP_NODE_WIDTH <= 0 ||
        snapped.x >= MIND_MAP_NODE_WIDTH ||
        snapped.y + MIND_MAP_NODE_HEIGHT <= 0 ||
        snapped.y >= MIND_MAP_NODE_HEIGHT,
    ).toBe(true);
  });

  it("normalizes non-finite drag coordinates before collision checks", () => {
    const position = findNonOverlappingMindMapPosition(
      "active",
      { x: Number.POSITIVE_INFINITY, y: 0 },
      [{ id: "root", x: 0, y: 0 }],
    );

    expect(position).not.toEqual({ x: 0, y: 0 });
    expect(Number.isFinite(position.x)).toBe(true);
    expect(Number.isFinite(position.y)).toBe(true);
  });
});
