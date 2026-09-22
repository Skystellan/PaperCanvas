import type { PDFDocumentProxy } from "pdfjs-dist";

export interface PdfOutlineEntry {
  title: string;
  depth: number;
  pageNumber: number | null;
  destination: string | unknown[] | null;
}

export async function loadPdfOutline(document: PDFDocumentProxy): Promise<PdfOutlineEntry[]> {
  const result: PdfOutlineEntry[] = [];
  const visit = async (items: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>, depth: number) => {
    for (const item of items ?? []) {
      let pageNumber: number | null = null;
      const destination = typeof item.dest === "string" || Array.isArray(item.dest) ? item.dest : null;
      try {
        const resolved = typeof destination === "string" ? await document.getDestination(destination) : destination;
        const ref = resolved?.[0];
        const index = typeof ref === "number" ? ref : ref ? await document.getPageIndex(ref) : -1;
        if (Number.isInteger(index) && index >= 0 && index < document.numPages) pageNumber = index + 1;
      } catch { /* A broken destination must not hide the remaining contents. */ }
      result.push({ title: item.title, depth, pageNumber, destination });
      await visit(item.items, depth + 1);
    }
  };
  await visit(await document.getOutline(), 0);
  return result;
}
