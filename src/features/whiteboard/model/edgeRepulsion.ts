import type { SimulationNodeDatum } from "d3-force";

interface Node extends SimulationNodeDatum {
  id: string;
  width: number;
  height: number;
}
interface Link { source: Node; target: Node }
interface Axis { x: number; y: number }

const dot = (node: Node, axis: Axis) => node.x! * axis.x + node.y! * axis.y;
const movable = (node: Node) => node.fx == null && node.fy == null;
function push(node: Node, axis: Axis, amount: number) {
  if (!movable(node)) return;
  node.vx = (node.vx ?? 0) + axis.x * amount;
  node.vy = (node.vy ?? 0) + axis.y * amount;
}

function axes(link: Link) {
  const dx = link.target.x! - link.source.x!;
  const dy = link.target.y! - link.source.y!;
  const length = Math.hypot(dx, dy) || 1;
  return [{ x: -dy / length, y: dx / length }, { x: dx / length, y: dy / length }];
}

function separation(a: Link, b: Link, axis: Axis) {
  const aValues = [dot(a.source, axis), dot(a.target, axis)];
  const bValues = [dot(b.source, axis), dot(b.target, axis)];
  return {
    negative: Math.max(...aValues) - Math.min(...bValues) + 48,
    positive: Math.max(...bValues) - Math.min(...aValues) + 48,
  };
}

export function createEdgeRepulsion(nodes: Node[], links: Link[]) {
  // Only disconnected networks can slide apart without their other links pulling back.
  const parents = new Map(nodes.map(node => [node, node]));
  const component = (node: Node): Node => {
    const parent = parents.get(node)!;
    if (parent === node) return node;
    const root = component(parent);
    parents.set(node, root);
    return root;
  };
  for (const { source, target } of links) parents.set(component(source), component(target));
  // ponytail: pair scans suit small paper boards; use a spatial index if dense
  // graphs make this a measured bottleneck.
  const pairs = links.flatMap((a, i) => links.slice(i + 1).flatMap(b =>
    component(a.source) === component(b.source)
      ? [] : [{ a, b, direction: undefined as Axis | undefined }]));
  const nodeLinks = nodes.flatMap(node => links.flatMap(link =>
    node === link.source || node === link.target ? [] : [{ node, link, side: 0 }]));

  return (strength: number, clearanceStrength: number) => {
    const separating = new Map<Node, Set<Link>>();
    // Keep each pair's chosen escape direction for the entire relaxation.
    // Rechoosing it near an intersection makes forces flip and nodes jitter.
    for (const pair of pairs) {
      if (strength === 0) break;
      const { a, b } = pair;
      if (!pair.direction) {
        let distance = Infinity;
        let direction: Axis | undefined;
        for (const axis of [...axes(a), ...axes(b)]) {
          const { negative, positive } = separation(a, b, axis);
          if (negative <= 0 || positive <= 0) { direction = undefined; break; }
          const amount = Math.min(negative, positive);
          if (amount < distance) {
            distance = amount;
            const sign = negative <= positive ? -1 : 1;
            direction = { x: axis.x * sign, y: axis.y * sign };
          }
        }
        pair.direction = direction;
      }
      if (!pair.direction) continue;
      const amount = Math.max(0, separation(a, b, pair.direction).positive);
      if (amount > 0) {
        for (const [node, link] of [[a.source, b], [a.target, b], [b.source, a], [b.target, a]] as const) {
          const blocked = separating.get(node) ?? new Set<Link>();
          blocked.add(link);
          separating.set(node, blocked);
        }
      }
      const impulse = Math.min(1.6, amount * 0.018) * strength;
      push(a.source, pair.direction, impulse);
      push(a.target, pair.direction, impulse);
      push(b.source, pair.direction, -impulse);
      push(b.target, pair.direction, -impulse);
    }

    // Also open space between a card and unrelated lines (including two rays
    // that share a hub). This makes their actual endpoints easier to follow.
    for (const item of nodeLinks) {
      const { node, link } = item;
      // Once uncrossing ends, escape to the nearest side instead of an obsolete one.
      if (strength === 0) item.side = 0;
      // A crossing pair moves both endpoints to the same side. Let that finish
      // before individual card clearance can pull an endpoint the opposite way.
      if (separating.get(node)?.has(link)) { item.side = 0; continue; }
      const dx = link.target.x! - link.source.x!;
      const dy = link.target.y! - link.source.y!;
      const squared = dx * dx + dy * dy;
      if (squared < 1) continue;
      const t = ((node.x! - link.source.x!) * dx + (node.y! - link.source.y!) * dy) / squared;
      if (t <= 0 || t >= 1) continue;
      const normal = { x: -dy / Math.sqrt(squared), y: dx / Math.sqrt(squared) };
      const distance = (node.x! - link.source.x!) * normal.x + (node.y! - link.source.y!) * normal.y;
      const clearance = (Math.abs(normal.x) * node.width + Math.abs(normal.y) * node.height) / 2 + 28;
      if (Math.abs(distance) >= clearance && item.side === 0) continue;
      item.side ||= Math.abs(distance) > 0.01 ? Math.sign(distance) : node.id < link.source.id ? -1 : 1;
      const impulse = Math.min(3.2, Math.max(0, clearance - distance * item.side) * 0.06) * clearanceStrength;
      push(node, normal, impulse * item.side);
      push(link.source, normal, -impulse * item.side * (1 - t));
      push(link.target, normal, -impulse * item.side * t);
    }
  };
}
