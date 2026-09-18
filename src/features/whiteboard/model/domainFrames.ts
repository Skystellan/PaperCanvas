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

export function computeDomainFrames(
  nodes: readonly PaperFlowNode[],
  domains: readonly WhiteboardDomain[],
  padding = 48,
): DomainFrame[] {
  return domains.flatMap((domain) => {
    const rectangles = nodes
      .filter((node) => node.data.paper.domainId === domain.id)
      .map(toNodeRectangle);
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
