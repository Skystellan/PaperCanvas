import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { PaperFlowEdge } from "./boardEdge";
import type { PaperFlowNode } from "./boardNode";
import { overlapCorrection, type NodeRectangle } from "./nodeCollision";
import { createEdgeRepulsion } from "./edgeRepulsion";

interface LayoutNode extends SimulationNodeDatum {
  anchorX: number;
  anchorY: number;
  id: string;
  domainId: string | null;
  height: number;
  width: number;
  mass: number;
  previousVx: number;
  previousVy: number;
}

interface LayoutLink extends SimulationLinkDatum<LayoutNode> {
  source: string | LayoutNode;
  target: string | LayoutNode;
}

interface ObsidianForceLayoutOptions {
  movableNodeIds?: ReadonlySet<string>;
  activeDomainIds?: ReadonlySet<string | null>;
}

export const OBSIDIAN_LINK_DISTANCE = 420;

function relaxedLinkLength(link: LayoutLink) {
  const a = link.source as LayoutNode;
  const b = link.target as LayoutNode;
  // Allow room for readable connections without making every stretch permanent.
  // This caps the spring's rest length, not the node positions or pointer travel.
  return Math.min(Math.hypot(a.x! - b.x!, a.y! - b.y!), OBSIDIAN_LINK_DISTANCE * 1.5);
}

export function localLayoutNodeIds(
  seedNodeIds: Iterable<string>,
  edges: readonly PaperFlowEdge[],
  hops = 2,
) {
  const included = new Set(seedNodeIds);
  let frontier = new Set(included);
  for (let hop = 0; hop < hops && frontier.size > 0; hop += 1) {
    const next = new Set<string>();
    for (const { source, target } of edges) {
      if (frontier.has(source) && !included.has(target)) next.add(target);
      if (frontier.has(target) && !included.has(source)) next.add(source);
    }
    for (const nodeId of next) included.add(nodeId);
    frontier = next;
  }
  return included;
}

function size(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

export function createObsidianForceLayout(
  nodes: readonly PaperFlowNode[],
  edges: readonly PaperFlowEdge[],
  options: ObsidianForceLayoutOptions = {},
) {
  const degrees = new Map<string, number>();
  for (const { source, target } of edges) {
    degrees.set(source, (degrees.get(source) ?? 0) + 1);
    degrees.set(target, (degrees.get(target) ?? 0) + 1);
  }
  const layoutNodes: LayoutNode[] = nodes.map((node) => {
    const width = size(node.measured?.width) || size(node.style?.width);
    const height = size(node.measured?.height) || size(node.style?.height);
    const x = node.position.x + width / 2;
    const y = node.position.y + height / 2;
    const fixed =
      options.movableNodeIds !== undefined &&
      !options.movableNodeIds.has(node.id);
    return {
      anchorX: x,
      anchorY: y,
      id: node.id,
      domainId: node.data.paper.domainId,
      width,
      height,
      // Hubs resist acceleration; directly dragged cards still follow the pointer.
      mass: Math.max(1, Math.min(8, degrees.get(node.id) ?? 0)),
      previousVx: 0,
      previousVy: 0,
      x,
      y,
      ...(fixed ? { fx: x, fy: y } : {}),
    };
  });
  const byId = new Map(layoutNodes.map((node) => [node.id, node]));
  const groups = new Map<string | null, LayoutNode[]>();
  for (const node of layoutNodes) {
    const group = groups.get(node.domainId) ?? [];
    group.push(node);
    groups.set(node.domainId, group);
  }
  const offsets = new Map([...groups.keys()].map((id) => [id, { x: 0, y: 0 }]));
  const pinnedNodeIds = new Set<string>();
  const releasedNodeIds = new Set<string>();
  let draggingLayout = false;
  const RELAXATION_FRAMES = 360;
  let relaxationFrame = -1;
  let quietFrames = 0;
  const simulations = [...groups.entries()]
    .filter(([id]) => !options.activeDomainIds || options.activeDomainIds.has(id))
    .map(([, group]) => {
      const nodeIds = new Set(group.map(({ id }) => id));
      // Cross-domain edges remain visible, but never pull regions together.
      const layoutLinks: LayoutLink[] = edges.flatMap(({ source, target }) =>
        nodeIds.has(source) && nodeIds.has(target) ? [{ source, target }] : [],
      );
      const center = {
        x: group.reduce((sum, node) => sum + (node.x ?? 0), 0) / group.length,
        y: group.reduce((sum, node) => sum + (node.y ?? 0), 0) / group.length,
      };
      const localLayout = options.movableNodeIds !== undefined;
      const linkForce = forceLink<LayoutNode, LayoutLink>(layoutLinks)
        .id(({ id }) => id).distance(OBSIDIAN_LINK_DISTANCE);
      const simulation = forceSimulation(group)
        .force("momentum", () => {
          for (const node of group) {
            node.previousVx = node.vx ?? 0;
            node.previousVy = node.vy ?? 0;
          }
        })
        .force("link", linkForce)
        .force("charge", forceManyBody<LayoutNode>().strength(-300).distanceMin(30))
        .force(
          "collision",
          forceCollide<LayoutNode>()
            .radius(({ width, height }) => Math.hypot(width, height) / 2 + 12)
            .strength(0.5),
        )
        .force(
          "x",
          (localLayout
            ? forceX<LayoutNode>(({ anchorX }) => anchorX)
            : forceX<LayoutNode>(center.x)
          ).strength(localLayout ? 0.08 : 0.05),
        )
        .force(
          "y",
          (localLayout
            ? forceY<LayoutNode>(({ anchorY }) => anchorY)
            : forceY<LayoutNode>(center.y)
          ).strength(localLayout ? 0.08 : 0.05),
        )
        .alpha(0.3)
        .velocityDecay(0.4)
        .alphaDecay(1 - Math.pow(0.001, 1 / 300))
        .stop();
      const resolvedLinks = layoutLinks.map(link => ({
        source: byId.get(typeof link.source === "string" ? link.source : link.source.id)!,
        target: byId.get(typeof link.target === "string" ? link.target : link.target.id)!,
      }));
      const neighborDirections = resolvedLinks.flatMap(({ source, target }) => {
        const [hub, neighbor] = (degrees.get(source.id) ?? 0) > (degrees.get(target.id) ?? 0)
          ? [source, target] : [target, source];
        const hubDegree = degrees.get(hub.id)!;
        const neighborDegree = degrees.get(neighbor.id)!;
        if (hubDegree < 3 || hubDegree === neighborDegree) return [];
        return [{ hub, neighbor,
          angle: Math.atan2(neighbor.y! - hub.y!, neighbor.x! - hub.x!),
          weight: (hubDegree - neighborDegree) / (hubDegree - 1),
        }];
      });
      simulation.force("neighbor-direction", () => {
        for (const { hub, neighbor, angle, weight } of neighborDirections) {
          if (!pinnedNodeIds.has(hub.id) && !releasedNodeIds.has(hub.id)) continue;
          if (neighbor.fx != null || neighbor.fy != null) continue;
          const dx = neighbor.x! - hub.x!;
          const dy = neighbor.y! - hub.y!;
          const distance = Math.hypot(dx, dy);
          const difference = angle - Math.atan2(dy, dx);
          const turn = Math.atan2(Math.sin(difference), Math.cos(difference));
          // Tangential motion keeps the original side of a dragged hub without
          // locking radii: springs and collision avoidance can still change spacing.
          const impulse = turn * Math.min(distance, OBSIDIAN_LINK_DISTANCE * 1.5) * 0.08 * weight;
          const currentAngle = Math.atan2(dy, dx);
          neighbor.vx! -= Math.sin(currentAngle) * impulse;
          neighbor.vy! += Math.cos(currentAngle) * impulse;
        }
      });
      const repulsion = createEdgeRepulsion(group, resolvedLinks);
      simulation.force("compactness", () => {
        // Keep a gentle pull toward the natural length as the main springs cool.
        // Collision and readability forces can still make room around crowded hubs.
        for (const { source, target } of resolvedLinks) {
          const dx = target.x! - source.x!;
          const dy = target.y! - source.y!;
          const distance = Math.hypot(dx, dy);
          // A deliberately placed peripheral card may keep some extra length;
          // tightening it fully would drag its heavier hub toward the drop point.
          const placedLeaf = (source.fx != null && source.mass < target.mass) ||
            (target.fx != null && target.mass < source.mass);
          const preferred = OBSIDIAN_LINK_DISTANCE * (placedLeaf ? 1.5 : 1);
          const excess = distance - preferred;
          if (excess <= 0) continue;
          // Small excesses yield to clearance; severely stretched links recover faster.
          const compactStrength = pinnedNodeIds.size > 0 ? 0 : 0.004;
          const overstretch = Math.max(0, distance - OBSIDIAN_LINK_DISTANCE * 2);
          const impulse = ((excess - overstretch) * compactStrength + overstretch * 0.025) / distance;
          // As with d3's links, let peripheral cards do most of the adjusting.
          const sourceShare = target.mass / (source.mass + target.mass);
          source.vx! += dx * impulse * sourceShare;
          source.vy! += dy * impulse * sourceShare;
          target.vx! -= dx * impulse * (1 - sourceShare);
          target.vy! -= dy * impulse * (1 - sourceShare);
        }
      });
      simulation.force("readability", () => {
        if (relaxationFrame < 0 || pinnedNodeIds.size > 0) return;
        const ramp = Math.min(1, relaxationFrame / 45, (RELAXATION_FRAMES - relaxationFrame) / 90);
        repulsion(Math.max(0, ramp));
      });
      simulation.force("speed-limit", () => {
        const limit = (relaxationFrame < 0 ? 8 : 2.4) / 0.6;
        for (const node of group) {
          node.vx = node.previousVx + (node.vx! - node.previousVx) / node.mass;
          node.vy = node.previousVy + (node.vy! - node.previousVy) / node.mass;
          const speed = Math.hypot(node.vx ?? 0, node.vy ?? 0);
          if (speed > limit) {
            node.vx! *= limit / speed;
            node.vy! *= limit / speed;
          }
        }
      });
      return { simulation, linkForce, group, resolvedLinks };
    });
  const needsRelaxation = simulations.some(({ group, resolvedLinks }) => group.length > 2 && resolvedLinks.length > 0);
  let regionsMoving = false;
  const separateRegions = () => {
    regionsMoving = false;
    if (groups.size < 2) return;
    const regions = [...groups.entries()].map(([id, group]) => {
      const offset = offsets.get(id)!;
      const left = Math.min(...group.map((node) => (node.x ?? 0) - node.width / 2)) - 48;
      const top = Math.min(...group.map((node) => (node.y ?? 0) - node.height / 2)) - 48;
      const right = Math.max(...group.map((node) => (node.x ?? 0) + node.width / 2)) + 48;
      const bottom = Math.max(...group.map((node) => (node.y ?? 0) + node.height / 2)) + 48;
      const rectangle: NodeRectangle = {
        id: id ?? "",
        position: { x: left + offset.x, y: top + offset.y },
        size: { width: right - left, height: bottom - top },
      };
      const priority = group.some(node => pinnedNodeIds.has(node.id)) ? 2
        : group.some(node => releasedNodeIds.has(node.id)) ? 1 : 0;
      return { offset, rectangle, priority, dx: 0, dy: 0 };
    });
    // Translate whole regions independently of their internal force simulations.
    for (let first = 0; first < regions.length; first += 1) {
      for (let second = first + 1; second < regions.length; second += 1) {
        const a = regions[first];
        const b = regions[second];
        if (a.priority === 2 && b.priority === 2) continue;
        const correction = overlapCorrection(a.rectangle, b.rectangle, 64);
        if (!correction) continue;
        regionsMoving = true;
        const aShare = a.priority > b.priority ? 0 : a.priority < b.priority ? 1 : 0.5;
        a.dx -= correction.x * aShare * 0.25;
        a.dy -= correction.y * aShare * 0.25;
        b.dx += correction.x * (1 - aShare) * 0.25;
        b.dy += correction.y * (1 - aShare) * 0.25;
      }
    }
    for (const region of regions) {
      const limit = relaxationFrame < 0 ? 24 : 2.4;
      const scale = Math.min(1, limit / (Math.hypot(region.dx, region.dy) || 1));
      region.offset.x += region.dx * scale;
      region.offset.y += region.dy * scale;
    }
  };
  const tick = (iterations = 1) => {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      if (needsRelaxation && relaxationFrame < 0 && pinnedNodeIds.size === 0) {
        const quiet = simulations.every(({ simulation, group }) => simulation.alpha() < 0.06 &&
          group.every(node => Math.hypot(node.vx ?? 0, node.vy ?? 0) < 0.8));
        quietFrames = quiet ? quietFrames + 1 : 0;
        if (quietFrames >= 12) {
          relaxationFrame = 0;
          for (const { simulation, linkForce, group } of simulations) {
            // Preserve reasonable spacing while long connections still contract.
            linkForce.distance(relaxedLinkLength).strength(0.025);
            for (const node of group) { node.anchorX = node.x!; node.anchorY = node.y!; }
            simulation.force("x", forceX<LayoutNode>(node => node.anchorX).strength(0.004));
            simulation.force("y", forceY<LayoutNode>(node => node.anchorY).strength(0.004));
            simulation.alpha(0.08);
          }
        }
      }
      for (const { simulation } of simulations) simulation.tick();
      separateRegions();
      if (relaxationFrame >= 0 && relaxationFrame < RELAXATION_FRAMES) relaxationFrame += 1;
    }
  };
  const isSettled = () => !regionsMoving && (!needsRelaxation || relaxationFrame >= RELAXATION_FRAMES) &&
    simulations.every(({ simulation }) => simulation.alpha() <= simulation.alphaMin());
  const positions = () =>
    new Map(
      layoutNodes.map((node) => [
        node.id,
        {
          x: (node.x ?? 0) - node.width / 2 + offsets.get(node.domainId)!.x,
          y: (node.y ?? 0) - node.height / 2 + offsets.get(node.domainId)!.y,
        },
      ]),
    );

  return {
    cool: () => {
      for (const { simulation } of simulations) simulation.alphaTarget(0);
    },
    isSettled,
    pin: (nodeId: string, position: { x: number; y: number }) => {
      const node = byId.get(nodeId);
      if (!node) return;
      if (!draggingLayout) {
        draggingLayout = true;
        for (const { simulation, linkForce, group } of simulations) {
          // A drag edits the existing arrangement, rather than restarting a
          // compact layout around its old center with 420px springs.
          linkForce.distance(relaxedLinkLength);
          for (const member of group) { member.anchorX = member.x!; member.anchorY = member.y!; }
          simulation.force("x", forceX<LayoutNode>(member => member.anchorX).strength(0.008));
          simulation.force("y", forceY<LayoutNode>(member => member.anchorY).strength(0.008));
        }
      }
      pinnedNodeIds.add(nodeId);
      releasedNodeIds.delete(nodeId);
      const offset = offsets.get(node.domainId)!;
      node.fx = position.x + node.width / 2 - offset.x;
      node.fy = position.y + node.height / 2 - offset.y;
      node.x = node.fx;
      node.y = node.fy;
      node.vx = 0;
      node.vy = 0;
    },
    positions,
    releasedNodeIds: releasedNodeIds as ReadonlySet<string>,
    release: (nodeId: string) => {
      const node = byId.get(nodeId);
      if (!node) return;
      pinnedNodeIds.delete(nodeId);
      // Preserve the user's drop point for this cooling cycle. The next drag or
      // explicit re-layout creates a fresh simulation, so this is not a permanent lock.
      releasedNodeIds.add(nodeId);
      for (const { linkForce } of simulations) linkForce.distance(relaxedLinkLength);
    },
    reheat: () => {
      for (const { simulation } of simulations) simulation.alpha(Math.max(simulation.alpha(), 0.3)).alphaTarget(0.3);
    },
    settle: () => {
      for (const { simulation } of simulations) simulation.alphaTarget(0);
      for (let frame = 0; frame < 900 && !isSettled(); frame += 1) tick();
    },
    tick,
  };
}
