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

interface LayoutNode extends SimulationNodeDatum {
  anchorX: number;
  anchorY: number;
  id: string;
  domainId: string | null;
  height: number;
  width: number;
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
      return forceSimulation(group)
        .force(
          "link",
          forceLink<LayoutNode, LayoutLink>(layoutLinks)
            .id(({ id }) => id)
            .distance(OBSIDIAN_LINK_DISTANCE),
        )
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
    });
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
      return { offset, rectangle, pinned: group.some((node) => pinnedNodeIds.has(node.id)), dx: 0, dy: 0 };
    });
    // Translate whole regions independently of their internal force simulations.
    for (let first = 0; first < regions.length; first += 1) {
      for (let second = first + 1; second < regions.length; second += 1) {
        const a = regions[first];
        const b = regions[second];
        if (a.pinned && b.pinned) continue;
        const correction = overlapCorrection(a.rectangle, b.rectangle, 64);
        if (!correction) continue;
        regionsMoving = true;
        const aShare = a.pinned ? 0 : b.pinned ? 1 : 0.5;
        a.dx -= correction.x * aShare * 0.25;
        a.dy -= correction.y * aShare * 0.25;
        b.dx += correction.x * (1 - aShare) * 0.25;
        b.dy += correction.y * (1 - aShare) * 0.25;
      }
    }
    for (const region of regions) {
      const scale = Math.min(1, 24 / (Math.hypot(region.dx, region.dy) || 1));
      region.offset.x += region.dx * scale;
      region.offset.y += region.dy * scale;
    }
  };
  const tick = (iterations = 1) => {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      for (const simulation of simulations) simulation.tick();
      separateRegions();
    }
  };
  const isSettled = () => !regionsMoving && simulations.every((simulation) => simulation.alpha() <= simulation.alphaMin());
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
      for (const simulation of simulations) simulation.alphaTarget(0);
    },
    isSettled,
    pin: (nodeId: string, position: { x: number; y: number }) => {
      const node = byId.get(nodeId);
      if (!node) return;
      pinnedNodeIds.add(nodeId);
      const offset = offsets.get(node.domainId)!;
      node.fx = position.x + node.width / 2 - offset.x;
      node.fy = position.y + node.height / 2 - offset.y;
      node.x = node.fx;
      node.y = node.fy;
      node.vx = 0;
      node.vy = 0;
    },
    positions,
    release: (nodeId: string) => {
      const node = byId.get(nodeId);
      if (!node) return;
      pinnedNodeIds.delete(nodeId);
      node.fx = null;
      node.fy = null;
    },
    reheat: () => {
      for (const simulation of simulations) simulation.alpha(Math.max(simulation.alpha(), 0.3)).alphaTarget(0.3);
    },
    settle: () => {
      for (const simulation of simulations) simulation.alphaTarget(0);
      for (let frame = 0; frame < 300 && !isSettled(); frame += 1) tick();
    },
    tick,
  };
}
