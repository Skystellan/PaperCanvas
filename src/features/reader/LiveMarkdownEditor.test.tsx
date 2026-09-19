import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { describe, expect, it, vi } from "vitest";
import { MarkdownNoteEditor } from "./MarkdownNoteEditor";

function Editor() {
  const [value, setValue] = useState("# Title\n\nA **bold** paragraph.\n\n- [ ] Read\n\n| A | B |\n| - | - |\n| 1 | 2 |");
  return <MarkdownNoteEditor value={value} onChange={setValue} disabled={false} status="Saved locally" />;
}

describe("inline Markdown", () => {
  it("renders in the editable surface, reveals the clicked block and re-renders after leaving it", async () => {
    render(<Editor />);
    const heading = await screen.findByRole("heading", { name: "Title" });
    expect(screen.getByRole("button", { name: "Live preview" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("article", { name: "Markdown preview" })).toBeNull();
    fireEvent.mouseDown(heading, { button: 0 });
    const field = screen.getByRole("textbox", { name: "Paper notes" });
    expect(field).toHaveFocus();
    expect(screen.queryByRole("heading", { name: "Title" })).toBeNull();
    expect(field.querySelector(".cm-line")).toHaveTextContent("# Title");
    expect(screen.getByText("bold", { selector: "strong" })).toBeVisible();
    const view = EditorView.findFromDOM(field)!;
    act(() => view.dispatch({ changes: { from: 2, to: 7, insert: "中文标题" }, selection: { anchor: 6 } }));
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect((screen.getByRole("textbox", { name: "Paper notes" }) as HTMLTextAreaElement).value).toContain("# 中文标题");
    fireEvent.click(screen.getByRole("button", { name: "Live preview" }));
    act(() => field.blur());
    expect(await screen.findByRole("heading", { name: "中文标题" })).toBeVisible();
  });

  it("keeps formatting in native editor undo/redo history", async () => {
    render(<Editor />);
    fireEvent.mouseDown(await screen.findByRole("heading", { name: "Title" }), { button: 0 });
    const view = EditorView.findFromDOM(screen.getByRole("textbox", { name: "Paper notes" }))!;
    act(() => view.dispatch({ selection: { anchor: 2, head: 7 } }));
    fireEvent.click(screen.getByRole("button", { name: "Bold (⌘/Ctrl+B)" }));
    expect(view.state.doc.toString()).toContain("# **Title**");
    act(() => { undo(view); });
    expect(view.state.doc.toString()).toContain("# Title\n");
    act(() => { redo(view); });
    expect(view.state.doc.toString()).toContain("# **Title**");
    act(() => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }));
    expect(screen.queryByRole("table")).toBeNull();
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toContain("| A | B |");
  });

  it("does not replace an active source block during a composition update", async () => {
    render(<Editor />);
    fireEvent.mouseDown(await screen.findByRole("heading", { name: "Title" }), { button: 0 });
    const field = screen.getByRole("textbox", { name: "Paper notes" });
    const view = EditorView.findFromDOM(field)!;
    fireEvent.compositionStart(field);
    act(() => view.dispatch({ changes: { from: 2, to: 7, insert: "输入中" }, selection: { anchor: 5 } }));
    expect(field.querySelector(".cm-line")).toHaveTextContent("# 输入中");
    expect(screen.queryByRole("heading", { name: "输入中" })).toBeNull();
    fireEvent.compositionEnd(field);
    act(() => field.blur());
    await waitFor(() => expect(screen.getByRole("heading", { name: "输入中" })).toBeVisible());
  });

  it("renders external changes and prevents edits while disabled", async () => {
    const onChange = vi.fn();
    const props = { onChange, disabled: true, status: "Loading…" };
    const { rerender } = render(<MarkdownNoteEditor {...props} value="# Old" />);
    const heading = await screen.findByRole("heading", { name: "Old" });
    fireEvent.mouseDown(heading, { button: 0 });
    expect(heading).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
    rerender(<MarkdownNoteEditor {...props} value="# External edit" />);
    expect(await screen.findByRole("heading", { name: "External edit" })).toBeVisible();
  });
});
