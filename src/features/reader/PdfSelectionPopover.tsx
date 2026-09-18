import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PdfSelectionActionResult,
  PdfSelectionActions,
  PdfTextSelection,
} from "./model/pdfSelection";
import {
  MAX_PDF_HIGHLIGHT_COMMENT_CHARACTERS,
  MAX_PDF_SELECTION_QUESTION_CHARACTERS,
} from "./model/pdfLimits";

type SelectionMode = "note" | "translate" | "ask";

interface PdfSelectionPopoverProps {
  actions?: PdfSelectionActions;
  onClose(): void;
  selection: PdfTextSelection;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "The action could not be completed.";
}

export function PdfSelectionPopover({
  actions,
  onClose,
  selection,
}: PdfSelectionPopoverProps) {
  const [mode, setMode] = useState<SelectionMode>("note");
  const [comment, setComment] = useState("");
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeActionRef = useRef<AbortController | null>(null);

  const close = useCallback(() => {
    activeActionRef.current?.abort();
    activeActionRef.current = null;
    onClose();
  }, [onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      activeActionRef.current?.abort();
      activeActionRef.current = null;
    };
  }, [close]);

  const selectMode = (nextMode: SelectionMode) => {
    activeActionRef.current?.abort();
    activeActionRef.current = null;
    setMode(nextMode);
    setError(null);
    setResult("");
  };

  const run = async (
    action: (
      signal: AbortSignal,
    ) => Promise<PdfSelectionActionResult> | PdfSelectionActionResult,
    options: { closeOnSuccess?: boolean } = {},
  ) => {
    activeActionRef.current?.abort();
    const controller = new AbortController();
    activeActionRef.current = controller;
    setPending(true);
    setError(null);
    try {
      const nextResult = await action(controller.signal);
      if (controller.signal.aborted) return;
      if (typeof nextResult === "string") setResult(nextResult);
      if (options.closeOnSuccess) close();
    } catch (actionError) {
      if (controller.signal.aborted) return;
      setError(
        `${errorMessage(actionError)} Your selection is still here so you can retry.`,
      );
    } finally {
      if (activeActionRef.current === controller) {
        activeActionRef.current = null;
        setPending(false);
      }
    }
  };

  const saveNote = () => {
    if (!actions?.saveNote) return;
    void run(
      () => actions.saveNote?.({ comment: comment.trim(), selection }),
      { closeOnSuccess: true },
    );
  };

  const translate = () => {
    if (!actions?.translate) return;
    void run((signal) => actions.translate?.(selection, signal));
  };

  const ask = () => {
    if (!actions?.askAi || !question.trim()) return;
    void run((signal) =>
      actions.askAi?.({ question: question.trim(), selection, signal }),
    );
  };

  const onTextAreaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (mode === "note") saveNote();
      if (mode === "ask") ask();
    }
  };

  return (
    <section
      aria-label="PDF selection tools"
      className="pdf-selection-popover"
      role="dialog"
      style={{ left: selection.anchor.x, top: selection.anchor.y + 12 }}
    >
      <header className="pdf-selection-popover__header">
        <span>Selection · p. {selection.pageNumber}</span>
        <button aria-label="Close selection tools" onClick={close} type="button">
          ×
        </button>
      </header>

      <q className="pdf-selection-popover__quote">{selection.text}</q>

      <div aria-label="Selection action" className="pdf-selection-popover__actions">
        <button
          aria-pressed={mode === "note"}
          className={mode === "note" ? "is-active" : undefined}
          disabled={!actions?.saveNote || pending}
          onClick={() => selectMode("note")}
          type="button"
        >
          Note
        </button>
        <button
          aria-label={actions?.translate ? "Translate" : "Translate (coming soon)"}
          aria-pressed={mode === "translate"}
          className={mode === "translate" ? "is-active" : undefined}
          disabled={!actions?.translate || pending}
          onClick={() => selectMode("translate")}
          type="button"
        >
          Translate
        </button>
        <button
          aria-label={actions?.askAi ? "Ask AI" : "Ask AI (coming soon)"}
          aria-pressed={mode === "ask"}
          className={mode === "ask" ? "is-active" : undefined}
          disabled={!actions?.askAi || pending}
          onClick={() => selectMode("ask")}
          type="button"
        >
          Ask AI
        </button>
      </div>

      {mode === "note" ? (
        <textarea
          aria-label="Note about selection"
          autoFocus
          maxLength={MAX_PDF_HIGHLIGHT_COMMENT_CHARACTERS}
          onChange={(event) => setComment(event.target.value)}
          onKeyDown={onTextAreaKeyDown}
          placeholder="Why does this passage matter?"
          value={comment}
        />
      ) : null}

      {mode === "translate" ? (
        <p className="pdf-selection-popover__hint">
          Translate this passage into Simplified Chinese with terminology intact.
        </p>
      ) : null}

      {mode === "ask" ? (
        <textarea
          aria-label="Question about selection"
          autoFocus
          maxLength={MAX_PDF_SELECTION_QUESTION_CHARACTERS}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={onTextAreaKeyDown}
          placeholder="Ask a question about this passage…"
          value={question}
        />
      ) : null}

      {result ? (
        <div aria-live="polite" className="pdf-selection-popover__response">
          {result}
        </div>
      ) : null}
      {error ? (
        <p className="pdf-selection-popover__error" role="alert">
          {error}
        </p>
      ) : null}

      <footer className="pdf-selection-popover__footer">
        <span className="pdf-selection-popover__privacy">
          {mode === "note" ? "Saved locally" : "Sent to Codex via ChatGPT"}
        </span>
        {mode === "note" ? (
          <button
            className="pdf-selection-popover__save"
            disabled={!actions?.saveNote || pending}
            onClick={saveNote}
            type="button"
          >
            {pending ? "Saving…" : "Save note"}
          </button>
        ) : null}
        {mode === "translate" ? (
          <button
            className="pdf-selection-popover__save"
            disabled={!actions?.translate || pending}
            onClick={translate}
            type="button"
          >
            {pending ? "Translating…" : "Translate selection"}
          </button>
        ) : null}
        {mode === "ask" ? (
          <button
            className="pdf-selection-popover__save"
            disabled={!actions?.askAi || !question.trim() || pending}
            onClick={ask}
            type="button"
          >
            {pending ? "Asking…" : "Ask Codex"}
          </button>
        ) : null}
      </footer>
    </section>
  );
}
