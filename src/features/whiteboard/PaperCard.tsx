import {
  memo,
} from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { PaperFlowNode } from "./model/boardNode";

const centerHandleStyle = {
  left: "50%",
  top: "50%",
  width: 0,
  height: 0,
  minWidth: 0,
  minHeight: 0,
  border: 0,
  padding: 0,
  opacity: 0,
  pointerEvents: "none",
  transform: "translate(-50%, -50%)",
} as const;

export const PaperCard = memo(function PaperCard({
  id,
  data,
  selected,
}: NodeProps<PaperFlowNode>) {
  const metadata = [data.paper.authors, data.paper.year?.toString()]
    .filter(Boolean)
    .join(" · ");

  return (
    <article
      aria-label={
        data.onKeyboardConnectionSelect
          ? `连接节点：${data.paper.title}`
          : undefined
      }
      className={`paper-card${selected ? " is-selected" : ""}`}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.repeat) return;
        event.preventDefault();
        event.stopPropagation();
        data.onKeyboardConnectionSelect?.(id);
      }}
      tabIndex={data.onKeyboardConnectionSelect ? 0 : undefined}
    >
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="paper-card__center-handle"
        aria-hidden="true"
        tabIndex={-1}
        style={centerHandleStyle}
      />
      <div className="paper-card__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M6.75 3.75h7.5l3 3v13.5H6.75z" />
          <path d="M14.25 3.75v3h3" />
          <path d="M9.5 11h5M9.5 14h5M9.5 17h3" />
        </svg>
      </div>
      <div className="paper-card__content">
        <h2>{data.paper.title}</h2>
        <p>{metadata || "Metadata unavailable"}</p>
      </div>
      <Handle
        type="source"
        position={Position.Top}
        isConnectable={false}
        className="paper-card__center-handle"
        aria-hidden="true"
        tabIndex={-1}
        style={centerHandleStyle}
      />
    </article>
  );
});
