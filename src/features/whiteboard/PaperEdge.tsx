import { BaseEdge, getStraightPath, type EdgeProps } from "@xyflow/react";
import type { PaperFlowEdge } from "./model/boardEdge";

export function PaperEdge(props: EdgeProps<PaperFlowEdge>) {
  const path = getStraightPath(props)[0];
  return <>
    <path d={path} className="whiteboard__edge-halo" fill="none" aria-hidden="true" />
    <BaseEdge id={props.id} path={path} style={props.style}
      markerStart={props.markerStart} markerEnd={props.markerEnd} interactionWidth={props.interactionWidth} />
  </>;
}
