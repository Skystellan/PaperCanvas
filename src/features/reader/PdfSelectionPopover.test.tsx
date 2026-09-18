import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PdfSelectionPopover } from "./PdfSelectionPopover";
import {
  MAX_PDF_HIGHLIGHT_COMMENT_CHARACTERS,
  MAX_PDF_SELECTION_QUESTION_CHARACTERS,
} from "./model/pdfLimits";

const selection = {
  anchor: { x: 10, y: 20 },
  pageNumber: 2,
  rects: [{ height: 0.04, left: 0.1, top: 0.2, width: 0.3 }],
  text: "A selected result",
};

describe("PdfSelectionPopover cancellation", () => {
  it("caps persisted comments and AI questions at the input boundary", () => {
    render(
      <PdfSelectionPopover
        actions={{ askAi: vi.fn(), saveNote: vi.fn() }}
        onClose={vi.fn()}
        selection={selection}
      />,
    );

    expect(
      screen.getByRole("textbox", { name: "Note about selection" }),
    ).toHaveAttribute(
      "maxLength",
      String(MAX_PDF_HIGHLIGHT_COMMENT_CHARACTERS),
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    expect(
      screen.getByRole("textbox", { name: "Question about selection" }),
    ).toHaveAttribute(
      "maxLength",
      String(MAX_PDF_SELECTION_QUESTION_CHARACTERS),
    );
  });

  it("aborts an in-flight Codex selection action when the card closes", async () => {
    const translate = vi.fn(
      async (_selection, signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Stopped", "AbortError")),
            { once: true },
          );
        }),
    );
    const onClose = vi.fn();
    render(
      <PdfSelectionPopover
        actions={{ translate }}
        onClose={onClose}
        selection={selection}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Translate" }));
    fireEvent.click(screen.getByRole("button", { name: "Translate selection" }));
    await waitFor(() => expect(translate).toHaveBeenCalledOnce());
    const signal = translate.mock.calls[0][1];
    expect(signal.aborted).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Close selection tools" }));

    expect(signal.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
