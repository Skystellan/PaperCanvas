import type { PaperFlowNode } from "./boardNode";
import { countEdgeCrossings, type PaperFlowEdge } from "./boardEdge";
import {
  findCollisionFreePosition,
  toNodeRectangle,
  type NodeRectangle,
} from "./nodeCollision";

export interface WhiteboardDomain {
  id: string;
  name: string;
}

export interface DomainFrame {
  domainId: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Repair intersecting saved groups without imposing a movement boundary.
export function withDomainRegions(nodes: readonly PaperFlowNode[]): PaperFlowNode[] {
  const groups = new Map<string | null, PaperFlowNode[]>();
  for (const node of nodes) {
    const id = node.data.paper.domainId;
    const group = groups.get(id) ?? [];
    group.push(node);
    groups.set(id, group);
  }
  if (groups.size < 2) return [...nodes];

  const positioned = new Map<string, PaperFlowNode>();
  const placed: NodeRectangle[] = [];
  for (const [id, group] of groups) {
    const rectangles = group.map(toNodeRectangle);
    const x = Math.min(...rectangles.map((node) => node.position.x)) - 48;
    const y = Math.min(...rectangles.map((node) => node.position.y)) - 48;
    const right = Math.max(...rectangles.map((node) => node.position.x + node.size.width)) + 48;
    const bottom = Math.max(...rectangles.map((node) => node.position.y + node.size.height)) + 48;
    const rectangle = { id: id ?? "", position: { x, y }, size: { width: right - x, height: bottom - y } };
    const position = findCollisionFreePosition(rectangle, placed, 64);
    for (const node of group) {
      positioned.set(node.id, {
        ...node,
        position: { x: node.position.x + position.x - x, y: node.position.y + position.y - y },
      });
    }
    placed.push({ ...rectangle, position });
  }
  return nodes.map((node) => positioned.get(node.id)!);
}

export function computeDomainFrames(
  nodes: readonly PaperFlowNode[],
  domains: readonly WhiteboardDomain[],
  padding = 48,
): DomainFrame[] {
  return domains.flatMap((domain) => {
    const group = nodes.filter((node) => (node.data.paper.domainId ?? "") === domain.id);
    const rectangles = group.map(toNodeRectangle);
    if (rectangles.length === 0) return [];

    const left = Math.min(...rectangles.map(({ position }) => position.x));
    const top = Math.min(...rectangles.map(({ position }) => position.y));
    const right = Math.max(
      ...rectangles.map(
        ({ position, size }) => position.x + size.width,
      ),
    );
    const bottom = Math.max(
      ...rectangles.map(
        ({ position, size }) => position.y + size.height,
      ),
    );

    return [
      {
        domainId: domain.id,
        name: domain.name,
        x: left - padding,
        y: top - padding,
        width: right - left + padding * 2,
        height: bottom - top + padding * 2,
      },
    ];
  });
}

export function separateDomainGroups(
  nodes: readonly PaperFlowNode[],
  padding = 48,
  gap = 64,
  movableDomainIds?: ReadonlySet<string>,
  edges: readonly PaperFlowEdge[] = [],
): PaperFlowNode[] {
  const nextNodes = nodes.map((node) => ({
    ...node,
    position: { ...node.position },
  }));
  const groups = new Map<string, number[]>();
  nextNodes.forEach((node, index) => {
    const domainId = node.data.paper.domainId;
    if (!domainId) return;
    const indexes = groups.get(domainId);
    if (indexes) indexes.push(index);
    else groups.set(domainId, [index]);
  });
  const placed = nextNodes
    .filter((node) => node.data.paper.domainId === null)
    .map(toNodeRectangle);

  const orderedGroups = [...groups].sort(
    ([firstDomainId], [secondDomainId]) =>
      Number(movableDomainIds?.has(firstDomainId) ?? true) -
      Number(movableDomainIds?.has(secondDomainId) ?? true),
  );
  for (const [domainId, indexes] of orderedGroups) {
    const rectangles = indexes.map((index) => toNodeRectangle(nextNodes[index]));
    const left = Math.min(...rectangles.map(({ position }) => position.x));
    const top = Math.min(...rectangles.map(({ position }) => position.y));
    const right = Math.max(
      ...rectangles.map(({ position, size }) => position.x + size.width),
    );
    const bottom = Math.max(
      ...rectangles.map(({ position, size }) => position.y + size.height),
    );
    const frame: NodeRectangle = {
      id: domainId,
      position: { x: left - padding, y: top - padding },
      size: {
        width: right - left + padding * 2,
        height: bottom - top + padding * 2,
      },
    };
    const movedNodeIds = new Set(indexes.map((index) => nextNodes[index].id));
    const basePositions =
      edges.length > 0
        ? new Map(
            nextNodes.map((node) => {
              const rectangle = toNodeRectangle(node);
              return [
                node.id,
                {
                  x: rectangle.position.x + rectangle.size.width / 2,
                  y: rectangle.position.y + rectangle.size.height / 2,
                },
              ] as const;
            }),
          )
        : undefined;
    const position =
      movableDomainIds === undefined || movableDomainIds.has(domainId)
        ? findCollisionFreePosition(
            frame,
            placed,
            gap,
            basePositions
              ? (candidate) => {
                  const deltaX = candidate.x - frame.position.x;
                  const deltaY = candidate.y - frame.position.y;
                  const candidatePositions = new Map(basePositions);
                  for (const index of indexes) {
                    const node = nextNodes[index];
                    const center = basePositions.get(node.id);
                    if (center) {
                      candidatePositions.set(node.id, {
                        x: (center.x ?? 0) + deltaX,
                        y: (center.y ?? 0) + deltaY,
                      });
                    }
                  }
                  // ponytail: exact settle-time scan; add a spatial index only if huge cross-domain graphs block.
                  return countEdgeCrossings(
                    candidatePositions,
                    edges,
                    movedNodeIds,
                  );
                }
              : undefined,
          )
        : frame.position;
    const delta = {
      x: position.x - frame.position.x,
      y: position.y - frame.position.y,
    };
    for (const index of indexes) {
      nextNodes[index].position.x += delta.x;
      nextNodes[index].position.y += delta.y;
    }
    placed.push({ ...frame, position });
  }

  return nextNodes;
}
