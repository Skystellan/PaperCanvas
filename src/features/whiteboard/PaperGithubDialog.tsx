import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "../../platform/core";
import type { Paper } from "../library/model/paper";
import { fetchGithubStars } from "../library/services/githubRepository";
import { codeStatusLabels } from "../research/research";

export function PaperGithubDialog({ paper, onSave, onClose }: {
  paper: Paper;
  onSave: (githubUrl: string | null, githubStars: number | null) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState(paper.githubUrl ?? "");
  const [stars, setStars] = useState(paper.githubStars?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [refreshState, setRefreshState] = useState(paper.githubUrl ? "loading" : "idle");
  const [refreshError, setRefreshError] = useState("");
  const refreshRequest = useRef<Promise<number> | null>(null);

  useEffect(() => {
    if (!paper.githubUrl) return;
    const githubUrl = paper.githubUrl;
    let active = true;
    // Share the request across Strict Mode's effect replay; reopening mounts a new dialog.
    refreshRequest.current ??= fetchGithubStars(githubUrl);
    void refreshRequest.current.then(async count => {
      if (!active) return;
      try {
        await onSave(githubUrl, count);
        if (active) { setStars(String(count)); setRefreshState("ready"); }
      } catch {
        if (active) {
          setRefreshError("已获取最新 Stars，但保存失败；已保留上次记录。请重新打开后重试。");
          setRefreshState("error");
        }
      }
    }, reason => {
      if (active) {
        setRefreshError(reason instanceof Error ? reason.message : "刷新失败，已保留上次记录的 Stars。");
        setRefreshState("error");
      }
    });
    return () => { active = false; };
  }, [paper.githubUrl, onSave]);
  const refreshing = refreshState === "loading";

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  return createPortal(<dialog ref={dialog} className="paper-github-dialog" aria-labelledby="paper-github-heading"
    onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <form onSubmit={async event => {
      event.preventDefault();
      if (saving || refreshing) return;
      const githubUrl = url.trim() || null;
      const githubStars = githubUrl && stars.trim() ? Number(stars) : null;
      if (githubUrl && (!/^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9_.-]+\/?$/i.test(githubUrl)
        || [".", ".."].includes(githubUrl.split("/")[4]))) {
        setError("请输入 GitHub 仓库链接：https://github.com/owner/repo");
        return;
      }
      setSaving(true);
      setError("");
      try {
        await onSave(githubUrl, githubStars);
        onClose();
      } catch {
        setError("保存失败，输入已保留。请重试；若工作区已变更，请重新载入后再保存。");
      } finally {
        setSaving(false);
      }
    }}>
      <h2 id="paper-github-heading">GitHub 仓库</h2>
      <p className="paper-github-dialog__paper">{paper.title}</p>
      {paper.codeReview && <section className="paper-github-dialog__review" aria-label="代码审查记录">
        <strong>AI 查证 · {codeStatusLabels[paper.codeReview.status]}</strong>
        <p>{paper.codeReview.evidence}</p>
        <a href={paper.codeReview.evidenceUrl} target="_blank" rel="noreferrer" onClick={event => {
          if (!window.paperCanvas) return;
          event.preventDefault();
          void invoke("open_research_source", { url: paper.codeReview!.evidenceUrl })
            .catch(() => setError("无法打开依据，请复制链接到浏览器。"));
        }}>查看查证依据 ↗</a>
        <p className="paper-github-dialog__hint">查证于 {new Date(paper.codeReview.checkedAt).toLocaleString()}。结论由 AI 提供，可根据来源核对。</p>
      </section>}
      <label>仓库链接
        <input type="url" value={url} maxLength={4096} disabled={saving || refreshing}
          placeholder="https://github.com/owner/repo"
          onChange={event => { setUrl(event.target.value); setStars(""); }} />
      </label>
      <label>Stars（可选）
        <input type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} value={stars}
          disabled={saving || refreshing || !url.trim()} placeholder="未知"
          onChange={event => setStars(event.target.value)} />
      </label>
      {refreshing && <p role="status">正在从 GitHub 刷新 Stars…</p>}
      {refreshState === "ready" && <p role="status">Stars 已从 GitHub 刷新并保存。</p>}
      {refreshError && <p role="status">{refreshError}</p>}
      <p className="paper-github-dialog__hint">每次打开时刷新已记录仓库的 Stars，失败时保留上次记录。可让已连接的 AI 查证论文代码并保存依据；没有图标表示尚未关联仓库。修改仓库链接会清除原查证记录。</p>
      {paper.githubUrl && <a href={paper.githubUrl} target="_blank" rel="noreferrer"
        onClick={event => {
          if (!window.paperCanvas) return;
          event.preventDefault();
          void invoke("open_research_source", { url: paper.githubUrl }).catch(() => {
            setError("无法打开仓库，请复制链接到浏览器。");
          });
        }}>打开已记录的仓库 ↗</a>}
      {error && <p role="alert">{error}</p>}
      <div className="paper-github-dialog__actions">
        <button type="button" disabled={saving} onClick={onClose}>取消</button>
        <button type="submit" disabled={saving || refreshing}>{saving ? "保存中…" : "保存"}</button>
      </div>
    </form>
  </dialog>, document.body);
}
