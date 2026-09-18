import type { NormalizedPdfRect } from "./pdfHighlight";

export interface PdfSelectionAnchor {
  x: number;
  y: number;
}

export interface PdfTextSelection {
  anchor: PdfSelectionAnchor;
  pageNumber: number;
  rects: NormalizedPdfRect[];
  text: string;
}

export interface PdfSelectionNoteRequest {
  comment: string;
  selection: PdfTextSelection;
}

export interface PdfSelectionAskRequest {
  question: string;
  selection: PdfTextSelection;
  signal: AbortSignal;
}

export type PdfSelectionActionResult = string | void;

export interface PdfSelectionActions {
  askAi?: (
    request: PdfSelectionAskRequest,
  ) => Promise<PdfSelectionActionResult> | PdfSelectionActionResult;
  saveNote?: (request: PdfSelectionNoteRequest) => Promise<void> | void;
  translate?: (
    selection: PdfTextSelection,
    signal: AbortSignal,
  ) => Promise<PdfSelectionActionResult> | PdfSelectionActionResult;
}
