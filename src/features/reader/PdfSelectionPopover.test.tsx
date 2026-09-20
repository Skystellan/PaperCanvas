import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PdfSelectionPopover } from "./PdfSelectionPopover";
import { MAX_PDF_HIGHLIGHT_COMMENT_CHARACTERS } from "./model/pdfLimits";
const selection = { anchor: { x: 10, y: 20 }, pageNumber: 2, rects: [{ height: 0.04, left: 0.1, top: 0.2, width: 0.3 }], text: "A selected result" };

describe("PDF annotations", () => {
  it("caps comments, removes remote actions, and saves with the keyboard", async () => {
    const saveNote = vi.fn(), onClose = vi.fn();
    render(<PdfSelectionPopover actions={{ saveNote }} onClose={onClose} selection={selection} />);
    const field = screen.getByRole("textbox", { name: "Annotation about selection" });
    expect(field).toHaveAttribute("maxLength", String(MAX_PDF_HIGHLIGHT_COMMENT_CHARACTERS));
    expect(screen.queryByRole("button", { name: /Translate|Ask AI/ })).toBeNull();
    fireEvent.change(field, { target: { value: " My comment " } });
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(saveNote).toHaveBeenCalledWith({ comment: "My comment", selection });
  });
  it("adds selection and comment to notes and keeps failed saves retryable", async () => {
    const addToNotes = vi.fn().mockRejectedValueOnce(new Error("Disk full")).mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    render(<PdfSelectionPopover actions={{ addToNotes }} onClose={onClose} selection={selection} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to notes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk full");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add to notes" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(addToNotes).toHaveBeenLastCalledWith({ comment: "", selection });
  });
});
