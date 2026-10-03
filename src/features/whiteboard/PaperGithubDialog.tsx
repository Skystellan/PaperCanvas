import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Paper } from "../library/model/paper";

export function PaperGithubDialog({ paper, onSave, onClose }: {
  paper: Paper;
  onSave: (githubUrl: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState(paper.githubUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

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
      if (saving) return;
      const githubUrl = url.trim() || null;
      if (githubUrl && (!/^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9_.-]+\/?$/i.test(githubUrl)
        || [".", ".."].includes(githubUrl.split("/")[4]))) {
        setError("请输入 GitHub 仓库链接：https://github.com/owner/repo");
        return;
      }
      setSaving(true);
      setError("");
      try {
        await onSave(githubUrl);
        onClose();
      } catch {
        setError("保存失败，输入已保留。请重试；若工作区已变更，请重新载入后再保存。");
      } finally {
        setSaving(false);
      }
    }}>
      <h2 id="paper-github-heading">GitHub 仓库</h2>
      <p className="paper-github-dialog__paper">{paper.title}</p>
      <label>仓库链接
        <input type="url" value={url} maxLength={4096} disabled={saving}
          placeholder="https://github.com/owner/repo"
          onChange={event => setUrl(event.target.value)} />
      </label>
      <p className="paper-github-dialog__hint">点击卡片上的 GitHub 图标可打开仓库，Stars 会自动刷新并保存。清空链接可移除图标。</p>
      {error && <p role="alert">{error}</p>}
      <div className="paper-github-dialog__actions">
        <button type="button" disabled={saving} onClick={onClose}>取消</button>
        <button type="submit" disabled={saving}>{saving ? "保存中…" : "保存"}</button>
      </div>
    </form>
  </dialog>, document.body);
}
