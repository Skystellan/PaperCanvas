import { validateMindMapTree, type MindMapTree } from "./mindMap";

export const MIND_MAP_NODE_WIDTH = 224;
export const MIND_MAP_NODE_HEIGHT = 96;
export const MIND_MAP_HORIZONTAL_GAP = 88;
export const MIND_MAP_VERTICAL_GAP = 28;
export const MIND_MAP_COLLISION_GAP = 24;

interface PositionedNode {
  id: string;
  x: number;
  y: number;
}

function stableCompare(
  first: { id: string; title: string },
  second: { id: string; title: string },
) {
  const firstTitle = first.title.toLowerCase();
  const secondTitle = second.title.toLowerCase();
  if (firstTitle < secondTitle) return -1;
  if (firstTitle > secondTitle) return 1;
  return first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
}

export function layoutMindMapTree(value: MindMapTree): MindMapTree {
  const tree = validateMindMapTree(value);
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  for (const node of tree.nodes) {
    if (node.parentId === null) continue;
    const childIds = children.get(node.parentId) ?? [];
    childIds.push(node.id);
    children.set(node.parentId, childIds);
  }
  for (const childIds of children.values()) {
    childIds.sort((firstId, secondId) =>
      stableCompare(byId.get(firstId)!, byId.get(secondId)!),
    );
  }

  const root = tree.nodes.find((node) => node.parentId === null)!;
  const positions = new Map<string, { depth: number; y: number }>();
  let leafIndex = 0;
  const verticalStep = MIND_MAP_NODE_HEIGHT + MIND_MAP_VERTICAL_GAP;

  const place = (nodeId: string, depth: number): number => {
    const childIds = children.get(nodeId) ?? [];
    let y: number;
    if (childIds.length === 0) {
      y = leafIndex * verticalStep;
      leafIndex += 1;
    } else {
      const childYs = childIds.map((childId) => place(childId, depth + 1));
      y = (childYs[0]! + childYs[childYs.length - 1]!) / 2;
    }
    positions.set(nodeId, { depth, y });
    return y;
  };
  const rootY = place(root.id, 0);
  const horizontalStep = MIND_MAP_NODE_WIDTH + MIND_MAP_HORIZONTAL_GAP;

  return {
    ...tree,
    nodes: tree.nodes.map((node) => {
      const position = positions.get(node.id)!;
      return {
        ...node,
        x: position.depth * horizontalStep,
        y: position.y - rootY,
      };
    }),
  };
}

function overlaps(
  position: { x: number; y: number },
  obstacle: PositionedNode,
): boolean {
  return !(
    position.x + MIND_MAP_NODE_WIDTH + MIND_MAP_COLLISION_GAP <= obstacle.x ||
    obstacle.x + MIND_MAP_NODE_WIDTH + MIND_MAP_COLLISION_GAP <= position.x ||
    position.y + MIND_MAP_NODE_HEIGHT + MIND_MAP_COLLISION_GAP <= obstacle.y ||
    obstacle.y + MIND_MAP_NODE_HEIGHT + MIND_MAP_COLLISION_GAP <= position.y
  );
}

export function findNonOverlappingMindMapPosition(
  activeNodeId: string,
  desired: { x: number; y: number },
  nodes: readonly PositionedNode[],
): { x: number; y: number } {
  const desiredPosition = {
    x: Number.isFinite(desired.x) ? desired.x : 0,
    y: Number.isFinite(desired.y) ? desired.y : 0,
  };
  const obstacles = nodes.filter((node) => node.id !== activeNodeId);
  const isFree = (position: { x: number; y: number }) =>
    obstacles.every((obstacle) => !overlaps(position, obstacle));
  if (isFree(desiredPosition)) return desiredPosition;

  const candidates = new Map<string, { x: number; y: number }>();
  const addCandidate = (x: number, y: number) => {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      candidates.set(`${x}\u0000${y}`, { x, y });
    }
  };
  for (const obstacle of obstacles) {
    addCandidate(
      obstacle.x - MIND_MAP_NODE_WIDTH - MIND_MAP_COLLISION_GAP,
      desiredPosition.y,
    );
    addCandidate(
      obstacle.x + MIND_MAP_NODE_WIDTH + MIND_MAP_COLLISION_GAP,
      desiredPosition.y,
    );
    addCandidate(
      desiredPosition.x,
      obstacle.y - MIND_MAP_NODE_HEIGHT - MIND_MAP_COLLISION_GAP,
    );
    addCandidate(
      desiredPosition.x,
      obstacle.y + MIND_MAP_NODE_HEIGHT + MIND_MAP_COLLISION_GAP,
    );
  }

  const stepX = MIND_MAP_NODE_WIDTH + MIND_MAP_COLLISION_GAP;
  const stepY = MIND_MAP_NODE_HEIGHT + MIND_MAP_COLLISION_GAP;
  for (let radius = 1; radius <= obstacles.length + 2; radius += 1) {
    for (let offset = -radius; offset <= radius; offset += 1) {
      addCandidate(
        desiredPosition.x + offset * stepX,
        desiredPosition.y - radius * stepY,
      );
      addCandidate(
        desiredPosition.x + offset * stepX,
        desiredPosition.y + radius * stepY,
      );
      addCandidate(
        desiredPosition.x - radius * stepX,
        desiredPosition.y + offset * stepY,
      );
      addCandidate(
        desiredPosition.x + radius * stepX,
        desiredPosition.y + offset * stepY,
      );
    }
  }

  return (
    [...candidates.values()]
      .filter(isFree)
      .sort((first, second) => {
        const distance =
          Math.hypot(
            first.x - desiredPosition.x,
            first.y - desiredPosition.y,
          ) -
          Math.hypot(
            second.x - desiredPosition.x,
            second.y - desiredPosition.y,
          );
        return distance || first.y - second.y || first.x - second.x;
      })[0] ?? desiredPosition
  );
}
