import { parseNoteCitation, type NoteCitation } from "./model/noteCitation";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, placeholder, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";

const focusNote = StateEffect.define<boolean>();
const widgetRoots = new WeakMap<HTMLElement, Root>();

function RenderedBlock({ source, view }: { source: string; view: EditorView }) {
  useLayoutEffect(() => { view.requestMeasure(); }, [source, view]);
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href, ...props }) =>
    <a {...props} href={href} target={parseNoteCitation(href ?? "") ? undefined : "_blank"} rel="noreferrer">{children}</a>,
  }}>{source}</ReactMarkdown>;
}

class MarkdownBlock extends WidgetType {
  constructor(readonly source: string, readonly from: number) { super(); }
  eq(other: MarkdownBlock) { return this.source === other.source && this.from === other.from; }
  toDOM(view: EditorView) {
    const dom = document.createElement("div");
    dom.className = "markdown-note__preview markdown-note__inline-block";
    dom.title = "Click to edit Markdown";
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || view.state.readOnly || (event.target as Element).closest("a")) return;
      event.preventDefault();
      // A widget is a view of the source, never a second editable document.
      view.focus();
      view.dispatch({
        selection: { anchor: event.shiftKey ? view.state.selection.main.anchor : this.from, head: this.from },
        effects: focusNote.of(true),
        scrollIntoView: true,
      });
    });

    const root = createRoot(dom);
    widgetRoots.set(dom, root);
    root.render(<RenderedBlock source={this.source} view={view} />);
    return dom;
  }
  destroy(dom: HTMLElement) {
    const root = widgetRoots.get(dom);
    // The containing React component may itself be unmounting.
    queueMicrotask(() => root?.unmount());
    widgetRoots.delete(dom);
  }
}

const liveMarkdown = StateField.define<{ focused: boolean; decorations: DecorationSet }>({
  create(state) { return { focused: false, decorations: renderBlocks(state, false) }; },
  update(value, transaction) {
    const focus = transaction.effects.find((effect) => effect.is(focusNote));
    const focused = focus ? focus.value : value.focused;
    if (transaction.docChanged || transaction.selection || focus || syntaxTree(transaction.startState) !== syntaxTree(transaction.state)) {
      return { focused, decorations: renderBlocks(transaction.state, focused) };
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

function renderBlocks(state: EditorState, focused: boolean): DecorationSet {
  const blocks = [];
  const definitions = [];
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    blocks.push(node);
    if (node.name === "LinkReference") definitions.push(state.sliceDoc(node.from, node.to));
  }
  const context = definitions.length ? `\n\n${definitions.join("\n")}` : "";
  return Decoration.set(blocks.flatMap((node) => {
    // Keep every selected block as source, including multiline selections.
    if (focused && state.selection.ranges.some((range) => range.from <= node.to && range.to >= node.from)) return [];
    return [Decoration.replace({
      block: true,
      widget: new MarkdownBlock(state.sliceDoc(node.from, node.to) + context, node.from),
    }).range(node.from, node.to)];
  }));
}

function formatMarkdown(view: EditorView, before: string, after = "", placeholderText = "text") {
  if (view.state.readOnly) return false;
  view.dispatch({ ...view.state.changeByRange((range) => {
    const from = ["## ", "> ", "- [ ] "].includes(before) ? view.state.doc.lineAt(range.from).from : range.from;
    const selected = view.state.sliceDoc(from, range.to) || placeholderText;
    return {
      changes: { from, to: range.to, insert: before + selected + after },
      range: EditorSelection.range(from + before.length, from + before.length + selected.length),
    };
  }), annotations: Transaction.userEvent.of("input"), scrollIntoView: true });
  return true;
}

export interface LiveMarkdownHandle {
  format: (before: string, after?: string, placeholder?: string) => void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  visible: boolean;
  onCitation?: (citation: NoteCitation) => void;
  ref?: Ref<LiveMarkdownHandle>;
}

export function LiveMarkdownEditor({ value, onChange, disabled, visible, ref, onCitation }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latest = useRef({ value, onChange, disabled });
  const permissions = useRef(new Compartment());
  useLayoutEffect(() => { latest.current = { value, onChange, disabled }; }, [value, onChange, disabled]);
  useImperativeHandle(ref, () => ({
    format(before, after, text) {
      const view = editor.current;
      if (view) { formatMarkdown(view, before, after, text); view.focus(); }
    },
  }));

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          markdown({ base: markdownLanguage, completeHTMLTags: false }),
          history(),
          keymap.of([
            { key: "Mod-b", run: (view) => formatMarkdown(view, "**", "**") },
            { key: "Mod-i", run: (view) => formatMarkdown(view, "*", "*") },
            { key: "Mod-k", run: (view) => formatMarkdown(view, "[", "](https://)", "link") },
            ...defaultKeymap, ...historyKeymap,
          ]),
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.lineWrapping,
          placeholder("Start writing Markdown… Click any rendered paragraph to edit it."),
          EditorView.contentAttributes.of({ "aria-label": "Paper notes", "aria-multiline": "true", spellcheck: "true" }),
          permissions.current.of([EditorState.readOnly.of(latest.current.disabled), EditorView.editable.of(!latest.current.disabled)]),
          liveMarkdown,
          EditorView.focusChangeEffect.of((_state, focused) => focusNote.of(focused)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, []);

  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: Transaction.addToHistory.of(false) });
    }
  }, [value]);
  useEffect(() => {
    editor.current?.dispatch({ effects: permissions.current.reconfigure([
      EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled),
    ]) });
  }, [disabled]);
  useEffect(() => { if (visible) editor.current?.requestMeasure(); }, [visible]);

  return <div className="markdown-note__live" ref={host} hidden={!visible} onClick={(event) => {
    const link = (event.target as Element).closest("a");
    const citation = parseNoteCitation(link?.getAttribute("href") ?? "");
    if (citation && onCitation) { event.preventDefault(); onCitation(citation); }
  }} />;
}
