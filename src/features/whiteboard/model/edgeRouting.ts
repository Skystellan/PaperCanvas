import type { PaperFlowEdge } from "./boardEdge";
import type { PaperFlowNode } from "./boardNode";
import { toNodeRectangle } from "./nodeCollision";

interface Point { x: number; y: number }
interface Box { left: number; top: number; right: number; bottom: number }
interface Port { point: Point; outside: Point }
const PADDING = 14;

function crossesBox(a: Point, b: Point, box: Box) {
  let enter = 0;
  let leave = 1;
  for (const [start, delta, min, max] of [
    [a.x, b.x - a.x, box.left + 0.001, box.right - 0.001],
    [a.y, b.y - a.y, box.top + 0.001, box.bottom - 0.001],
  ]) {
    if (delta === 0) {
      if (start <= min || start >= max) return false;
    } else {
      const first = (min - start) / delta;
      const second = (max - start) / delta;
      enter = Math.max(enter, Math.min(first, second));
      leave = Math.min(leave, Math.max(first, second));
    }
  }
  return enter < leave;
}

function pathString(points: Point[]) {
  let path = `M ${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const before = points[i - 1];
    const corner = points[i];
    const after = points[i + 1];
    const incoming = Math.hypot(corner.x - before.x, corner.y - before.y);
    const outgoing = Math.hypot(after.x - corner.x, after.y - corner.y);
    if (incoming === 0 || outgoing === 0) continue;
    const radius = Math.min(8, incoming / 2, outgoing / 2);
    const x1 = corner.x + (before.x - corner.x) * radius / incoming;
    const y1 = corner.y + (before.y - corner.y) * radius / incoming;
    const x2 = corner.x + (after.x - corner.x) * radius / outgoing;
    const y2 = corner.y + (after.y - corner.y) * radius / outgoing;
    path += ` L ${x1},${y1} Q ${corner.x},${corner.y} ${x2},${y2}`;
  }
  const last = points[points.length - 1];
  return `${path} L ${last.x},${last.y}`;
}

export function routePaperEdges(nodes: readonly PaperFlowNode[], edges: readonly PaperFlowEdge[]) {
  const boxes = new Map(nodes.map(node => {
    const { position, size } = toNodeRectangle(node);
    return [node.id, { left: position.x, top: position.y,
      right: position.x + size.width, bottom: position.y + size.height }] as const;
  }));
  const obstacles = [...boxes.values()].map(box => ({
    left: box.left - PADDING, top: box.top - PADDING,
    right: box.right + PADDING, bottom: box.bottom + PADDING,
  }));
  const clear = (a: Point, b: Point) => !obstacles.some(box => crossesBox(a, b, box));
  const center = (box: Box) => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
  const ports = new Map<string, Port>();
  for (const [id, box] of boxes) {
    const origin = center(box);
    const sides = new Map<string, Array<{ edgeId: string; order: number }>>();
    for (const edge of edges) {
      const other = boxes.get(edge.source === id ? edge.target : edge.target === id ? edge.source : "");
      if (!other) continue;
      const target = center(other);
      const dx = target.x - origin.x;
      const dy = target.y - origin.y;
      const horizontal = Math.abs(dx) / (box.right - box.left) > Math.abs(dy) / (box.bottom - box.top);
      const side = horizontal ? dx > 0 ? "right" : "left" : dy > 0 ? "bottom" : "top";
      const group = sides.get(side) ?? [];
      group.push({ edgeId: edge.id, order: horizontal ? target.y : target.x });
      sides.set(side, group);
    }
    for (const [side, group] of sides) {
      group.sort((a, b) => a.order - b.order || a.edgeId.localeCompare(b.edgeId));
      group.forEach(({ edgeId }, index) => {
        const fraction = (index + 1) / (group.length + 1);
        const verticalSide = side === "left" || side === "right";
        const point = {
          x: verticalSide ? side === "left" ? box.left : box.right : box.left + 24 + (box.right - box.left - 48) * fraction,
          y: verticalSide ? box.top + 24 + (box.bottom - box.top - 48) * fraction : side === "top" ? box.top : box.bottom,
        };
        ports.set(`${id}\0${edgeId}`, { point, outside: {
          x: point.x + (side === "left" ? -PADDING : side === "right" ? PADDING : 0),
          y: point.y + (side === "top" ? -PADDING : side === "bottom" ? PADDING : 0),
        } });
      });
    }
  }

  // ponytail: a shared corner visibility graph fits paper boards; use a spatial
  // index if boards with hundreds of cards make routing a measured bottleneck.
  const corners = obstacles.flatMap(box => [
    { x: box.left, y: box.top }, { x: box.right, y: box.top },
    { x: box.right, y: box.bottom }, { x: box.left, y: box.bottom },
  ]);
  let cornerLinks: Array<Array<{ to: number; distance: number }>> | undefined;
  const route = (start: Point, end: Point): Point[] => {
    if (clear(start, end)) return [start, end];
    cornerLinks ??= corners.map((a, i) => corners.flatMap((b, j) =>
      i !== j && clear(a, b) ? [{ to: j, distance: Math.hypot(a.x - b.x, a.y - b.y) }] : []));
    const points = [...corners, start, end];
    const startIndex = corners.length;
    const endIndex = startIndex + 1;
    const links = cornerLinks.map(neighbors => [...neighbors]);
    links.push([], []);
    for (const endpoint of [startIndex, endIndex]) {
      corners.forEach((point, i) => {
        if (!clear(point, points[endpoint])) return;
        const distance = Math.hypot(point.x - points[endpoint].x, point.y - points[endpoint].y);
        links[i].push({ to: endpoint, distance });
        links[endpoint].push({ to: i, distance });
      });
    }
    const distances = points.map(() => Infinity);
    const previous = points.map(() => -1);
    const visited = new Set<number>();
    distances[startIndex] = 0;
    for (;;) {
      let current = -1;
      for (let i = 0; i < points.length; i += 1) {
        if (!visited.has(i) && Number.isFinite(distances[i]) && (current < 0 || distances[i] < distances[current])) current = i;
      }
      if (current < 0) return [start, end]; // Cards can temporarily overlap while being dragged.
      if (current === endIndex) break;
      visited.add(current);
      for (const { to, distance } of links[current]) {
        const candidate = distances[current] + distance;
        if (candidate >= distances[to]) continue;
        distances[to] = candidate;
        previous[to] = current;
      }
    }
    const result: Point[] = [];
    for (let i = endIndex; i >= 0; i = previous[i]) result.push(points[i]);
    return result.reverse();
  };
  return edges.map(edge => {
    const source = ports.get(`${edge.source}\0${edge.id}`);
    const target = ports.get(`${edge.target}\0${edge.id}`);
    if (!source || !target) return edge;
    return { ...edge, data: {
      relation: null, explanation: "", evidence: "", ...edge.data,
      path: pathString([source.point, ...route(source.outside, target.outside), target.point]),
    } };
  });
}
