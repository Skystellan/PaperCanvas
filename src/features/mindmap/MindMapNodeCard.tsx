import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { MindMapFlowNode } from "./model/mindMapFlow";

export const MindMapNodeCard = memo(function MindMapNodeCard({
  data,
  selected,
}: NodeProps<MindMapFlowNode>) {
  return (
    <article
      className={`mind-map-node${data.isRoot ? " is-root" : ""}${
        selected ? " is-selected" : ""
      }`}
    >
      <Handle
        className="mind-map-node__handle"
        isConnectable={false}
        position={Position.Left}
        type="target"
      />
      <span className="mind-map-node__eyebrow">
        {data.isRoot ? "Paper" : "Idea"}
      </span>
      <h3>{data.title}</h3>
      {data.details && <p>{data.details}</p>}
      <Handle
        className="mind-map-node__handle"
        isConnectable={false}
        position={Position.Right}
        type="source"
      />
    </article>
  );
});
