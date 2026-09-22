import { useEffect, useRef, useState } from "react";
import type { PdfFindState, PdfViewerRuntime } from "./pdfViewerRuntime";

export function PdfSearch({ runtime, result }: { runtime: PdfViewerRuntime | null; result: PdfFindState }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [open]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!runtime || !(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "f") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, [contenteditable="true"]') && !target.closest(".pdf-findbar")) return;
      event.preventDefault();
      setOpen(true);
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [runtime]);

  useEffect(() => {
    if (open) runtime?.find(query);
  }, [open, query, runtime]);

  const close = () => { setOpen(false); runtime?.closeFind(); buttonRef.current?.focus(); };
  return <>
    <button ref={buttonRef} type="button" aria-label="搜索 PDF" title="搜索 PDF (⌘F / Ctrl+F)" disabled={!runtime} onClick={() => setOpen(true)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
    </button>
    {open && <form className="pdf-findbar" role="search" aria-label="PDF 搜索" onSubmit={(event) => { event.preventDefault(); runtime?.find(query, false, true); }} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); runtime?.find(query, true, true); }
    }}>
      <input ref={inputRef} type="search" aria-label="在 PDF 中查找" placeholder="在 PDF 中查找…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <span className="pdf-findbar__count" role="status">{!query ? "" : result.pending ? "查找中…" : result.total ? `${result.current} / ${result.total}` : "无匹配"}</span>
      <button type="button" aria-label="上一个匹配" title="上一个 (Shift+Enter)" disabled={!query || !result.total} onClick={() => runtime?.find(query, true, true)}>↑</button>
      <button type="submit" aria-label="下一个匹配" title="下一个 (Enter)" disabled={!query || !result.total}>↓</button>
      <button type="button" aria-label="关闭 PDF 搜索" title="关闭 (Esc)" onClick={close}>×</button>
    </form>}
  </>;
}
