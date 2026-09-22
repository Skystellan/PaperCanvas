import { useEffect, useState } from "react";
import type { PdfOutlineEntry } from "./model/pdfOutline";
import type { PdfViewerRuntime } from "./pdfViewerRuntime";

function readBookmarks(key: string, pageCount: number): number[] {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(saved) ? saved.filter((page) => Number.isInteger(page) && page > 0 && page <= pageCount) : [];
  } catch { return []; }
}

export function PdfOutline({ runtime, currentPage, filePath, pageCount }: {
  runtime: PdfViewerRuntime; currentPage: number; filePath: string; pageCount: number;
}) {
  const key = `paper-pdf-bookmarks:v1:${filePath}`;
  const [outline, setOutline] = useState<PdfOutlineEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [bookmarks, setBookmarks] = useState(() => readBookmarks(key, pageCount));
  const [error, setError] = useState("");
  const expanded = pinned || hovered;

  useEffect(() => {
    let active = true;
    void runtime.getOutline().then((items) => {
      if (active) { setOutline(items); setLoaded(true); }
    }, () => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [runtime]);

  const entries: PdfOutlineEntry[] = outline.length ? outline : Array.from({ length: pageCount }, (_, index) => ({
    title: `第 ${index + 1} 页`, depth: 0, pageNumber: index + 1, destination: null,
  }));
  const activeIndex = entries.reduce((active, entry, index) => entry.pageNumber !== null && entry.pageNumber <= currentPage ? index : active, -1);
  const navigate = (entry: PdfOutlineEntry) => {
    setError("");
    if (entry.destination && entry.pageNumber !== null) {
      void runtime.goToDestination(entry.destination).catch(() => setError("无法跳转到此章节。"));
    } else if (entry.pageNumber !== null) runtime.setPage(entry.pageNumber);
  };
  const toggleBookmark = () => {
    const next = bookmarks.includes(currentPage) ? bookmarks.filter((page) => page !== currentPage) : [...bookmarks, currentPage].sort((a, b) => a - b);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setBookmarks(next);
      setError("");
    } catch { setError("书签未能保存，请检查本地存储空间。"); }
  };

  return <nav className={`pdf-outline${expanded ? " is-expanded" : ""}`} aria-label="PDF 目录与书签"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setHovered(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setHovered(false); }}
    onKeyDown={(event) => { if (event.key === "Escape") { setPinned(false); setHovered(false); (event.target as HTMLElement).blur(); } }}>
    <button type="button" className="pdf-outline__toggle" aria-label="固定 PDF 目录" aria-pressed={pinned} aria-expanded={expanded} onClick={() => setPinned(!pinned)} title="目录与书签">☰</button>
    <div className="pdf-outline__rail" aria-label="章节导航">
      {entries.map((entry, index) => <button key={index} type="button" className={`pdf-outline__tick${index === activeIndex ? " is-active" : ""}`}
        style={{ "--tick-width": `${Math.max(8, 22 - entry.depth * 5)}px` } as React.CSSProperties}
        aria-label={`跳转：${entry.title}`} aria-current={index === activeIndex ? "location" : undefined}
        disabled={entry.pageNumber === null} title={entry.title} onClick={() => navigate(entry)}><span /></button>)}
    </div>
    <div className="pdf-outline__panel" hidden={!expanded}>
      <div className="pdf-outline__heading"><strong>目录与书签</strong><button type="button" aria-pressed={bookmarks.includes(currentPage)} onClick={toggleBookmark}>{bookmarks.includes(currentPage) ? "移除本页书签" : "收藏本页"}</button></div>
      {!!bookmarks.length && <div className="pdf-outline__bookmarks" aria-label="已保存书签">{bookmarks.map((page) => <button key={page} type="button" onClick={() => runtime.setPage(page)}>★ 第 {page} 页</button>)}</div>}
      {!loaded && <p role="status">正在读取目录…</p>}
      {loaded && !outline.length && <p>此 PDF 没有内置目录，可按页跳转或收藏本页。</p>}
      {error && <p role="alert">{error}</p>}
      <ol>{entries.map((entry, index) => <li key={index} style={{ paddingLeft: `${Math.min(entry.depth, 5) * 12}px` }}>
        <button type="button" disabled={entry.pageNumber === null} aria-current={index === activeIndex ? "location" : undefined} onClick={() => navigate(entry)}><span>{entry.title}</span><small>{entry.pageNumber ?? ""}</small></button>
      </li>)}</ol>
    </div>
  </nav>;
}
