import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../../platform/core";
import type { Paper } from "../library/model/paper";
import { usePersistenceCoordinator, usePersistenceWriter } from "../persistence";
import { PdfViewer, type PdfViewerProps } from "../reader/PdfViewer";
import { loadReaderState } from "../reader/model/readerState";
import { ResearchPaperDetails } from "./ResearchPaperDetails";
import "./research.css";

interface OnlineDocument {
  requestId: string;
  bytes: Uint8Array;
  sourceUrl: string;
  documentKey: string;
}

export function ResearchPdfReader({ paper, onPaperUpdated, viewerProps }: {
  paper: Paper;
  onPaperUpdated?: (paper: Paper) => void;
  viewerProps: Omit<PdfViewerProps, "filePath" | "memoryDocument">;
}) {
  const { flushPending, trackOperation } = usePersistenceCoordinator();
  // Saving an online document must not reload the PDF or reset its current page.
  const [initialFilePath] = useState(paper.filePath);
  const online = !initialFilePath && !!paper.research?.arxivId && !!window.paperCanvas;
  const [showDetails, setShowDetails] = useState(!initialFilePath && !online);
  const [restoreLocation, setRestoreLocation] = useState(viewerProps.initialLocation);
  const [attempt, setAttempt] = useState(0);
  const [document, setDocument] = useState<OnlineDocument | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(!!paper.filePath);
  const savingOperation = useRef<Promise<Paper> | null>(null);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  usePersistenceWriter(`research-offline:${paper.id}`, useMemo(() => ({
    isDirty: () => savingOperation.current !== null,
    flush: async () => { await savingOperation.current; },
  }), []));

  useEffect(() => {
    if (!online) return;
    let active = true;
    const requestId = crypto.randomUUID();
    void invoke<OnlineDocument>("open_online_pdf", { paperId: paper.id, requestId }).then(
      loaded => { if (active) setDocument(loaded); },
      error => { if (active) setLoadError(String(error)); },
    );
    return () => {
      active = false;
      void invoke("release_online_pdf", { requestId }).catch(() => {});
    };
  }, [online, paper.id, attempt]);

  const memoryDocument = useMemo(() => document ? {
    // This is the existing bookmark identity used after an explicit offline save.
    // Passing data separately does not claim that the file already exists.
    key: `papers/${paper.id}.pdf`, data: document.bytes,
  } : undefined, [document, paper.id]);

  const saveOffline = () => {
    if (!document || saved || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    void trackOperation((async () => {
      await flushPending();
      if (!mounted.current) return;
      const operation = invoke<Paper>("save_online_pdf", { requestId: document.requestId });
      savingOperation.current = operation;
      const updated = await operation;
      if (mounted.current) {
        setSaved(true);
        onPaperUpdated?.(updated);
      }
    })()).catch(error => {
      if (mounted.current) setSaveError(String(error));
    }).finally(() => {
      savingOperation.current = null;
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    });
  };

  return <section className="research-pdf" aria-label="论文文档">
    <div className="research-pdf__toolbar">
      <div role="group" aria-label="论文查看方式">
        {(online || initialFilePath) && <button type="button" aria-pressed={!showDetails} onClick={() => {
          if (showDetails) setRestoreLocation(loadReaderState(paper.id).location);
          setShowDetails(false);
        }}>PDF</button>}
        <button type="button" aria-pressed={showDetails} onClick={() => setShowDetails(true)}>初筛信息</button>
      </div>
      <span>{saved ? "已保存离线" : online ? "在线阅读 · 未保存离线" : "暂无可在线阅读的 PDF"}</span>
      {online && !saved && <button type="button" disabled={!document || saving} onClick={saveOffline}>{saving ? "正在保存…" : "保存离线"}</button>}
    </div>
    {saveError && <p className="research-pdf__error" role="alert">保存离线失败：{saveError}。可重试保存，在线文档仍可阅读。</p>}
    {showDetails ? <ResearchPaperDetails paper={paper} /> : (initialFilePath || memoryDocument) ?
      <PdfViewer {...viewerProps} initialLocation={restoreLocation} filePath={initialFilePath} memoryDocument={memoryDocument} /> :
      <div className="research-pdf__loading">
        {loadError ? <>
          <p role="alert">在线 PDF 未能载入：{loadError}</p>
          <button type="button" onClick={() => { setLoadError(""); setDocument(null); setAttempt(value => value + 1); }}>重试在线阅读</button>
          <button type="button" onClick={() => setShowDetails(true)}>查看论文来源与初筛信息</button>
        </> : <p role="status">正在载入 arXiv PDF…</p>}
      </div>}
  </section>;
}
