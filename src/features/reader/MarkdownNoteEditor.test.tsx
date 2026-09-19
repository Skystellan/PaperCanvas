import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownNoteEditor } from "./MarkdownNoteEditor";

function Editor({ initial = "# Findings\n\n**Strong result**\n\n- [x] Read paper\n\n| A | B |\n| - | - |\n| 1 | 2 |" }) {
  const [value, setValue] = useState(initial);
  return <MarkdownNoteEditor value={value} onChange={setValue} disabled={false} status="Saved locally" />;
}

describe("MarkdownNoteEditor", () => {
  it("previews headings, tasks and tables while preserving the editable draft", () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(screen.getByRole("heading", { name: "Findings" })).toBeVisible();
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("table")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "## Changed live" } });
    expect(screen.getByRole("heading", { name: "Changed live" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByRole("textbox")).toHaveValue("## Changed live");
  });

  it("formats a selection with a keyboard shortcut and continues task lists", async () => {
    const { unmount } = render(<Editor initial="result" />);
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    input.setSelectionRange(0, 6);
    fireEvent.keyDown(input, { key: "b", metaKey: true });
    expect(input).toHaveValue("**result**");
    await waitFor(() => expect(input.selectionStart).toBe(2));
    unmount();
    render(<Editor initial="- [x] Read" />);
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    const tasks = screen.getByRole("textbox") as HTMLTextAreaElement;
    tasks.setSelectionRange(10, 10);
    fireEvent.keyDown(tasks, { key: "Enter" });
    expect(tasks).toHaveValue("- [x] Read\n- [ ] ");
  });

  it("does not execute raw HTML or javascript links", () => {
    render(<Editor initial={'<img src=x onerror="alert(1)">\n\n[bad](javascript:alert%281%29)'} />);
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    const preview = screen.getByRole("article");
    expect(preview.querySelector("img")).toBeNull();
    expect(preview.querySelector("a")).not.toHaveAttribute("href", expect.stringContaining("javascript:"));
  });

  it("requires an explicit discard decision before reloading", () => {
    const onReload = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<MarkdownNoteEditor value="draft" onChange={vi.fn()} disabled={false} status="Not saved" onReload={onReload} />);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });
});
