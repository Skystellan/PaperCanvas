import { PDF_MAX_ZOOM, PDF_MIN_ZOOM } from "../pdfViewerRuntime";
import { isSupportedPdfPageCount } from "./pdfLimits";

export type ReaderWorkspace = "notes" | "mindmap" | "discussion";
export interface PdfReadingLocation {
  pageNumber: number;
  offset: number;
  zoom: number;
}
export interface ReaderState {
  location?: PdfReadingLocation;
  workspace?: ReaderWorkspace;
  sidebarOpen?: boolean;
  sidebarRatio?: number;
}
const key = (paperId: string) => `paper-reader:v1:${paperId}`;

export function loadReaderState(paperId: string): ReaderState {
  try {
    const saved = JSON.parse(localStorage.getItem(key(paperId)) ?? "{}");
    if (!saved || typeof saved !== "object") return {};
    const state: ReaderState = {};
    if (["notes", "mindmap", "discussion"].includes(saved.workspace)) state.workspace = saved.workspace;
    if (typeof saved.sidebarOpen === "boolean") state.sidebarOpen = saved.sidebarOpen;
    if (Number.isFinite(saved.sidebarRatio)) state.sidebarRatio = Math.min(60, Math.max(24, saved.sidebarRatio));
    const location = saved.location;
    if (location && isSupportedPdfPageCount(location.pageNumber) &&
      Number.isFinite(location.offset) && Number.isFinite(location.zoom)) {
      state.location = {
        pageNumber: location.pageNumber,
        offset: Math.min(1, Math.max(0, location.offset)),
        zoom: Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, location.zoom)),
      };
    }
    return state;
  } catch { return {}; }
}

export function saveReaderState(paperId: string, patch: Partial<ReaderState>): void {
  try { localStorage.setItem(key(paperId), JSON.stringify({ ...loadReaderState(paperId), ...patch })); }
  catch { /* Reading remains available when browser storage is disabled/full. */ }
}
