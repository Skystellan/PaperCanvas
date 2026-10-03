import {
  memo,
} from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { PaperFlowNode } from "./model/boardNode";
import { codeStatusLabels } from "../research/research";

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
  const { githubUrl, githubStars } = data.paper;
  const githubLabel = `已记录 GitHub 仓库${data.paper.codeReview ? ` · ${codeStatusLabels[data.paper.codeReview.status]}` : ""}${githubStars == null ? "" : ` · ${githubStars.toLocaleString()} stars`}`;

  return (
    <article
      aria-label={
        data.onKeyboardConnectionSelect
          ? `连接节点：${data.paper.title}`
          : undefined
      }
      className={`paper-card${selected ? " is-selected" : ""}${githubUrl ? " has-github" : ""}`}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.repeat) return;
        event.preventDefault();
        event.stopPropagation();
        data.onKeyboardConnectionSelect?.(id);
      }}
      tabIndex={data.onKeyboardConnectionSelect ? 0 : undefined}
    >
      {githubUrl && <button
        type="button"
        className="paper-card__github nodrag nopan has-repository"
        aria-label={`${data.paper.title}：${githubLabel}`}
        title={`${githubLabel}；点击查看并刷新 Stars`}
        onClick={(event) => {
          event.stopPropagation();
          data.onEditGithub?.(data.paper);
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M12 .75a11.25 11.25 0 0 0-3.558 21.923c.563.104.769-.244.769-.542 0-.267-.01-.975-.015-1.913-3.13.68-3.79-1.509-3.79-1.509-.512-1.3-1.25-1.646-1.25-1.646-1.022-.699.078-.685.078-.685 1.13.08 1.725 1.16 1.725 1.16 1.004 1.72 2.634 1.223 3.276.935.103-.727.393-1.223.715-1.504-2.498-.284-5.124-1.25-5.124-5.56 0-1.228.439-2.232 1.16-3.019-.116-.284-.503-1.428.11-2.977 0 0 .945-.303 3.094 1.153A10.79 10.79 0 0 1 12 6.188c.956.004 1.919.13 2.818.379 2.149-1.456 3.092-1.153 3.092-1.153.615 1.549.228 2.693.112 2.977.723.787 1.159 1.791 1.159 3.019 0 4.32-2.63 5.273-5.136 5.552.404.35.765 1.043.765 2.1 0 1.517-.014 2.742-.014 3.114 0 .301.203.652.774.542A11.252 11.252 0 0 0 12 .75Z" />
        </svg>
        {githubStars != null && <span aria-hidden="true">★ {new Intl.NumberFormat("en", {
          notation: "compact", maximumFractionDigits: 1,
        }).format(githubStars)}</span>}
      </button>}
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
        {metadata && <p>{metadata}</p>}
        {data.paper.research && <small className="paper-card__research" title={data.paper.research.reason}>
          AI 初筛{data.paper.research.group ? ` · ${data.paper.research.group}` : ""}
        </small>}
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
