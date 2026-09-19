import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReaderSidebar } from "./ReaderSidebar";
import type { PdfHighlight } from "./model/pdfHighlight";

const highlights: PdfHighlight[] = [
  {
    comment: "The main result",
    createdAt: 1,
    id: "h-1",
    pageNumber: 1,
    paperId: "paper-1",
    rects: [{ height: 0.03, left: 0.1, top: 0.2, width: 0.5 }],
    text: "Local state remains authoritative",
    updatedAt: 1,
  },
  {
    comment: "Compare with theorem two",
    createdAt: 2,
    id: "h-2",
    pageNumber: 7,
    paperId: "paper-1",
    rects: [{ height: 0.03, left: 0.1, top: 0.4, width: 0.5 }],
    text: "A separate consistency result",
    updatedAt: 2,
  },
];

function renderSidebar() {
  const onDeleteHighlight = vi.fn();
  const onSelectHighlight = vi.fn();
  render(
    <ReaderSidebar
      discussion={<div>Research discussion surface</div>}
      highlights={highlights}
      isNoteDisabled={false}
      noteDraft="Paper-level note"
      noteStatus="Saved locally"
      mindMap={<div>Argument tree canvas</div>}
      onDeleteHighlight={onDeleteHighlight}
      onNoteChange={vi.fn()}
      onSelectHighlight={onSelectHighlight}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  return { onDeleteHighlight, onSelectHighlight };
}

describe("ReaderSidebar", () => {
  it("keeps paper notes above a searchable highlight list with a live count", () => {
    renderSidebar();

    expect(screen.getByRole("textbox", { name: "Paper notes" })).toHaveValue(
      "Paper-level note",
    );
    expect(screen.getByText("Highlights")).toBeVisible();
    expect(screen.getByText("2", { selector: "span" })).toBeVisible();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search highlights" }), {
      target: { value: "theorem" },
    });

    expect(screen.getByText(/A separate consistency result/)).toBeVisible();
    expect(screen.queryByText(/Local state remains authoritative/)).toBeNull();
  });

  it("switches between Notes, Mind map, and AI chat while keeping highlights only in Notes", () => {
    renderSidebar();

    const notesTab = screen.getByRole("tab", { name: "Notes" });
    const mindMapTab = screen.getByRole("tab", { name: "Mind map" });
    const aiChatTab = screen.getByRole("tab", { name: "AI chat" });
    expect(notesTab).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(document.getElementById(notesTab.getAttribute("aria-controls")!)).not.toBeNull();
    expect(document.getElementById(mindMapTab.getAttribute("aria-controls")!)).not.toBeNull();
    expect(document.getElementById(aiChatTab.getAttribute("aria-controls")!)).not.toBeNull();
    expect(screen.queryByText("Argument tree canvas")).toBeNull();

    fireEvent.click(mindMapTab);

    expect(screen.getByRole("tab", { name: "Mind map" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Argument tree canvas")).toBeVisible();
    expect(screen.queryByText("Highlights")).not.toBeInTheDocument();

    fireEvent.click(aiChatTab);
    expect(screen.getByText("Research discussion surface")).toBeVisible();
    expect(screen.queryByText("Highlights")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByRole("textbox", { name: "Paper notes" })).toHaveValue(
      "Paper-level note",
    );
    expect(screen.getByText("Highlights")).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Search highlights" })).toBeVisible();
  });

  it("uses roving focus and arrow keys to navigate the workspace tabs", () => {
    renderSidebar();
    const notesTab = screen.getByRole("tab", { name: "Notes" });
    const mindMapTab = screen.getByRole("tab", { name: "Mind map" });
    const aiChatTab = screen.getByRole("tab", { name: "AI chat" });

    notesTab.focus();
    fireEvent.keyDown(notesTab, { key: "ArrowRight" });
    expect(mindMapTab).toHaveFocus();
    expect(mindMapTab).toHaveAttribute("aria-selected", "true");
    expect(notesTab).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(mindMapTab, { key: "ArrowRight" });
    expect(aiChatTab).toHaveFocus();
    expect(aiChatTab).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(aiChatTab, { key: "Home" });
    expect(notesTab).toHaveFocus();
    expect(notesTab).toHaveAttribute("aria-selected", "true");
  });

  it("selects and deletes highlights with separate controls", () => {
    const { onDeleteHighlight, onSelectHighlight } = renderSidebar();

    fireEvent.click(
      screen.getByRole("button", { name: "Go to highlight on page 1" }),
    );
    expect(onSelectHighlight).toHaveBeenCalledWith(highlights[0]);

    fireEvent.click(
      screen.getByRole("button", { name: "Delete highlight from page 1" }),
    );
    expect(onDeleteHighlight).toHaveBeenCalledWith(highlights[0]);
    expect(onSelectHighlight).toHaveBeenCalledTimes(1);
  });
});
