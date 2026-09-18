import { describe, expect, it } from "vitest";
import type { MindMapTree } from "./mindMap";
import { toMindMapFlowEdges } from "./mindMapFlow";

describe("toMindMapFlowEdges", () => {
  it("uses an unambiguous edge ID even when node IDs contain separators", () => {
    const tree: MindMapTree = {
      schemaVersion: 1,
      revision: 1,
      sourcePrompt: "",
      updatedAt: 1,
      nodes: [
        { id: "a", title: "Root", details: "", parentId: null, x: 0, y: 0 },
        { id: "b:c", title: "First", details: "", parentId: "a", x: 1, y: 1 },
        { id: "a:b", title: "Second", details: "", parentId: "a", x: 1, y: 2 },
        { id: "c", title: "Third", details: "", parentId: "a:b", x: 2, y: 2 },
      ],
    };

    const edges = toMindMapFlowEdges(tree);
    expect(new Set(edges.map(({ id }) => id)).size).toBe(edges.length);
    expect(edges).toContainEqual(
      expect.objectContaining({ id: "mind-map-edge:c", source: "a:b", target: "c" }),
    );
  });
});
