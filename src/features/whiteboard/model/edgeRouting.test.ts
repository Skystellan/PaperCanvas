import { describe, expect, it } from "vitest";
import { routePaperEdges } from "./edgeRouting";
import { toFlowNode, type PaperFlowNode } from "./boardNode";

function node(id: string, x: number, y: number): PaperFlowNode {
  return toFlowNode({ id, boardId: "board", position: { x, y }, size: { width: 280, height: 128 },
    paper: { id, title: id, authors: null, year: null, filePath: null, domainId: null, createdAt: 1 } });
}

function samplePath(path: string) {
  const points: Array<{ x: number; y: number }> = [];
  let start = { x: 0, y: 0 };
  for (const command of path.match(/[MLQ][^MLQ]+/g)!) {
    const values = command.slice(1).trim().split(/[ ,]+/).map(Number);
    const end = { x: values[values.length - 2], y: values[values.length - 1] };
    if (command[0] !== "M") {
      for (let step = 0; step <= 50; step += 1) {
        const t = step / 50;
        points.push(command[0] === "Q" ? {
          x: (1 - t) ** 2 * start.x + 2 * (1 - t) * t * values[0] + t ** 2 * end.x,
          y: (1 - t) ** 2 * start.y + 2 * (1 - t) * t * values[1] + t ** 2 * end.y,
        } : { x: start.x + t * (end.x - start.x), y: start.y + t * (end.y - start.y) });
      }
    }
    start = end;
  }
  return points;
}

describe("paper edge routing", () => {
  it("routes around intervening cards without changing the layout or relation", () => {
    const nodes = [node("a", 0, 0), node("obstacle", 400, 0), node("b", 800, 0), node("lower", 400, 180)];
    const before = structuredClone(nodes);
    const [edge] = routePaperEdges(nodes, [{ id: "a-b", source: "a", target: "b",
      data: { relation: "challenge", explanation: "Different result", evidence: "Page 3" } }]);
    const samples = samplePath(edge.data!.path!);
    for (const { x, y } of samples) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      for (const card of nodes) {
        expect(x > card.position.x + 0.01 && x < card.position.x + 279.99 &&
          y > card.position.y + 0.01 && y < card.position.y + 127.99).toBe(false);
      }
    }
    expect(samples.some(point => point.y < 0)).toBe(true);
    expect(edge.data).toMatchObject({ relation: "challenge", evidence: "Page 3" });
    expect(nodes).toEqual(before);
  });

  it("separates connection points for collinear neighbors and remains deterministic", () => {
    const nodes = [node("a", 0, 0), node("b", 400, 0), node("c", 800, 0)];
    const edges = [{ id: "a-b", source: "a", target: "b" }, { id: "a-c", source: "a", target: "c" }];
    const routes = routePaperEdges(nodes, edges);
    expect(routes[0].data!.path!.split(" L ")[0]).not.toEqual(routes[1].data!.path!.split(" L ")[0]);
    expect(routePaperEdges(nodes, [...edges].reverse()).map(edge => edge.data?.path).reverse()).toEqual(routes.map(edge => edge.data?.path));
  });
});
