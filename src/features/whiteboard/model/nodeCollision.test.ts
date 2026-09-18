import { describe, expect, it } from "vitest";
import type { PaperFlowNode } from "./boardNode";
import {
  findCollisionFreePosition,
  pushNodeGroupDuringDrag,
  pushNodesDuringDrag,
  resolveNodeOverlaps,
  type NodeRectangle,
} from "./nodeCollision";

function rectangle(
  id: string,
  x: number,
  y: number,
  width = 280,
  height = 128,
): NodeRectangle {
  return { id, position: { x, y }, size: { height, width } };
}

function flowNode(
  id: string,
  x: number,
  y: number,
  width = 100,
  height = 100,
): PaperFlowNode {
  return {
    id,
    type: "paper",
    position: { x, y },
    data: {
      paper: {
        id: `paper-${id}`,
        title: id,
        authors: null,
        year: null,
        filePath: null,
        domainId: null,
        createdAt: 1,
      },
    },
    style: { width, height },
  };
}

describe("findCollisionFreePosition", () => {
  it("keeps a non-overlapping card exactly where the user placed it", () => {
    const active = rectangle("active", 0, 0);
    const obstacle = rectangle("obstacle", 400, 0);

    expect(findCollisionFreePosition(active, [active, obstacle])).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("moves an overlapping card to the nearest free side with a stable gap", () => {
    const active = rectangle("active", 520, 245);
    const obstacle = rectangle("obstacle", 520, 245);

    expect(findCollisionFreePosition(active, [active, obstacle])).toEqual({
      x: 520,
      y: 93,
    });
  });

  it("chooses a free candidate when several neighboring cards block a side", () => {
    const active = rectangle("active", 300, 200, 100, 100);
    const center = rectangle("center", 300, 200, 100, 100);
    const top = rectangle("top", 300, 76, 100, 100);

    expect(findCollisionFreePosition(active, [active, center, top])).toEqual({
      x: 176,
      y: 200,
    });
  });

  it("prefers a lower-scored free side before distance", () => {
    const active = rectangle("active", 520, 245);
    const obstacle = rectangle("obstacle", 520, 245);

    expect(
      findCollisionFreePosition(active, [active, obstacle], 24, (position) =>
        position.y < 245 ? 1 : 0,
      ),
    ).toEqual({ x: 520, y: 397 });
  });

  it("evaluates each free candidate score once", () => {
    const active = rectangle("active", 520, 245);
    const obstacle = rectangle("obstacle", 520, 245);
    let scoreCalls = 0;

    findCollisionFreePosition(active, [active, obstacle], 24, () => {
      scoreCalls += 1;
      return 0;
    });

    expect(scoreCalls).toBe(4);
  });
});

describe("resolveNodeOverlaps", () => {
  it("separates a dense 100-card layout", () => {
    const result = resolveNodeOverlaps(
      Array.from({ length: 100 }, (_, index) =>
        flowNode(`node-${index}`, 0, 0),
      ),
    );

    for (let firstIndex = 0; firstIndex < result.length; firstIndex += 1) {
      const first = result[firstIndex].position;
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < result.length;
        secondIndex += 1
      ) {
        const second = result[secondIndex].position;
        expect(
          first.x + 124 <= second.x ||
            second.x + 124 <= first.x ||
            first.y + 124 <= second.y ||
            second.y + 124 <= first.y,
        ).toBe(true);
      }
    }
  });

  it("keeps dense 250-card fallback checks quadratic", () => {
    const stats = { fallbackChecks: 0 };

    resolveNodeOverlaps(
      Array.from({ length: 250 }, (_, index) =>
        flowNode(`node-${index}`, 0, 0),
      ),
      { stats },
    );

    expect(stats.fallbackChecks).toBeGreaterThan(0);
    expect(stats.fallbackChecks).toBeLessThanOrEqual((250 * 249) / 2);
  });
});

describe("pushNodesDuringDrag", () => {
  it("keeps the dragged card under the pointer and pushes a horizontal chain", () => {
    const active = flowNode("active", 80, 0);
    const firstNeighbor = flowNode("first-neighbor", 140, 0);
    const secondNeighbor = flowNode("second-neighbor", 264, 0);

    const result = pushNodesDuringDrag(
      active,
      { x: 0, y: 0 },
      [active, firstNeighbor, secondNeighbor],
      24,
    );

    expect(
      result.map(({ id, position }) => ({ id, position })),
    ).toEqual([
      { id: "active", position: { x: 80, y: 0 } },
      { id: "first-neighbor", position: { x: 204, y: 0 } },
      { id: "second-neighbor", position: { x: 328, y: 0 } },
    ]);
  });

  it("leaves cards outside the dragged card's path unchanged", () => {
    const active = flowNode("active", 80, 0);
    const neighbor = flowNode("neighbor", 140, 140);

    const result = pushNodesDuringDrag(
      active,
      { x: 0, y: 0 },
      [active, neighbor],
      24,
    );

    expect(result.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "active", position: { x: 80, y: 0 } },
      { id: "neighbor", position: { x: 140, y: 140 } },
    ]);
  });

  it("pushes through a neighbor even when a fast drag crosses its center", () => {
    const active = flowNode("active", 200, 0);
    const crossedNeighbor = flowNode("crossed-neighbor", 140, 0);

    const result = pushNodesDuringDrag(
      active,
      { x: 0, y: 0 },
      [active, crossedNeighbor],
      24,
    );

    expect(result.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "active", position: { x: 200, y: 0 } },
      { id: "crossed-neighbor", position: { x: 324, y: 0 } },
    ]);
  });

  it("pushes a neighbor crossed completely between two drag events", () => {
    const active = flowNode("active", 300, 0);
    const crossedNeighbor = flowNode("crossed-neighbor", 140, 0);

    const result = pushNodesDuringDrag(
      active,
      { x: 0, y: 0 },
      [active, crossedNeighbor],
      24,
    );

    expect(result.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "active", position: { x: 300, y: 0 } },
      { id: "crossed-neighbor", position: { x: 424, y: 0 } },
    ]);
  });

  it("propagates a swept collision through the nodes ahead", () => {
    const active = flowNode("active", 300, 0);
    const firstNeighbor = flowNode("first-neighbor", 140, 0);
    const secondNeighbor = flowNode("second-neighbor", 264, 0);

    const result = pushNodesDuringDrag(
      active,
      { x: 0, y: 0 },
      [active, firstNeighbor, secondNeighbor],
      24,
    );

    expect(result.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "active", position: { x: 300, y: 0 } },
      { id: "first-neighbor", position: { x: 424, y: 0 } },
      { id: "second-neighbor", position: { x: 548, y: 0 } },
    ]);
  });

  it("sweeps each displaced node so a diagonal jump cannot leave a chain overlapped", () => {
    const active = flowNode("active", 443, 301);
    const nearNeighbor = flowNode("near-neighbor", 248, 124);
    const farNeighbor = flowNode("far-neighbor", 496, 124);

    const result = pushNodesDuringDrag(
      active,
      { x: 0, y: 0 },
      [active, nearNeighbor, farNeighbor],
      24,
    );

    expect(result.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "active", position: { x: 443, y: 301 } },
      { id: "near-neighbor", position: { x: 567, y: 124 } },
      { id: "far-neighbor", position: { x: 691, y: 124 } },
    ]);
  });

  it("does not pull a neighbor from behind when the active card reverses away", () => {
    const active = flowNode("active", 80, 0);
    const neighborBehind = flowNode("neighbor-behind", 140, 0);

    const result = pushNodesDuringDrag(
      active,
      { x: 90, y: 0 },
      [active, neighborBehind],
      24,
    );

    expect(result.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "active", position: { x: 80, y: 0 } },
      { id: "neighbor-behind", position: { x: 140, y: 0 } },
    ]);
  });

  it("pushes a chain to the left when the pointer moves left", () => {
    const active = flowNode("active", -80, 0);
    const firstNeighbor = flowNode("first-neighbor", -140, 0);
    const secondNeighbor = flowNode("second-neighbor", -264, 0);

    const result = pushNodesDuringDrag(
      active,
      { x: 0, y: 0 },
      [active, firstNeighbor, secondNeighbor],
      24,
    );

    expect(result.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "active", position: { x: -80, y: 0 } },
      { id: "first-neighbor", position: { x: -204, y: 0 } },
      { id: "second-neighbor", position: { x: -328, y: 0 } },
    ]);
  });

  it("uses the dominant vertical drag direction for a vertical chain", () => {
    const active = flowNode("active", 10, 80);
    const firstNeighbor = flowNode("first-neighbor", 0, 140);
    const secondNeighbor = flowNode("second-neighbor", 0, 264);

    const result = pushNodesDuringDrag(
      active,
      { x: 0, y: 0 },
      [active, firstNeighbor, secondNeighbor],
      24,
    );

    expect(result.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "active", position: { x: 10, y: 80 } },
      { id: "first-neighbor", position: { x: 0, y: 204 } },
      { id: "second-neighbor", position: { x: 0, y: 328 } },
    ]);
  });

  it("uses the dominant axis of a diagonal drag", () => {
    const active = flowNode("active", 80, 40);
    const neighbor = flowNode("neighbor", 140, 40);

    const result = pushNodesDuringDrag(
      active,
      { x: 0, y: 0 },
      [active, neighbor],
      24,
    );

    expect(result.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "active", position: { x: 80, y: 40 } },
      { id: "neighbor", position: { x: 204, y: 40 } },
    ]);
  });

  it("detects a diagonal collision approached along the secondary axis", () => {
    const active = flowNode("active", 60, 40);
    const neighbor = flowNode("neighbor", -50, 124);

    const result = pushNodesDuringDrag(
      active,
      { x: 0, y: 0 },
      [active, neighbor],
      24,
    );

    expect(result.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "active", position: { x: 60, y: 40 } },
      { id: "neighbor", position: { x: 184, y: 124 } },
    ]);
  });

  it("pushes a start-free corner graze even when the neighbor center projects behind", () => {
    const active = flowNode("active", 10, 100);
    const grazedNeighbor = flowNode("grazed-neighbor", 130, -20);

    const result = pushNodesDuringDrag(
      active,
      { x: 0, y: 0 },
      [active, grazedNeighbor],
      24,
    );

    expect(result.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "active", position: { x: 10, y: 100 } },
      { id: "grazed-neighbor", position: { x: 130, y: 224 } },
    ]);
  });

  it("does not treat the bounding box of a diagonal path as a collision", () => {
    const active = flowNode("active", 300, 300);
    const missedNeighbor = flowNode("missed-neighbor", 140, 400);

    const result = pushNodesDuringDrag(
      active,
      { x: 0, y: 0 },
      [active, missedNeighbor],
      24,
    );

    expect(result.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "active", position: { x: 300, y: 300 } },
      { id: "missed-neighbor", position: { x: 140, y: 400 } },
    ]);
  });

  it("packs a large swept chain with a bounded number of candidate checks", () => {
    const nodeCount = 512;
    const active = flowNode("active", nodeCount * 124, 0);
    const nodes = [
      active,
      ...Array.from({ length: nodeCount - 1 }, (_, index) =>
        flowNode(`node-${index}`, (index + 1) * 124, 0),
      ),
    ];
    const stats = { candidateChecks: 0, pushedNodes: 0 };

    const result = pushNodesDuringDrag(
      active,
      { x: 0, y: 0 },
      nodes,
      24,
      stats,
    );

    expect(stats).toEqual({
      candidateChecks: (nodeCount * (nodeCount - 1)) / 2,
      pushedNodes: nodeCount - 1,
    });
    for (let index = 1; index < result.length; index += 1) {
      const previous = index === 1 ? result[0] : result[index - 1];
      expect(result[index].position).toEqual({
        x: previous.position.x + 124,
        y: 0,
      });
    }
  });
});

describe("pushNodeGroupDuringDrag", () => {
  it("propagates through every stationary card crossed by the dragged group", () => {
    const selectedA = flowNode("selected-a", 1_000, 0);
    const selectedB = flowNode("selected-b", 1_000, 1_000);
    const firstStatic = flowNode("first-static", 150, 100);
    const crossedStatic = flowNode("crossed-static", 500, 200);

    const result = pushNodeGroupDuringDrag(
      [selectedA, selectedB],
      new Map([
        [selectedA.id, { x: 0, y: 0 }],
        [selectedB.id, { x: 0, y: 1_000 }],
      ]),
      [selectedA, selectedB, firstStatic, crossedStatic],
      24,
    );

    expect(result.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "selected-a", position: { x: 1_000, y: 0 } },
      { id: "selected-b", position: { x: 1_000, y: 1_000 } },
      { id: "first-static", position: { x: 1_124, y: 100 } },
      { id: "crossed-static", position: { x: 1_248, y: 200 } },
    ]);
  });

  it("keeps every card separated when a diagonal group push reorders neighbors", () => {
    const selectedA = flowNode("selected-a", -310, 155, 280, 128);
    const selectedB = flowNode("selected-b", -6, 307, 280, 128);
    const staticC = flowNode("static-c", 0, 304, 280, 128);
    const staticD = flowNode("static-d", 304, 304, 280, 128);

    const result = pushNodeGroupDuringDrag(
      [selectedA, selectedB],
      new Map([
        [selectedA.id, { x: 0, y: 0 }],
        [selectedB.id, { x: 304, y: 152 }],
      ]),
      [selectedA, selectedB, staticC, staticD],
      24,
    );

    expect(result.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "selected-a", position: { x: -310, y: 155 } },
      { id: "selected-b", position: { x: -6, y: 307 } },
      { id: "static-c", position: { x: -918, y: 304 } },
      { id: "static-d", position: { x: -614, y: 304 } },
    ]);
  });

  it("packs a pushed chain past every fixed card in a diagonal multi-selection", () => {
    const upper = flowNode("upper", 208, 252);
    const lower = flowNode("lower", 208, 500);
    const leftTop = flowNode("left-top", 124, 124);
    const leftMiddle = flowNode("left-middle", 124, 248);
    const leftBottom = flowNode("left-bottom", 124, 372);
    const previousPositions = new Map([
      [upper.id, { x: 248, y: 124 }],
      [lower.id, { x: 248, y: 372 }],
    ]);

    const result = pushNodeGroupDuringDrag(
      [lower, upper],
      previousPositions,
      [upper, lower, leftTop, leftMiddle, leftBottom],
      24,
    );

    expect(result.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "upper", position: { x: 208, y: 252 } },
      { id: "lower", position: { x: 208, y: 500 } },
      { id: "left-top", position: { x: 124, y: 624 } },
      { id: "left-middle", position: { x: 124, y: 748 } },
      { id: "left-bottom", position: { x: 124, y: 872 } },
    ]);
  });
});
