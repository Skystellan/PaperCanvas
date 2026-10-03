import type { Paper } from "../library/model/paper";
import { useState } from "react";
import { invoke } from "../../platform/core";
import "./research.css";

export function ResearchPaperDetails({ paper }: { paper: Paper }) {
  const [linkError, setLinkError] = useState(false);
  const research = paper.research;
  if (!research) return null;
  return <article className="research-paper-details" aria-label="论文初筛信息">
    <span className="research-suggestion">AI 初筛 · {paper.filePath ? "已保存本地 PDF" : "尚未保存本地 PDF"}</span>
    <h2>{paper.title}</h2>
    <p>{[paper.authors, paper.year].filter(Boolean).join(" · ")}</p>
    {research.group && <p>分组：{research.group}</p>}
    {research.reason && <section><h3>推荐理由</h3><p>{research.reason}</p></section>}
    {research.abstract && <section><h3>摘要</h3><p>{research.abstract}</p></section>}
    <a href={research.url} target="_blank" rel="noreferrer" onClick={event => {
      if (!window.paperCanvas) return;
      event.preventDefault();
      setLinkError(false);
      void invoke("open_research_source", { url: research.url }).catch(() => setLinkError(true));
    }}>打开论文来源 ↗</a>
    {linkError && <p role="alert">无法打开来源，请复制链接到浏览器。</p>}
    <p className="research-paper-details__hint">来源与摘要由导入方提供；连线属于初步建议，可在画布中编辑。</p>
  </article>;
}
