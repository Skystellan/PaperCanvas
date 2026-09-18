import { describe, expect, it } from "vitest";
import type { PaperFlowEdge } from "./boardEdge";
import type { PaperFlowNode } from "./boardNode";
import {
  createObsidianForceLayout,
  localLayoutNodeIds,
} from "./obsidianForceLayout";

function node(id: string, x: number, y = 0): PaperFlowNode {
  return {
    id,
    type: "paper",
    position: { x, y },
    data: {
      paper: {
        id,
        title: id,
        authors: null,
        year: null,
        filePath: null,
        domainId: null,
        createdAt: 1,
      },
    },
    style: { width: 280, height: 128 },
  };
}

function edge(source: string, target: string): PaperFlowEdge {
  return { id: `${source}-${target}`, source, target };
}

function segmentsCross(
  firstStart: { x: number; y: number },
  firstEnd: { x: number; y: number },
  secondStart: { x: number; y: number },
  secondEnd: { x: number; y: number },
) {
  const side = (
    start: { x: number; y: number },
    end: { x: number; y: number },
    point: { x: number; y: number },
  ) =>
    (end.x - start.x) * (point.y - start.y) -
    (end.y - start.y) * (point.x - start.x);
  return (
    side(firstStart, firstEnd, secondStart) *
      side(firstStart, firstEnd, secondEnd) <
      0 &&
    side(secondStart, secondEnd, firstStart) *
      side(secondStart, secondEnd, firstEnd) <
      0
  );
}

describe("createObsidianForceLayout", () => {
  it("limits a drag response to two graph hops", () => {
    expect(
      [...localLayoutNodeIds(["a"], [
        edge("a", "b"),
        edge("b", "c"),
        edge("c", "d"),
      ])],
    ).toEqual(["a", "b", "c"]);
  });

  it("pulls linked cards toward their natural distance while the layout cools", () => {
    const layout = createObsidianForceLayout(
      [node("a", 0), node("b", 1_000)],
      [edge("a", "b")],
    );

    layout.settle();
    const positions = layout.positions();

    expect(positions.get("b")!.x - positions.get("a")!.x).toBeLessThan(600);
    expect(layout.isSettled()).toBe(true);
  });

  it("keeps a dragged card fixed while its linked neighbor responds", () => {
    const layout = createObsidianForceLayout(
      [node("a", 0), node("b", 420)],
      [edge("a", "b")],
    );
    layout.pin("a", { x: 300, y: 40 });
    layout.reheat();

    layout.tick(30);
    const positions = layout.positions();

    expect(positions.get("a")).toEqual({ x: 300, y: 40 });
    expect(positions.get("b")!.x).toBeGreaterThan(420);
  });

  it("keeps nodes outside the local activity set fixed", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d")];
    const layout = createObsidianForceLayout(
      [node("a", 0), node("b", 420), node("c", 840), node("d", 1_260)],
      edges,
      { movableNodeIds: localLayoutNodeIds(["a"], edges) },
    );
    layout.pin("a", { x: 300, y: 40 });
    layout.reheat();

    layout.tick(30);

    expect(layout.positions().get("d")).toEqual({ x: 1_260, y: 0 });
  });

  it("untangles two independent crossing connections", () => {
    const layout = createObsidianForceLayout(
      [
        node("a", 0, 0),
        node("b", 1_000, 1_000),
        node("c", 0, 1_000),
        node("d", 1_000, 0),
      ],
      [edge("a", "b"), edge("c", "d")],
    );

    layout.settle();
    const positions = layout.positions();

    expect(
      segmentsCross(
        positions.get("a")!,
        positions.get("b")!,
        positions.get("c")!,
        positions.get("d")!,
      ),
    ).toBe(false);
  });

  it("bounds local untangling work and keeps dense graph coordinates finite", () => {
    const nodes = Array.from({ length: 12 }, (_, index) => {
      const angle = (index / 12) * Math.PI * 2;
      return node(
        `node-${index}`,
        Math.cos(angle) * 1_000,
        Math.sin(angle) * 1_000,
      );
    });
    const edges = nodes.flatMap((source, sourceIndex) =>
      nodes.slice(sourceIndex + 1).map((target) => edge(source.id, target.id)),
    );
    const stats = { crossingChecks: 0 };
    const layout = createObsidianForceLayout(nodes, edges, {
      movableNodeIds: new Set(["node-0", "node-1"]),
      stats,
    });

    layout.tick(30);

    expect(stats.crossingChecks).toBeGreaterThan(0);
    expect(stats.crossingChecks).toBeLessThanOrEqual(21 * 66 * 30);
    for (const position of layout.positions().values()) {
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
      expect(Math.abs(position.x)).toBeLessThan(10_000);
      expect(Math.abs(position.y)).toBeLessThan(10_000);
    }
  });

  it("caps crossing checks during a dense global layout tick", () => {
    const nodes = Array.from({ length: 25 }, (_, index) => {
      const angle = (index / 25) * Math.PI * 2;
      return node(
        `node-${index}`,
        Math.cos(angle) * 1_000,
        Math.sin(angle) * 1_000,
      );
    });
    const edges = nodes.flatMap((source, sourceIndex) =>
      nodes.slice(sourceIndex + 1).map((target) => edge(source.id, target.id)),
    );
    const stats = { crossingChecks: 0 };
    const layout = createObsidianForceLayout(nodes, edges, { stats });

    layout.tick();

    expect(stats.crossingChecks).toBeGreaterThan(0);
    expect(stats.crossingChecks).toBeLessThanOrEqual(4_000);
  });

  it("releases a dragged card back into the cooling simulation", () => {
    const layout = createObsidianForceLayout(
      [node("a", 0), node("b", 420)],
      [edge("a", "b")],
    );
    layout.pin("a", { x: 300, y: 40 });
    layout.reheat();
    layout.tick(10);

    layout.release("a");
    layout.cool();
    layout.settle();

    expect(layout.positions().get("a")).not.toEqual({ x: 300, y: 40 });
    expect(layout.isSettled()).toBe(true);
  });

  it("accepts collision-corrected positions for the next simulation tick", () => {
    const first = node("a", 0);
    const second = node("b", 420);
    const layout = createObsidianForceLayout([first, second], [edge("a", "b")]);

    layout.sync([{ ...first, position: { x: -100, y: 30 } }, second]);

    expect(layout.positions().get("a")).toEqual({ x: -100, y: 30 });
  });
});
