import { useEffect, useRef, useState } from "react";
import type { PdfSelectionActions, PdfTextSelection } from "./model/pdfSelection";
import { MAX_PDF_HIGHLIGHT_COMMENT_CHARACTERS } from "./model/pdfLimits";

interface PdfSelectionPopoverProps {
  actions?: PdfSelectionActions;
  onClose(): void;
  selection: PdfTextSelection;
}

export function PdfSelectionPopover({ actions, onClose, selection }: PdfSelectionPopoverProps) {
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => { active.current = false; window.removeEventListener("keydown", onKeyDown); };
  }, [onClose]);

  const save = async (action: PdfSelectionActions["saveNote"]) => {
    if (!action || pending) return;
    setPending(true);
    setError(null);
    try {
      await action({ comment: comment.trim(), selection });
      if (active.current) onClose();
    } catch (cause) {
      if (active.current) setError(`${cause instanceof Error ? cause.message : "The annotation could not be saved."} Your selection is still here so you can retry.`);
    } finally {
      if (active.current) setPending(false);
    }
  };

  return (
    <section aria-label="PDF selection tools" className="pdf-selection-popover" role="dialog"
      style={{ left: selection.anchor.x, top: selection.anchor.y + 12 }}>
      <header className="pdf-selection-popover__header">
        <span>Annotation · p. {selection.pageNumber}</span>
        <button aria-label="Close selection tools" onClick={onClose} type="button">×</button>
      </header>
      <q className="pdf-selection-popover__quote">{selection.text}</q>
      <textarea aria-label="Annotation about selection" autoFocus
        maxLength={MAX_PDF_HIGHLIGHT_COMMENT_CHARACTERS}
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault(); void save(actions?.saveNote);
          }
        }}
        placeholder="Add a comment (optional)" value={comment} />
      {error && <p className="pdf-selection-popover__error" role="alert">{error}</p>}
      <footer className="pdf-selection-popover__footer">
        <span className="pdf-selection-popover__privacy">Saved locally</span>
        {actions?.addToNotes && <button type="button" disabled={pending} onClick={() => void save(actions.addToNotes)}>Add to notes</button>}
        <button className="pdf-selection-popover__save" disabled={!actions?.saveNote || pending}
          onClick={() => void save(actions?.saveNote)} type="button">{pending ? "Saving…" : "Save annotation"}</button>
      </footer>
    </section>
  );
}
