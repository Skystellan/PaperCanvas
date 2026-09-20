import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownNoteEditor } from "./MarkdownNoteEditor";

function Editor({ initial = "# Findings\n\n**Strong result**\n\n- [x] Read paper\n\n| A | B |\n| - | - |\n| 1 | 2 |" }) {
  const [value, setValue] = useState(initial);
  return <MarkdownNoteEditor value={value} onChange={setValue} disabled={false} status="Saved locally" />;
}

describe("MarkdownNoteEditor", () => {
  it("starts in live preview and switches source/read through View without Split", async () => {
    render(<Editor />);
    expect(await screen.findByRole("heading", { name: "Findings" })).toBeVisible();
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
    fireEvent.click(screen.getByText("View", { selector: "summary" }));
    expect(screen.queryByRole("button", { name: "Split" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "## Changed live" } });
    fireEvent.click(screen.getByText("View", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    expect(screen.getByRole("heading", { name: "Changed live" })).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByText("View", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByRole("textbox")).toHaveValue("## Changed live");
  });

  it("formats a selection with a keyboard shortcut and continues task lists", async () => {
    const { unmount } = render(<Editor initial="result" />);
    fireEvent.click(screen.getByText("View", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    input.setSelectionRange(0, 6);
    fireEvent.keyDown(input, { key: "b", metaKey: true });
    expect(input).toHaveValue("**result**");
    await waitFor(() => expect(input.selectionStart).toBe(2));
    unmount();
    render(<Editor initial="- [x] Read" />);
    fireEvent.click(screen.getByText("View", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    const tasks = screen.getByRole("textbox") as HTMLTextAreaElement;
    tasks.setSelectionRange(10, 10);
    fireEvent.keyDown(tasks, { key: "Enter" });
    expect(tasks).toHaveValue("- [x] Read\n- [ ] ");
  });

  it("does not execute raw HTML or javascript links", () => {
    render(<Editor initial={'<img src=x onerror="alert(1)">\n\n[bad](javascript:alert%281%29)'} />);
    fireEvent.click(screen.getByText("View", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    const preview = screen.getByRole("article");
    expect(preview.querySelector("img")).toBeNull();
    expect(preview.querySelector("a")).not.toHaveAttribute("href", expect.stringContaining("javascript:"));
  });

  it("requires an explicit discard decision before reloading", () => {
    const onReload = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<MarkdownNoteEditor value="draft" onChange={vi.fn()} disabled={false} status="Not saved" onReload={onReload} />);
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    fireEvent.click(screen.getByText("More", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });
});

it("opens highlight citations from both live and read views without editing the source", async () => {
  const onCitation = vi.fn(), onChange = vi.fn();
  render(<MarkdownNoteEditor value={'[Paper · p. 7](#paper=paper-1&page=7&highlight=h-2)'} onChange={onChange} disabled={false} status="Saved" onCitation={onCitation} />);
  const citation = await screen.findByRole("link", { name: "Paper · p. 7" });
  fireEvent.mouseDown(citation, { button: 0 });
  fireEvent.click(citation);
  expect(onCitation).toHaveBeenCalledWith({ paperId: "paper-1", pageNumber: 7, highlightId: "h-2" });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("View", { selector: "summary" }));
  fireEvent.click(screen.getByRole("button", { name: "Read" }));
  fireEvent.click(screen.getByRole("link", { name: "Paper · p. 7" }));
  expect(onCitation).toHaveBeenCalledTimes(2);
});
