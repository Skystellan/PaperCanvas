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
import {
  segmentsCross,
  type PaperFlowEdge,
} from "./boardEdge";
import type { PaperFlowNode } from "./boardNode";

interface LayoutNode extends SimulationNodeDatum {
  anchorX: number;
  anchorY: number;
  id: string;
  height: number;
  width: number;
}

interface LayoutLink extends SimulationLinkDatum<LayoutNode> {
  source: string | LayoutNode;
  target: string | LayoutNode;
}

interface CrossingLink {
  id: string;
  source: LayoutNode;
  target: LayoutNode;
}

interface ObsidianForceLayoutOptions {
  movableNodeIds?: ReadonlySet<string>;
  stats?: { crossingChecks: number };
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

function crossingForce(
  links: readonly CrossingLink[],
  stats?: { crossingChecks: number },
) {
  let pairCursor = 0;
  return (alpha: number) => {
    const movableCount = ({ source, target }: CrossingLink) =>
      Number(source.fx == null && source.fy == null) +
      Number(target.fx == null && target.fy == null);
    const movableCounts = links.map(movableCount);
    const activeIndexes = movableCounts.flatMap((count, index) =>
      count > 0 ? [index] : [],
    );
    const activeIndexSet = new Set(activeIndexes);
    const impulses = new Map<LayoutNode, { x: number; y: number }>();
    const addImpulse = (node: LayoutNode, x: number, y: number) => {
      const impulse = impulses.get(node) ?? { x: 0, y: 0 };
      impulse.x += x;
      impulse.y += y;
      impulses.set(node, impulse);
    };

    const pairCount = activeIndexes.length * links.length;
    const inspectedPairCount = Math.min(pairCount, 4_000);
    // ponytail: 4k rotating pair budget; add a spatial index if large graphs cool before coverage.
    for (let offset = 0; offset < inspectedPairCount; offset += 1) {
      const pairIndex = (pairCursor + offset) % pairCount;
      const firstIndex = activeIndexes[Math.floor(pairIndex / links.length)];
      const first = links[firstIndex];
      const secondIndex = pairIndex % links.length;
      if (
        secondIndex === firstIndex ||
        (activeIndexSet.has(secondIndex) && secondIndex < firstIndex)
      ) {
        continue;
      }
      const second = links[secondIndex];
      if (
        first.source === second.source ||
        first.source === second.target ||
        first.target === second.source ||
        first.target === second.target
      ) {
        continue;
      }
      if (stats) stats.crossingChecks += 1;
      if (
        !segmentsCross(
          first.source,
          first.target,
          second.source,
          second.target,
        )
      ) {
        continue;
      }
      const firstMovable = movableCounts[firstIndex];
      const secondMovable = movableCounts[secondIndex];
      const active =
        secondMovable > firstMovable ||
        (secondMovable === firstMovable && second.id > first.id)
          ? second
          : first;
      const dx = (active.target.x ?? 0) - (active.source.x ?? 0);
      const dy = (active.target.y ?? 0) - (active.source.y ?? 0);
      const length = Math.hypot(dx, dy) || 1;
      const pushX = (-dy / length) * 120 * alpha;
      const pushY = (dx / length) * 120 * alpha;
      if (active.source.fx == null && active.source.fy == null) {
        addImpulse(active.source, -pushX, -pushY);
      }
      if (active.target.fx == null && active.target.fy == null) {
        addImpulse(active.target, pushX, pushY);
      }
    }
    if (pairCount > 0) {
      pairCursor = (pairCursor + inspectedPairCount) % pairCount;
    }
    const maximumImpulse = 120 * alpha;
    for (const [node, impulse] of impulses) {
      const magnitude = Math.hypot(impulse.x, impulse.y) || 1;
      const scale = Math.min(1, maximumImpulse / magnitude);
      node.vx = (node.vx ?? 0) + impulse.x * scale;
      node.vy = (node.vy ?? 0) + impulse.y * scale;
    }
  };
}

export function createObsidianForceLayout(
  nodes: readonly PaperFlowNode[],
  edges: readonly PaperFlowEdge[],
  options: ObsidianForceLayoutOptions = {},
) {
  if (options.stats) options.stats.crossingChecks = 0;
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
      width,
      height,
      x,
      y,
      ...(fixed ? { fx: x, fy: y } : {}),
    };
  });
  const byId = new Map(layoutNodes.map((node) => [node.id, node]));
  const nodeIds = new Set(layoutNodes.map(({ id }) => id));
  const layoutLinks: LayoutLink[] = edges.flatMap(({ source, target }) =>
    nodeIds.has(source) && nodeIds.has(target) ? [{ source, target }] : [],
  );
  const crossingLinks: CrossingLink[] = edges.flatMap(({ id, source, target }) => {
    const sourceNode = byId.get(source);
    const targetNode = byId.get(target);
    return sourceNode && targetNode
      ? [{ id, source: sourceNode, target: targetNode }]
      : [];
  });
  const center = layoutNodes.reduce(
    (sum, node) => ({ x: sum.x + (node.x ?? 0), y: sum.y + (node.y ?? 0) }),
    { x: 0, y: 0 },
  );
  if (layoutNodes.length > 0) {
    center.x /= layoutNodes.length;
    center.y /= layoutNodes.length;
  }
  const localLayout = options.movableNodeIds !== undefined;
  const simulation = forceSimulation(layoutNodes)
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
    .force("untangle", crossingForce(crossingLinks, options.stats))
    .velocityDecay(0.4)
    .alphaDecay(1 - Math.pow(0.001, 1 / 300))
    .stop();
  const positions = () =>
    new Map(
      layoutNodes.map((node) => [
        node.id,
        {
          x: (node.x ?? 0) - node.width / 2,
          y: (node.y ?? 0) - node.height / 2,
        },
      ]),
    );

  return {
    cool: () => {
      simulation.alphaTarget(0);
    },
    isSettled: () => simulation.alpha() <= simulation.alphaMin(),
    pin: (nodeId: string, position: { x: number; y: number }) => {
      const node = byId.get(nodeId);
      if (!node) return;
      node.fx = position.x + node.width / 2;
      node.fy = position.y + node.height / 2;
      node.x = node.fx;
      node.y = node.fy;
    },
    positions,
    release: (nodeId: string) => {
      const node = byId.get(nodeId);
      if (!node) return;
      node.fx = null;
      node.fy = null;
    },
    reheat: () => {
      simulation.alpha(Math.max(simulation.alpha(), 0.3)).alphaTarget(0.3);
    },
    settle: () => {
      simulation.alphaTarget(0);
      for (let tick = 0; tick < 300 && simulation.alpha() > simulation.alphaMin(); tick += 1) {
        simulation.tick();
      }
    },
    sync: (nextNodes: readonly PaperFlowNode[]) => {
      for (const nextNode of nextNodes) {
        const node = byId.get(nextNode.id);
        if (!node) continue;
        node.x = nextNode.position.x + node.width / 2;
        node.y = nextNode.position.y + node.height / 2;
        if (node.fx != null) node.fx = node.x;
        if (node.fy != null) node.fy = node.y;
      }
    },
    tick: (iterations = 1) => {
      simulation.tick(iterations);
    },
  };
}
