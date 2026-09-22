import type { PaperFlowNode } from "./boardNode";

export const NODE_COLLISION_GAP = 24;

export interface NodeRectangle {
  id: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
}

function numericSize(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

export function toNodeRectangle(node: PaperFlowNode): NodeRectangle {
  return {
    id: node.id,
    position: { ...node.position },
    size: {
      height:
        numericSize(node.measured?.height) || numericSize(node.style?.height),
      width: numericSize(node.measured?.width) || numericSize(node.style?.width),
    },
  };
}

function overlaps(
  active: NodeRectangle,
  position: { x: number; y: number },
  obstacle: NodeRectangle,
  gap: number,
) {
  return !(
    position.x + active.size.width + gap <= obstacle.position.x ||
    obstacle.position.x + obstacle.size.width + gap <= position.x ||
    position.y + active.size.height + gap <= obstacle.position.y ||
    obstacle.position.y + obstacle.size.height + gap <= position.y
  );
}

function sweptOverlaps(
  active: NodeRectangle,
  previousPosition: { x: number; y: number },
  obstacle: NodeRectangle,
  gap: number,
) {
  const deltaX = active.position.x - previousPosition.x;
  const deltaY = active.position.y - previousPosition.y;
  const axisTimes = (
    start: number,
    delta: number,
    minimum: number,
    maximum: number,
  ): [number, number] | null => {
    if (delta === 0) {
      return start > minimum && start < maximum
        ? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]
        : null;
    }
    const first = (minimum - start) / delta;
    const second = (maximum - start) / delta;
    return [Math.min(first, second), Math.max(first, second)];
  };
  const xTimes = axisTimes(
    previousPosition.x,
    deltaX,
    obstacle.position.x - active.size.width - gap,
    obstacle.position.x + obstacle.size.width + gap,
  );
  const yTimes = axisTimes(
    previousPosition.y,
    deltaY,
    obstacle.position.y - active.size.height - gap,
    obstacle.position.y + obstacle.size.height + gap,
  );
  if (!xTimes || !yTimes) return false;

  const entryTime = Math.max(xTimes[0], yTimes[0], 0);
  const exitTime = Math.min(xTimes[1], yTimes[1], 1);
  return entryTime < exitTime;
}

type CollisionAxis = "x" | "y";
type CollisionDirection = -1 | 1;

export interface PushNodesDuringDragStats {
  candidateChecks: number;
  pushedNodes: number;
}

export interface ResolveNodeOverlapsOptions {
  gap?: number;
  pinnedNodeIds?: ReadonlySet<string>;
  priorityNodeIds?: ReadonlySet<string>;
  stats?: ResolveNodeOverlapsStats;
}

export interface ResolveNodeOverlapsStats {
  fallbackChecks: number;
}

const MAX_OVERLAP_RESOLUTION_PASSES = 16;
const OVERLAP_SEPARATION_EPSILON = 0.001;

export function overlapCorrection(
  first: NodeRectangle,
  second: NodeRectangle,
  gap: number,
) {
  if (!overlaps(first, first.position, second, gap)) return null;
  const firstCenterX = first.position.x + first.size.width / 2;
  const firstCenterY = first.position.y + first.size.height / 2;
  const secondCenterX = second.position.x + second.size.width / 2;
  const secondCenterY = second.position.y + second.size.height / 2;
  const deltaX =
    firstCenterX <= secondCenterX
      ? first.position.x + first.size.width + gap - second.position.x
      : -(second.position.x + second.size.width + gap - first.position.x);
  const deltaY =
    firstCenterY <= secondCenterY
      ? first.position.y + first.size.height + gap - second.position.y
      : -(second.position.y + second.size.height + gap - first.position.y);
  return Math.abs(deltaX) <= Math.abs(deltaY)
    ? {
        x:
          deltaX + Math.sign(deltaX || 1) * OVERLAP_SEPARATION_EPSILON,
        y: 0,
      }
    : {
        x: 0,
        y:
          deltaY + Math.sign(deltaY || 1) * OVERLAP_SEPARATION_EPSILON,
      };
}

export function resolveNodeOverlaps(
  nodes: readonly PaperFlowNode[],
  options: ResolveNodeOverlapsOptions = {},
): PaperFlowNode[] {
  const gap = options.gap ?? NODE_COLLISION_GAP;
  const pinnedNodeIds = options.pinnedNodeIds ?? new Set<string>();
  const priorityNodeIds = options.priorityNodeIds ?? new Set<string>();
  if (options.stats) options.stats.fallbackChecks = 0;
  const nextNodes = nodes.map((node) => ({
    ...node,
    position: { ...node.position },
  }));
  if (!Number.isFinite(gap) || gap < 0 || nodes.length < 2) {
    return nextNodes;
  }
  const rectangles = nextNodes.map(toNodeRectangle);
  const move = (index: number, deltaX: number, deltaY: number) => {
    nextNodes[index].position.x += deltaX;
    nextNodes[index].position.y += deltaY;
    rectangles[index].position.x += deltaX;
    rectangles[index].position.y += deltaY;
  };

  for (let pass = 0; pass < MAX_OVERLAP_RESOLUTION_PASSES; pass += 1) {
    const orderedIndexes = rectangles
      .map((_, index) => index)
      .sort(
        (firstIndex, secondIndex) =>
          rectangles[firstIndex].position.x -
            rectangles[secondIndex].position.x ||
          firstIndex - secondIndex,
      );
    const candidatePairs: Array<[number, number]> = [];
    for (let orderIndex = 0; orderIndex < orderedIndexes.length; orderIndex += 1) {
      const firstIndex = orderedIndexes[orderIndex];
      const first = rectangles[firstIndex];
      for (
        let candidateOrder = orderIndex + 1;
        candidateOrder < orderedIndexes.length;
        candidateOrder += 1
      ) {
        const secondIndex = orderedIndexes[candidateOrder];
        const second = rectangles[secondIndex];
        if (
          second.position.x >=
          first.position.x + first.size.width + gap
        ) {
          break;
        }
        if (
          second.position.y < first.position.y + first.size.height + gap &&
          first.position.y < second.position.y + second.size.height + gap
        ) {
          candidatePairs.push([firstIndex, secondIndex]);
        }
      }
    }

    let moved = false;
    for (const [firstIndex, secondIndex] of candidatePairs) {
      const first = rectangles[firstIndex];
      const second = rectangles[secondIndex];
      const correction = overlapCorrection(first, second, gap);
      if (!correction) continue;
      const firstPinned = pinnedNodeIds.has(first.id);
      const secondPinned = pinnedNodeIds.has(second.id);
      if (firstPinned && secondPinned) continue;
      const firstPriority = priorityNodeIds.has(first.id);
      const secondPriority = priorityNodeIds.has(second.id);

      if (
        firstPinned ||
        (!secondPinned && firstPriority && !secondPriority)
      ) {
        move(secondIndex, correction.x, correction.y);
      } else if (
        secondPinned ||
        (!firstPinned && secondPriority && !firstPriority)
      ) {
        move(firstIndex, -correction.x, -correction.y);
      } else {
        move(firstIndex, -correction.x / 2, -correction.y / 2);
        move(secondIndex, correction.x / 2, correction.y / 2);
      }
      moved = true;
    }
    if (!moved) break;
  }

  const hasUnresolvedOverlap = rectangles.some((first, firstIndex) =>
    rectangles.some(
      (second, secondIndex) =>
        secondIndex > firstIndex &&
        overlaps(first, first.position, second, gap),
    ),
  );
  if (hasUnresolvedOverlap) {
    // ponytail: O(n²) dense fallback; add a spatial index only if thousand-node boards need it.
    const placedByY: NodeRectangle[] = [];
    const orderedIndexes = rectangles
      .map((_, index) => index)
      .sort((firstIndex, secondIndex) => {
        const rank = (index: number) =>
          pinnedNodeIds.has(rectangles[index].id)
            ? 0
            : priorityNodeIds.has(rectangles[index].id)
              ? 1
              : 2;
        return rank(firstIndex) - rank(secondIndex) || firstIndex - secondIndex;
      });
    for (const index of orderedIndexes) {
      const rectangle = rectangles[index];
      if (!pinnedNodeIds.has(rectangle.id)) {
        for (const obstacle of placedByY) {
          if (options.stats) options.stats.fallbackChecks += 1;
          if (overlaps(rectangle, rectangle.position, obstacle, gap)) {
            rectangle.position.y =
              obstacle.position.y + obstacle.size.height + gap;
          }
        }
        nextNodes[index].position = { ...rectangle.position };
      }
      const insertionIndex = placedByY.findIndex(
        (placed) => placed.position.y > rectangle.position.y,
      );
      if (insertionIndex === -1) placedByY.push(rectangle);
      else placedByY.splice(insertionIndex, 0, rectangle);
    }
  }

  return nextNodes;
}

function pushedAxisPosition(
  mover: NodeRectangle,
  obstacle: NodeRectangle,
  axis: CollisionAxis,
  direction: CollisionDirection,
  gap: number,
) {
  if (axis === "x") {
    return direction === 1
      ? mover.position.x + mover.size.width + gap
      : mover.position.x - obstacle.size.width - gap;
  }
  return direction === 1
    ? mover.position.y + mover.size.height + gap
    : mover.position.y - obstacle.size.height - gap;
}

export function pushNodesDuringDrag(
  activeNode: PaperFlowNode,
  previousPosition: { x: number; y: number },
  nodes: readonly PaperFlowNode[],
  gap = NODE_COLLISION_GAP,
  stats?: PushNodesDuringDragStats,
): PaperFlowNode[] {
  if (stats) {
    stats.candidateChecks = 0;
    stats.pushedNodes = 0;
  }
  const nextNodes = nodes.map((node) =>
    node.id === activeNode.id
      ? { ...node, position: { ...activeNode.position } }
      : node,
  );
  if (!Number.isFinite(gap) || gap < 0) return nextNodes;

  const deltaX = activeNode.position.x - previousPosition.x;
  const deltaY = activeNode.position.y - previousPosition.y;
  if (
    !Number.isFinite(deltaX) ||
    !Number.isFinite(deltaY) ||
    (deltaX === 0 && deltaY === 0)
  ) {
    return nextNodes;
  }

  const axis: CollisionAxis =
    Math.abs(deltaX) >= Math.abs(deltaY) ? "x" : "y";
  const direction = Math.sign(axis === "x" ? deltaX : deltaY) as
    | CollisionDirection
    | 0;
  if (direction === 0) return nextNodes;
  const activeIndex = nextNodes.findIndex((node) => node.id === activeNode.id);
  if (activeIndex < 0) return nextNodes;

  const rectangles = nextNodes.map(toNodeRectangle);
  const originalPositions = rectangles.map((rectangle, index) =>
    index === activeIndex
      ? { ...previousPosition }
      : { ...rectangle.position },
  );
  const originalNodeCenters = rectangles.map((rectangle, index) => ({
    x:
      originalPositions[index].x +
      rectangle.size.width / 2,
    y:
      originalPositions[index].y +
      rectangle.size.height / 2,
  }));
  const originalAxisCenters = originalNodeCenters.map((center) =>
    axis === "x" ? center.x : center.y,
  );
  const orderedIndexes = rectangles
    .map((_, index) => index)
    .filter((index) => index !== activeIndex)
    .sort((firstIndex, secondIndex) => {
      const centerDifference =
        (originalAxisCenters[firstIndex] -
          originalAxisCenters[secondIndex]) *
        direction;
      return centerDifference || (firstIndex - secondIndex) * direction;
    });
  const pushed = new Array<boolean>(rectangles.length).fill(false);
  const activeRectangle = rectangles[activeIndex];
  const activeOrigin = originalNodeCenters[activeIndex];

  for (const nodeIndex of orderedIndexes) {
    const nodeOrigin = originalNodeCenters[nodeIndex];
    const projection =
      (nodeOrigin.x - activeOrigin.x) * deltaX +
      (nodeOrigin.y - activeOrigin.y) * deltaY;

    const rectangle = rectangles[nodeIndex];
    if (stats) stats.candidateChecks += 1;
    const overlapsAtEnd = overlaps(
      activeRectangle,
      activeRectangle.position,
      rectangle,
      gap,
    );
    const overlapsDuringSweep = sweptOverlaps(
      activeRectangle,
      previousPosition,
      rectangle,
      gap,
    );
    if (!overlapsAtEnd && !overlapsDuringSweep) {
      continue;
    }
    // A negative center projection normally means the card is behind the
    // pointer. Keep ignoring it only when the drag began inside its padded
    // bounds and is retreating. A start-free diagonal graze can legitimately
    // have a negative center projection while its corners still collide.
    if (
      projection < 0 &&
      overlaps(activeRectangle, previousPosition, rectangle, gap)
    ) {
      continue;
    }
    rectangle.position[axis] = pushedAxisPosition(
      activeRectangle,
      rectangle,
      axis,
      direction,
      gap,
    );
    pushed[nodeIndex] = true;
  }

  for (
    let moverOrderIndex = 0;
    moverOrderIndex < orderedIndexes.length;
    moverOrderIndex += 1
  ) {
    const moverIndex = orderedIndexes[moverOrderIndex];
    if (!pushed[moverIndex]) continue;
    const mover = rectangles[moverIndex];
    const moverPreviousPosition = originalPositions[moverIndex];

    for (
      let candidateOrderIndex = moverOrderIndex + 1;
      candidateOrderIndex < orderedIndexes.length;
      candidateOrderIndex += 1
    ) {
      const candidateIndex = orderedIndexes[candidateOrderIndex];
      const candidate = rectangles[candidateIndex];
      if (stats) stats.candidateChecks += 1;
      if (
        !overlaps(mover, mover.position, candidate, gap) &&
        !sweptOverlaps(mover, moverPreviousPosition, candidate, gap)
      ) {
        continue;
      }

      const proposedPosition = pushedAxisPosition(
        mover,
        candidate,
        axis,
        direction,
        gap,
      );
      const currentPosition = candidate.position[axis];
      const improvesPosition =
        direction === 1
          ? proposedPosition > currentPosition
          : proposedPosition < currentPosition;
      if (!improvesPosition) continue;
      candidate.position[axis] = proposedPosition;
      pushed[candidateIndex] = true;
    }
  }

  if (stats) {
    stats.pushedNodes = pushed.reduce(
      (count, wasPushed) => count + Number(wasPushed),
      0,
    );
  }
  return nextNodes.map((node, index) =>
    pushed[index]
      ? { ...node, position: { ...rectangles[index].position } }
      : node,
  );
}

export function pushNodeGroupDuringDrag(
  draggedNodes: readonly PaperFlowNode[],
  previousPositions: ReadonlyMap<string, { x: number; y: number }>,
  nodes: readonly PaperFlowNode[],
  gap = NODE_COLLISION_GAP,
): PaperFlowNode[] {
  if (draggedNodes.length === 0) return [...nodes];
  if (draggedNodes.length === 1) {
    const draggedNode = draggedNodes[0];
    return pushNodesDuringDrag(
      draggedNode,
      previousPositions.get(draggedNode.id) ?? draggedNode.position,
      nodes,
      gap,
    );
  }

  const draggedById = new Map(draggedNodes.map((node) => [node.id, node]));
  const nextNodes = nodes.map((node) => {
    const dragged = draggedById.get(node.id);
    return dragged ? { ...node, position: { ...dragged.position } } : node;
  });
  if (!Number.isFinite(gap) || gap < 0) return nextNodes;

  const representative = draggedNodes
    .map((node) => {
      const previous = previousPositions.get(node.id) ?? node.position;
      return {
        deltaX: node.position.x - previous.x,
        deltaY: node.position.y - previous.y,
      };
    })
    .sort(
      (first, second) =>
        Math.hypot(second.deltaX, second.deltaY) -
        Math.hypot(first.deltaX, first.deltaY),
    )[0];
  if (
    !representative ||
    !Number.isFinite(representative.deltaX) ||
    !Number.isFinite(representative.deltaY) ||
    (representative.deltaX === 0 && representative.deltaY === 0)
  ) {
    return nextNodes;
  }

  const axis: CollisionAxis =
    Math.abs(representative.deltaX) >= Math.abs(representative.deltaY)
      ? "x"
      : "y";
  const direction = Math.sign(
    axis === "x" ? representative.deltaX : representative.deltaY,
  ) as CollisionDirection | 0;
  if (direction === 0) return nextNodes;

  const rectangles = nextNodes.map(toNodeRectangle);
  const originalStaticPositions = rectangles.map((rectangle) => ({
    ...rectangle.position,
  }));
  const draggedIndexes = rectangles
    .map((rectangle, index) =>
      draggedById.has(rectangle.id) ? index : -1,
    )
    .filter((index) => index >= 0);
  const staticIndexes = rectangles
    .map((rectangle, index) =>
      draggedById.has(rectangle.id) ? -1 : index,
    )
    .filter((index) => index >= 0)
    .sort((firstIndex, secondIndex) => {
      const first = rectangles[firstIndex];
      const second = rectangles[secondIndex];
      const firstCenter =
        (axis === "x"
          ? first.position.x + first.size.width / 2
          : first.position.y + first.size.height / 2) * direction;
      const secondCenter =
        (axis === "x"
          ? second.position.x + second.size.width / 2
          : second.position.y + second.size.height / 2) * direction;
      return firstCenter - secondCenter || firstIndex - secondIndex;
    });
  const pushed = new Array<boolean>(rectangles.length).fill(false);
  const improveStaticPosition = (
    mover: NodeRectangle,
    staticIndex: number,
  ) => {
    const obstacle = rectangles[staticIndex];
    const proposed = pushedAxisPosition(
      mover,
      obstacle,
      axis,
      direction,
      gap,
    );
    const current = obstacle.position[axis];
    const improves = direction === 1 ? proposed > current : proposed < current;
    if (!improves) return false;
    obstacle.position[axis] = proposed;
    pushed[staticIndex] = true;
    return true;
  };

  for (const draggedIndex of draggedIndexes) {
    const draggedRectangle = rectangles[draggedIndex];
    const draggedNode = draggedById.get(draggedRectangle.id);
    if (!draggedNode) continue;
    const previous =
      previousPositions.get(draggedNode.id) ?? draggedNode.position;
    const deltaX = draggedNode.position.x - previous.x;
    const deltaY = draggedNode.position.y - previous.y;
    const activeOrigin = {
      x: previous.x + draggedRectangle.size.width / 2,
      y: previous.y + draggedRectangle.size.height / 2,
    };

    for (const staticIndex of staticIndexes) {
      const obstacle = rectangles[staticIndex];
      const obstacleCenter = {
        x: obstacle.position.x + obstacle.size.width / 2,
        y: obstacle.position.y + obstacle.size.height / 2,
      };
      const projection =
        (obstacleCenter.x - activeOrigin.x) * deltaX +
        (obstacleCenter.y - activeOrigin.y) * deltaY;
      const overlapsAtEnd = overlaps(
        draggedRectangle,
        draggedRectangle.position,
        obstacle,
        gap,
      );
      const overlapsDuringSweep = sweptOverlaps(
        draggedRectangle,
        previous,
        obstacle,
        gap,
      );
      if (!overlapsAtEnd && !overlapsDuringSweep) continue;
      if (
        projection < 0 &&
        overlaps(draggedRectangle, previous, obstacle, gap)
      ) {
        continue;
      }
      improveStaticPosition(draggedRectangle, staticIndex);
    }
  }

  // Keep one immutable behind-to-ahead order for the stationary cards. Each
  // pushed card is then packed past the fixed dragged group and every earlier
  // card in that order. This is a topological (therefore finite) propagation:
  // even when two cards are displaced to the same coordinate, later cards
  // cannot be left on top of an already-processed one.
  for (let orderIndex = 0; orderIndex < staticIndexes.length; orderIndex += 1) {
    const staticIndex = staticIndexes[orderIndex];
    const rectangle = rectangles[staticIndex];
    const earlierStaticIndexes = staticIndexes.slice(0, orderIndex);
    const reachingEarlierIndexes = earlierStaticIndexes.filter(
      (earlierIndex) => {
        if (!pushed[earlierIndex]) return false;
        const earlierRectangle = rectangles[earlierIndex];
        return (
          overlaps(
            earlierRectangle,
            earlierRectangle.position,
            rectangle,
            gap,
          ) ||
          sweptOverlaps(
            earlierRectangle,
            originalStaticPositions[earlierIndex],
            rectangle,
            gap,
          )
        );
      },
    );
    if (reachingEarlierIndexes.length > 0) pushed[staticIndex] = true;
    if (!pushed[staticIndex]) continue;

    const fixedObstacleIndexes = [
      ...draggedIndexes,
      ...earlierStaticIndexes,
    ];
    const rectangleAxisSize =
      axis === "x" ? rectangle.size.width : rectangle.size.height;
    const directionalStart = (candidate: NodeRectangle) => {
      const candidateAxisPosition = candidate.position[axis];
      const candidateAxisSize =
        axis === "x" ? candidate.size.width : candidate.size.height;
      return direction === 1
        ? candidateAxisPosition
        : -candidateAxisPosition - candidateAxisSize;
    };
    const overlapsSecondaryAxis = (obstacle: NodeRectangle) =>
      axis === "x"
        ? !(
            rectangle.position.y + rectangle.size.height + gap <=
              obstacle.position.y ||
            obstacle.position.y + obstacle.size.height + gap <=
              rectangle.position.y
          )
        : !(
            rectangle.position.x + rectangle.size.width + gap <=
              obstacle.position.x ||
            obstacle.position.x + obstacle.size.width + gap <=
              rectangle.position.x
          );
    const forbiddenRanges = fixedObstacleIndexes
      .map((obstacleIndex) => rectangles[obstacleIndex])
      .filter(overlapsSecondaryAxis)
      .map((obstacle) => {
        const obstacleStart = directionalStart(obstacle);
        const obstacleSize =
          axis === "x" ? obstacle.size.width : obstacle.size.height;
        return {
          end: obstacleStart + obstacleSize + gap,
          start: obstacleStart - rectangleAxisSize - gap,
        };
      })
      .sort((first, second) => first.start - second.start || first.end - second.end);
    let packedStart = directionalStart(rectangle);
    for (const earlierIndex of reachingEarlierIndexes) {
      const earlierRectangle = rectangles[earlierIndex];
      const earlierSize =
        axis === "x"
          ? earlierRectangle.size.width
          : earlierRectangle.size.height;
      packedStart = Math.max(
        packedStart,
        directionalStart(earlierRectangle) + earlierSize + gap,
      );
    }
    for (const range of forbiddenRanges) {
      if (packedStart <= range.start) break;
      if (packedStart < range.end) packedStart = range.end;
    }
    rectangle.position[axis] =
      direction === 1 ? packedStart : -packedStart - rectangleAxisSize;
  }

  return nextNodes.map((node, index) =>
    pushed[index]
      ? { ...node, position: { ...rectangles[index].position } }
      : node,
  );
}

export function findCollisionFreePosition(
  active: NodeRectangle,
  nodes: readonly NodeRectangle[],
  gap = NODE_COLLISION_GAP,
  score?: (position: { x: number; y: number }) => number,
): { x: number; y: number } {
  const desired = { ...active.position };
  if (!Number.isFinite(gap) || gap < 0) return desired;
  const obstacles = nodes.filter((node) => node.id !== active.id);
  const isFree = (position: { x: number; y: number }) =>
    obstacles.every((obstacle) => !overlaps(active, position, obstacle, gap));
  if (isFree(desired)) return desired;

  const candidates = new Map<string, { x: number; y: number }>();
  const addCandidate = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    candidates.set(`${x}\u0000${y}`, { x, y });
  };
  for (const obstacle of obstacles) {
    addCandidate(
      obstacle.position.x - active.size.width - gap,
      desired.y,
    );
    addCandidate(
      obstacle.position.x + obstacle.size.width + gap,
      desired.y,
    );
    addCandidate(
      desired.x,
      obstacle.position.y - active.size.height - gap,
    );
    addCandidate(
      desired.x,
      obstacle.position.y + obstacle.size.height + gap,
    );
  }

  return (
    [...candidates.values()]
      .filter(isFree)
      .map((position) => ({
        position,
        score: score?.(position) ?? 0,
        distance: Math.hypot(
          position.x - desired.x,
          position.y - desired.y,
        ),
      }))
      .sort(
        (first, second) =>
          first.score - second.score ||
          first.distance - second.distance ||
          first.position.y - second.position.y ||
          first.position.x - second.position.x,
      )[0]?.position ?? desired
  );
}
