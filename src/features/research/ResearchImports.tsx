import { useEffect, useState } from "react";
import { executeWorkspaceCommand } from "../../data/workspaceClient";
import type { ResearchBatchSummary } from "./research";
import "./research.css";

export function ResearchImports({ revision, onUndo, disabled }: {
  revision: number; onUndo: (batchId: string) => Promise<void>; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [batches, setBatches] = useState<ResearchBatchSummary[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let active = true;
    void executeWorkspaceCommand<ResearchBatchSummary[]>({ type: "list_research_batches" }).then(
      ({ value }) => { if (active) { setBatches(value); setError(""); } },
      () => { if (active) setError("无法载入导入记录。"); },
    );
    return () => { active = false; };
  }, [open, revision]);
  return <aside className="research-imports" aria-label="AI 导入记录">
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} disabled={disabled}>AI 导入</button>
    {open && <div className="research-imports__panel">
      <h2>AI 导入记录</h2>
      <p>在已连接的 AI 客户端中搜索、初筛，再导入到画布。独立检索不会自动读取已有论文。</p>
      <p>撤回仅移除本批新增的卡片和连线，论文仍留在论文库。若这些内容已有修改或新增连接，将停止撤回并保留现状。</p>
      {batches.length === 0 && !error && <p>还没有研究导入记录。</p>}
      <ul>{batches.map(batch => <li key={batch.id}>
        <strong>{batch.title}</strong>
        <span>{batch.createdNodes} 张卡片 · {batch.createdEdges} 条连线</span>
        {batch.undone ? <span>已撤回</span> : <button type="button" disabled={disabled} onClick={() => {
          setError("");
          void onUndo(batch.id).catch(() => setError("无法撤回：内容可能已被编辑或新增连接，请保留这些修改并手动整理。"));
        }}>撤回本次导入</button>}
      </li>)}</ul>
      {error && <p role="alert">{error}</p>}
    </div>}
  </aside>;
}
