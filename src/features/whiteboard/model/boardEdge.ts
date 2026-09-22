import type { Edge } from "@xyflow/react";

export interface BoardEdgeAnnotations {
  explanation: string;
  evidence: string;
}

export interface BoardEdgeRecord extends BoardEdgeAnnotations {
  id: string;
  boardId: string;
  sourceNodeId: string;
  targetNodeId: string;
  relation: BoardEdgeRelation;
}

export type BoardEdgeRelation = "support" | "challenge" | null;

interface PaperEdgeData extends Record<string, unknown>, BoardEdgeAnnotations {
  relation: BoardEdgeRelation;
  path?: string;
}

export type PaperFlowEdge = Edge<PaperEdgeData>;

export interface Point {
  x?: number;
  y?: number;
}

export function segmentsCross(
  firstStart: Point,
  firstEnd: Point,
  secondStart: Point,
  secondEnd: Point,
) {
  const side = (start: Point, end: Point, point: Point) =>
    ((end.x ?? 0) - (start.x ?? 0)) *
      ((point.y ?? 0) - (start.y ?? 0)) -
    ((end.y ?? 0) - (start.y ?? 0)) *
      ((point.x ?? 0) - (start.x ?? 0));
  return (
    side(firstStart, firstEnd, secondStart) *
      side(firstStart, firstEnd, secondEnd) <
      0 &&
    side(secondStart, secondEnd, firstStart) *
      side(secondStart, secondEnd, firstEnd) <
      0
  );
}

export function countEdgeCrossings(
  positions: ReadonlyMap<string, Point>,
  edges: readonly PaperFlowEdge[],
  relevantNodeIds?: ReadonlySet<string>,
) {
  const relevantEdgeIndexes = edges.flatMap((edge, index) =>
    relevantNodeIds === undefined ||
    relevantNodeIds.has(edge.source) ||
    relevantNodeIds.has(edge.target)
      ? [index]
      : [],
  );
  const relevantIndexSet = new Set(relevantEdgeIndexes);
  let crossings = 0;
  for (const firstIndex of relevantEdgeIndexes) {
    const first = edges[firstIndex];
    const firstSource = positions.get(first.source);
    const firstTarget = positions.get(first.target);
    if (!firstSource || !firstTarget) continue;
    for (let secondIndex = 0; secondIndex < edges.length; secondIndex += 1) {
      if (
        secondIndex === firstIndex ||
        (relevantIndexSet.has(secondIndex)
          ? secondIndex < firstIndex
          : relevantNodeIds === undefined && secondIndex < firstIndex)
      ) {
        continue;
      }
      const second = edges[secondIndex];
      if (
        first.source === second.source ||
        first.source === second.target ||
        first.target === second.source ||
        first.target === second.target
      ) {
        continue;
      }
      const secondSource = positions.get(second.source);
      const secondTarget = positions.get(second.target);
      if (
        secondSource &&
        secondTarget &&
        segmentsCross(firstSource, firstTarget, secondSource, secondTarget)
      ) {
        crossings += 1;
      }
    }
  }
  return crossings;
}

export function connectionKey(firstNodeId: string, secondNodeId: string) {
  return [firstNodeId, secondNodeId].sort().join("\u0000");
}

export function toFlowEdge(record: BoardEdgeRecord): PaperFlowEdge {
  return withEdgeRelation({
    id: record.id,
    source: record.sourceNodeId,
    target: record.targetNodeId,
    type: "paper",
    data: { relation: null, explanation: record.explanation, evidence: record.evidence },
  }, record.relation ?? null);
}

export function withEdgeRelation(
  edge: PaperFlowEdge,
  relation: BoardEdgeRelation,
): PaperFlowEdge {
  const relationLabel =
    relation === null
      ? "Neutral"
      : relation[0].toUpperCase() + relation.slice(1);
  return {
    ...edge,
    ariaLabel: `${relationLabel} connection`,
    className: relation ? `whiteboard__edge--${relation}` : undefined,
    data: { explanation: "", evidence: "", ...edge.data, relation },
  };
}
