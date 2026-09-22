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
  it("does not attract distant domains through cross-domain links", () => {
    const a = node("a", 0);
    const b = node("b", 1_000);
    a.data.paper.domainId = "domain-a";
    b.data.paper.domainId = "domain-b";
    const layout = createObsidianForceLayout([a, b], [edge("a", "b")]);
    layout.pin("a", { x: 300, y: 40 });
    layout.reheat();
    layout.tick(60);
    expect(layout.positions().get("b")).toEqual(b.position);
    layout.release("a");
    layout.settle();
    expect(layout.positions().get("b")).toEqual(b.position);
  });

  it("lets a node expand its region while its neighboring region smoothly moves as a group", () => {
    const a = node("a", 0);
    const b = node("b", 420);
    const c = node("c", 1_000);
    const d = node("d", 1_420);
    a.data.paper.domainId = b.data.paper.domainId = "domain-a";
    c.data.paper.domainId = d.data.paper.domainId = "domain-b";
    const layout = createObsidianForceLayout([a, b, c, d], [edge("a", "b"), edge("b", "c")], {
      activeDomainIds: new Set(["domain-a"]),
    });
    layout.pin("b", { x: 1_000, y: 0 });
    layout.reheat();
    let previous = layout.positions().get("c")!;
    for (let frame = 0; frame < 90; frame += 1) {
      layout.tick();
      const positions = layout.positions();
      expect(positions.get("b")).toEqual({ x: 1_000, y: 0 });
      expect(positions.get("d")!.x - positions.get("c")!.x).toBeCloseTo(420);
      expect(positions.get("d")!.y - positions.get("c")!.y).toBeCloseTo(0);
      const current = positions.get("c")!;
      expect(Math.hypot(current.x - previous.x, current.y - previous.y)).toBeLessThanOrEqual(24.00001);
      previous = current;
    }
    expect(layout.positions().get("c")).not.toEqual(c.position);
    layout.release("b");
    layout.cool();
    layout.settle();
    expect(layout.isSettled()).toBe(true);
    expect(layout.positions().get("d")!.x - layout.positions().get("c")!.x).toBeCloseTo(420);
  });

  it("limits connection edits to two graph hops", () => {
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

  it("allows symmetric crossing connections to settle without twisting their endpoints", () => {
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
    ).toBe(true);
  });

  it("keeps a dense local graph finite while it cools", () => {
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
    const layout = createObsidianForceLayout(nodes, edges, {
      movableNodeIds: new Set(["node-0", "node-1"]),
    });

    layout.tick(30);

    for (const position of layout.positions().values()) {
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
      expect(Math.abs(position.x)).toBeLessThan(10_000);
      expect(Math.abs(position.y)).toBeLessThan(10_000);
    }
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

  it("accepts the latest pointer position without moving another card before a tick", () => {
    const layout = createObsidianForceLayout(
      [node("a", 0), node("b", 420)],
      [edge("a", "b")],
    );
    layout.pin("a", { x: 300, y: 40 });
    layout.pin("a", { x: 310, y: 50 });

    expect(layout.positions().get("a")).toEqual({ x: 310, y: 50 });
    expect(layout.positions().get("b")).toEqual({ x: 420, y: 0 });
    layout.reheat();
    for (let frame = 0; frame < 30; frame += 1) {
      layout.tick();
      expect(layout.positions().get("a")).toEqual({ x: 310, y: 50 });
    }
  });
});
