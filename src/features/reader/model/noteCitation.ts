import type { PdfHighlight } from "./pdfHighlight";
import { isSupportedPdfPageCount } from "./pdfLimits";

export interface NoteCitation { paperId: string; pageNumber: number; highlightId?: string }
export function parseNoteCitation(href: string): NoteCitation | null {
  if (!href.startsWith("#paper=")) return null;
  const params = new URLSearchParams(href.slice(1));
  const paperId = params.get("paper"), pageNumber = Number(params.get("page"));
  if (!paperId || !isSupportedPdfPageCount(pageNumber)) return null;
  return { paperId, pageNumber, highlightId: params.get("highlight") ?? undefined };
}
const escapeMarkdown = (text: string) => text.replace(/[\\`*_[\]<>]/g, "\\$&");
export function highlightMarkdown(highlight: PdfHighlight, title: string): string {
  const href = `#${new URLSearchParams({ paper: highlight.paperId, page: String(highlight.pageNumber), highlight: highlight.id })}`;
  const quote = escapeMarkdown(highlight.text).split("\n").map((line) => `> ${line}`).join("\n");
  return `${quote}\n\n[${escapeMarkdown(title.replace(/\s+/g, " "))} · p. ${highlight.pageNumber}](${href})${highlight.comment ? `\n\n${escapeMarkdown(highlight.comment)}` : ""}`;
}
