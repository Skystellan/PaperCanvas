import { describe, expect, it } from "vitest";
import { countEdgeCrossings, type PaperFlowEdge } from "./boardEdge";
import type { PaperFlowNode } from "./boardNode";
import { computeDomainFrames, separateDomainGroups } from "./domainFrames";

function node(
  id: string,
  domainId: string | null,
  x: number,
  y: number,
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
        createdAt: 1,
        domainId,
      },
    },
    style: { width: 280, height: 128 },
  };
}

describe("computeDomainFrames", () => {
  it("encloses each named domain without turning it into a parent node", () => {
    const frames = computeDomainFrames(
      [
        node("a", "domain-a", 100, 80),
        node("b", "domain-a", 500, 240),
        node("c", "domain-b", -100, 20),
        node("loose", null, 900, 900),
      ],
      [
        { id: "domain-a", name: "领域 A" },
        { id: "domain-b", name: "领域 B" },
      ],
      40,
    );

    expect(frames).toEqual([
      {
        domainId: "domain-a",
        name: "领域 A",
        x: 60,
        y: 40,
        width: 760,
        height: 368,
      },
      {
        domainId: "domain-b",
        name: "领域 B",
        x: -140,
        y: -20,
        width: 360,
        height: 208,
      },
    ]);
  });

  it("omits empty and unclassified groups", () => {
    expect(
      computeDomainFrames(
        [node("loose", null, 0, 0)],
        [{ id: "empty", name: "Empty" }],
      ),
    ).toEqual([]);
  });

  it("separates overlapping domain frames without deforming either group", () => {
    const separated = separateDomainGroups([
      node("a-1", "domain-a", 0, 0),
      node("a-2", "domain-a", 320, 160),
      node("b-1", "domain-b", 40, 20),
      node("b-2", "domain-b", 360, 180),
    ]);
    const frames = computeDomainFrames(separated, [
      { id: "domain-a", name: "领域 A" },
      { id: "domain-b", name: "领域 B" },
    ]);
    const [first, second] = frames;

    expect(
      first.x + first.width <= second.x ||
        second.x + second.width <= first.x ||
        first.y + first.height <= second.y ||
        second.y + second.height <= first.y,
    ).toBe(true);
    const firstDomainNodes = separated.filter(
      (candidate) => candidate.data.paper.domainId === "domain-a",
    );
    expect(firstDomainNodes[1].position.x - firstDomainNodes[0].position.x).toBe(
      320,
    );
    expect(firstDomainNodes[1].position.y - firstDomainNodes[0].position.y).toBe(
      160,
    );
  });

  it("moves a domain group away from an unclassified card", () => {
    const separated = separateDomainGroups([
      node("domain", "domain-a", 0, 0),
      node("loose", null, 0, 0),
    ]);
    const domain = separated[0].position;
    const loose = separated[1].position;

    expect(
      domain.x + 280 + 24 <= loose.x ||
        loose.x + 280 + 24 <= domain.x ||
        domain.y + 128 + 24 <= loose.y ||
        loose.y + 128 + 24 <= domain.y,
    ).toBe(true);
  });

  it("moves only the affected domain during local separation", () => {
    const separated = separateDomainGroups(
      [
        node("affected", "domain-a", 0, 0),
        node("fixed", "domain-b", 0, 0),
      ],
      48,
      64,
      new Set(["domain-a"]),
    );

    expect(separated[0].position).not.toEqual({ x: 0, y: 0 });
    expect(separated[1].position).toEqual({ x: 0, y: 0 });
  });

  it("chooses a domain placement that does not recreate an edge crossing", () => {
    const edges: PaperFlowEdge[] = [
      { id: "moving-anchor", source: "moving", target: "anchor" },
      { id: "vertical", source: "top", target: "bottom" },
    ];
    const separated = separateDomainGroups(
      [
        node("obstacle", "domain-fixed", 0, 0),
        node("moving", "domain-moving", 0, 0),
        node("anchor", null, 1_000, 288),
        node("top", null, 500, -200),
        node("bottom", null, 500, 200),
      ],
      48,
      64,
      undefined,
      edges,
    );
    const positions = new Map(
      separated.map((candidate) => [candidate.id, candidate.position]),
    );

    expect(countEdgeCrossings(positions, edges)).toBe(0);
  });
});
