import { describe, expect, it } from "vitest";
import { connectionKey, countEdgeCrossings, toFlowEdge } from "./boardEdge";

describe("connectionKey", () => {
  it("uses the same key for an edge in either direction", () => {
    expect(connectionKey("node-a", "node-b")).toBe(
      connectionKey("node-b", "node-a"),
    );
  });
});

describe("toFlowEdge", () => {
  it("keeps the persisted edge identifier, endpoints, and support styling", () => {
    expect(
      toFlowEdge({
        id: "edge-1",
        boardId: "board-default",
        sourceNodeId: "node-a",
        targetNodeId: "node-b",
        relation: "support",
      } as Parameters<typeof toFlowEdge>[0] & { relation: "support" }),
    ).toEqual({
      ariaLabel: "Support connection",
      className: "whiteboard__edge--support",
      data: { relation: "support" },
      id: "edge-1",
      source: "node-a",
      target: "node-b",
      type: "straight",
    });
  });
});

describe("countEdgeCrossings", () => {
  it("counts only proper intersections between independent edges", () => {
    const positions = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 10, y: 10 }],
      ["c", { x: 0, y: 10 }],
      ["d", { x: 10, y: 0 }],
    ]);

    expect(
      countEdgeCrossings(positions, [
        { id: "a-b", source: "a", target: "b" },
        { id: "c-d", source: "c", target: "d" },
        { id: "a-c", source: "a", target: "c" },
      ]),
    ).toBe(1);
  });

  it("counts only crossings involving a relevant node", () => {
    const positions = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 10, y: 10 }],
      ["c", { x: 0, y: 10 }],
      ["d", { x: 10, y: 0 }],
      ["e", { x: 20, y: 0 }],
      ["f", { x: 30, y: 10 }],
      ["g", { x: 20, y: 10 }],
      ["h", { x: 30, y: 0 }],
    ]);
    const edges = [
      { id: "a-b", source: "a", target: "b" },
      { id: "c-d", source: "c", target: "d" },
      { id: "e-f", source: "e", target: "f" },
      { id: "g-h", source: "g", target: "h" },
    ];

    expect(countEdgeCrossings(positions, edges)).toBe(2);
    expect(countEdgeCrossings(positions, edges, new Set(["a"]))).toBe(1);
  });
});
