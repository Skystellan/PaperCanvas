import { LiveMarkdownEditor, type LiveMarkdownHandle } from "./LiveMarkdownEditor";
import { useImperativeHandle, useRef, useState, type Ref, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./markdown-note.css";

type Mode = "live" | "edit" | "read";
import { parseNoteCitation, type NoteCitation } from "./model/noteCitation";

interface Props {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  status: string;
  fileName?: string;
  editorRef?: Ref<HTMLTextAreaElement>;
  onCitation?: (citation: NoteCitation) => void;
  onReload?: () => void;
  onReveal?: () => Promise<void>;
}

export function MarkdownNoteEditor({ value, onChange, disabled, status, fileName, editorRef, onReload, onReveal, onCitation }: Props) {
  const [mode, setMode] = useState<Mode>("live");
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const liveEditor = useRef<LiveMarkdownHandle>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  useImperativeHandle(editorRef, () => input.current!);

  const insert = (before: string, after = "", placeholder = "text") => {
    if (mode === "live") { liveEditor.current?.format(before, after, placeholder); return; }
    const field = input.current;
    if (!field || disabled) return;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const selected = value.slice(start, end) || placeholder;
    onChange(value.slice(0, start) + before + selected + after + value.slice(end));
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.metaKey || event.ctrlKey) {
      if (event.key.toLowerCase() === "b") { event.preventDefault(); insert("**", "**"); }
      if (event.key.toLowerCase() === "i") { event.preventDefault(); insert("*", "*"); }
      if (event.key.toLowerCase() === "k") { event.preventDefault(); insert("[", "](https://)", "link"); }
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    const field = event.currentTarget;
    if (field.selectionStart !== field.selectionEnd) return;
    const cursor = field.selectionStart;
    const lineStart = value.lastIndexOf("\n", cursor - 1) + 1;
    const line = value.slice(lineStart, cursor);
    const match = /^(\s*)([-*+] |(\d+)\. |> )(\[[ xX]\] )?(.*)$/.exec(line);
    if (!match) return;
    event.preventDefault();
    const prefix = match[5].trim()
      ? `\n${match[1]}${match[3] ? `${Number(match[3]) + 1}. ` : match[2]}${match[4] ? "[ ] " : ""}`
      : "";
    const from = match[5].trim() ? cursor : lineStart;
    onChange(value.slice(0, from) + prefix + value.slice(cursor));
    requestAnimationFrame(() => field.setSelectionRange(from + prefix.length, from + prefix.length));
  };

  return (
    <div className="markdown-note">
      <div className="markdown-note__topbar">
        <details className="markdown-note__menu" open={viewMenuOpen} onKeyDown={(event) => { if (event.key === "Escape") { setViewMenuOpen(false); event.currentTarget.querySelector("summary")?.focus(); } }}>
          <summary onClick={(event) => { event.preventDefault(); setViewMenuOpen(!viewMenuOpen); }}>View</summary>
          {viewMenuOpen && <div aria-label="Note view" className="markdown-note__modes" role="group">
          {([["live", "Live preview"], ["edit", "Source"], ["read", "Read"]] as const).map(([key, label]) => (
            <button type="button" key={key} aria-pressed={mode === key} onClick={(event) => { setMode(key); setViewMenuOpen(false); event.currentTarget.closest("details")?.querySelector("summary")?.focus(); }}>{label}</button>
          ))}
        </div>}
        </details>
        {(onReload || onReveal) && <details className="markdown-note__menu" open={moreMenuOpen} onKeyDown={(event) => { if (event.key === "Escape") { setMoreMenuOpen(false); event.currentTarget.querySelector("summary")?.focus(); } }}>
          <summary onClick={(event) => { event.preventDefault(); setMoreMenuOpen(!moreMenuOpen); }}>More</summary>
          {moreMenuOpen && <div className="markdown-note__file-actions">
          {onReload && <button type="button" disabled={disabled} title="Reload changes made in another editor" onClick={() => {
            if (window.confirm("Reload the Markdown file? Any unsaved draft in this editor will be discarded. Copy it first if you need to keep it.")) onReload();
          }}>Reload</button>}
          {onReveal && <button type="button" disabled={disabled} title={fileName} onClick={() => {
            setFileError(null);
            void onReveal().catch(() => setFileError("Could not show the Markdown file. Please try again."));
          }}>Show .md</button>}
        </div>}
        </details>}
      </div>
      {fileError && <p role="alert">{fileError}</p>}
      {mode !== "read" && <div className="markdown-note__formatting" role="group" aria-label="Markdown formatting">
        {[
          ["Heading", "H", "## ", "", "Heading"],
          ["Bold (⌘/Ctrl+B)", "B", "**", "**", "text"],
          ["Italic (⌘/Ctrl+I)", "I", "*", "*", "text"],
          ["Link (⌘/Ctrl+K)", "↗", "[", "](https://)", "link"],
          ["Quote", "❝", "> ", "", "quote"],
          ["Task list", "☑", "- [ ] ", "", "task"],
          ["Code block", "</>", "\n```\n", "\n```\n", "code"],
        ].map(([label, icon, before, after, placeholder]) => <button type="button" key={label} aria-label={label} title={label} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => insert(before, after, placeholder)}>{icon}</button>)}
        <span>Markdown</span>
      </div>}
      <div className={`markdown-note__body markdown-note__body--${mode}`}>
        <LiveMarkdownEditor ref={liveEditor} value={value} onChange={onChange} disabled={disabled} visible={mode === "live"} onCitation={onCitation} />
        {mode === "edit" && <textarea
          aria-label="Paper notes"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={"# Reading notes\n\nCapture the key idea…\n\n- [ ] Questions to explore"}
          ref={input}
          value={value}
          spellCheck
        />}
        {mode === "read" && <article className="markdown-note__preview" aria-label="Markdown preview" tabIndex={0}>
          {value.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href, ...props }) => {
            const citation = parseNoteCitation(href ?? "");
            return <a {...props} href={href} target={citation ? undefined : "_blank"} rel="noreferrer" onClick={citation && onCitation ? (event) => { event.preventDefault(); onCitation(citation); } : undefined}>{children}</a>;
          } }}>{value}</ReactMarkdown> : <p className="markdown-note__empty">Your reading notes will appear here.</p>}
        </article>}
      </div>
      <footer className="markdown-note__footer">
        <span title={fileName}>{fileName ? "Linked Markdown file" : "Markdown"}</span>
        <span aria-live="polite">{status}</span>
        <span>{value.length.toLocaleString()} characters</span>
      </footer>
    </div>
  );
}
