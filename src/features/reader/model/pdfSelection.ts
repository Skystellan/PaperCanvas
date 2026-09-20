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

export interface PdfSelectionActions {
  saveNote?: (request: PdfSelectionNoteRequest) => Promise<void> | void;
  addToNotes?: (request: PdfSelectionNoteRequest) => Promise<void> | void;
}
