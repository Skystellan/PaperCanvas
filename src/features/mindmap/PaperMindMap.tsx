import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { usePersistenceCoordinator, usePersistenceWriter } from "../persistence";
import type { MindMapRepository } from "./data/mindMapRepository";
import { sqliteMindMapRepository } from "./data/sqliteMindMapRepository";
import { renderMarkmap, type MindMapNode } from "./model/markmap";
import "./mindmap.css";

const MarkmapPreview = lazy(() => import("./MarkmapPreview"));

export interface PaperMindMapProps {
  paperId: string;
  repository?: MindMapRepository;
}

function MindMapEditor({ paperId, repository }: Required<PaperMindMapProps>) {
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [source, setSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [preview, setPreview] = useState<{ root: MindMapNode; source: string } | null>(null);
  const [sourceOpen, setSourceOpen] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [saving, setSaving] = useState(false);
  const sourceRef = useRef("");
  const savedSourceRef = useRef("");
  const saveOperation = useRef<Promise<void> | null>(null);
  const renderSequence = useRef(0);
  const mounted = useRef(false);
  const { trackOperation } = usePersistenceCoordinator();

  const updatePreview = useCallback(async (text: string) => {
    const request = ++renderSequence.current;
    setRendering(true);
    setPreviewError(null);
    try {
      const root = await renderMarkmap(text);
      if (!mounted.current || request !== renderSequence.current) return;
      setPreview({ root, source: text });
      setSourceOpen(false);
    } catch (error) {
      if (!mounted.current || request !== renderSequence.current) return;
      setPreviewError(error instanceof Error ? error.message : "Could not render this diagram source.");
    } finally {
      if (mounted.current && request === renderSequence.current) setRendering(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      renderSequence.current += 1;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void repository.load(paperId).then((stored) => {
      if (!active) return;
      const text = stored ?? "";
      sourceRef.current = text;
      savedSourceRef.current = text;
      setSource(text);
      setSavedSource(text);
      setLoadState("ready");
      if (text.trim()) void updatePreview(text);
    }).catch(() => {
      if (active) setLoadState("error");
    });
    return () => { active = false; };
  }, [loadAttempt, paperId, repository, updatePreview]);

  const flush = useCallback((): Promise<void> => {
    if (saveOperation.current) return saveOperation.current;
    if (sourceRef.current === savedSourceRef.current) return Promise.resolve();
    setSaving(true);
    setSaveError(false);
    const operation = Promise.resolve().then(async () => {
      try {
        // Edits made during a write must become durable before navigation resolves.
        while (sourceRef.current !== savedSourceRef.current) {
          const snapshot = sourceRef.current;
          await repository.save(paperId, snapshot);
          savedSourceRef.current = snapshot;
          if (mounted.current) setSavedSource(snapshot);
        }
      } catch (error) {
        if (mounted.current) {
          setSaveError(true);
          setSourceOpen(true);
        }
        throw error;
      } finally {
        saveOperation.current = null;
        if (mounted.current) setSaving(false);
      }
    });
    saveOperation.current = operation;
    return trackOperation(operation);
  }, [paperId, repository, trackOperation]);

  usePersistenceWriter(`mind-map:${paperId}`, {
    isDirty: () => saveOperation.current !== null || sourceRef.current !== savedSourceRef.current,
    flush,
  });

  if (loadState !== "ready") {
    return (
      <section className="paper-mind-map paper-mind-map--message" aria-label="Paper mind map">
        {loadState === "loading" ? <p role="status">Opening mind map…</p> : <>
          <p role="alert">Could not load this mind map from local storage. Your saved source was kept.</p>
          <button type="button" onClick={() => {
            setLoadState("loading");
            setLoadAttempt((attempt) => attempt + 1);
          }}>Retry loading</button>
        </>}
      </section>
    );
  }

  const dirty = source !== savedSource;
  return (
    <section className="paper-mind-map" aria-label="Paper mind map">
      <div className="paper-mind-map__source-bar">
        <span>Markdown outline</span>
        <button type="button" aria-expanded={sourceOpen} onClick={() => setSourceOpen(!sourceOpen)}>
          {sourceOpen ? "Hide source" : "Edit source"}
        </button>
      </div>
      <div className="paper-mind-map__composer" hidden={!sourceOpen}>
        <p className="paper-mind-map__hint">
          Ask your AI chat for a Markdown outline, then paste it here. Your source and mind map stay on this device.
        </p>
        <label>
          <span>Markdown source</span>
          <textarea
            aria-label="Markdown source"
            spellCheck={false}
            placeholder={'# Paper\n## Question\n- Research gap\n## Method\n- Key assumptions\n## Findings\n- Evidence'}
            rows={6}
            value={source}
            onChange={(event) => {
              sourceRef.current = event.target.value;
              setSource(event.target.value);
              renderSequence.current += 1;
              setRendering(false);
              setPreviewError(null);
            }}
          />
        </label>
        <p className="paper-mind-map__hint">
          Markdown uses a compact left-to-right tree with wrapped labels. Code fences are accepted; unfinished drafts are saved when you leave.
        </p>
        <div className="paper-mind-map__actions">
          <span role="status">{saving ? "Saving source…" : dirty ? "Unsaved source" : "Source saved locally"}</span>
          <button type="button" disabled={!source.trim() || rendering}
            onClick={() => void updatePreview(sourceRef.current)}>
            {rendering ? "Rendering…" : "Render preview"}
          </button>
          <button type="button" disabled={!dirty || saving}
            onClick={() => void flush().catch(() => undefined)}>
            {saveError ? "Retry saving" : "Save source"}
          </button>
        </div>
      </div>
      {saveError && <p className="paper-mind-map__error" role="alert">
        Could not save this source. Your edits are still here. Retry saving before leaving.
      </p>}
      {previewError && <div className="paper-mind-map__error" role="alert">
        <strong>Preview failed. {preview ? "The last valid diagram is still shown." : "Your source is kept."}</strong>
        <pre>{previewError}</pre>
      </div>}
      <div className="paper-mind-map__preview-toolbar">
        <span>{preview && preview.source !== source ? "Preview shows the last rendered source" : "Preview"}</span>
      </div>
      <div className="paper-mind-map__preview" role="region" aria-label="Mind map preview" tabIndex={0}>
        {preview ? <Suspense fallback={<p role="status">Opening interactive map…</p>}>
          <MarkmapPreview root={preview.root} />
        </Suspense> : <p className="paper-mind-map__empty">
          Paste a Markdown outline and choose Render preview.
        </p>}
      </div>
    </section>
  );
}

export function PaperMindMap({ paperId, repository = sqliteMindMapRepository }: PaperMindMapProps) {
  return <MindMapEditor key={paperId} paperId={paperId} repository={repository} />;
}
