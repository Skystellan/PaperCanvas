import type { PDFDocumentProxy } from "pdfjs-dist";
import { BaseDirectory, readFile } from "../../../platform/fs";

function usableTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/g, " ").trim();
  if (
    title.length < 3 || title.length > 500 || !/\p{L}/u.test(title) ||
    /^(?:untitled|unknown|none|null|document|title|main|template)(?:\s*\d+)?$/i.test(title) ||
    /^(?:arxiv\s*:?\s*)?(?:\d{4}\.\d{4,5}|[\w.-]+[/_]\d{7})(?:v\d+)?(?:\s.*)?$/i.test(title) ||
    /\.(?:pdf|tex|dvi|docx?|ps)$/i.test(title) ||
    /^(?:https?:\/\/|abstract$|introduction$|preprint$|submitted to\b|published (?:as|in)\b)/i.test(title)
  ) return null;
  return title;
}

async function firstPageTitle(document: PDFDocumentProxy): Promise<string | null> {
  const page = await document.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const text = content.items.flatMap((item) => {
    if (!("str" in item) || !item.str.trim()) return [];
    // Ignore the rotated arXiv identifier printed along the page margin.
    if (Math.abs(item.transform[1]) > Math.abs(item.transform[0])) return [];
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    return [{
      text: item.str,
      size: Math.hypot(item.transform[2], item.transform[3]),
      x, y, right: x + item.width,
    }];
  });
  const fontWeights = new Map<number, number>();
  for (const item of text) {
    const size = Math.round(item.size);
    fontWeights.set(size, (fontWeights.get(size) ?? 0) + item.text.length);
  }
  const bodySize = [...fontWeights].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const lines: typeof text = [];
  for (const item of text.sort((a, b) =>
    Math.abs(a.y - b.y) < Math.min(a.size, b.size) * 0.2 ? a.x - b.x : a.y - b.y,
  )) {
    const previous = lines[lines.length - 1];
    if (previous && Math.abs(item.y - previous.y) < Math.min(item.size, previous.size) * 0.2) {
      previous.text += (item.x - previous.right > item.size * 0.15 ? " " : "") + item.text;
      previous.right = item.right;
      previous.size = Math.max(previous.size, item.size);
    } else {
      lines.push({ ...item });
    }
  }
  const abstractY = lines.find((item) => /^abstract(?:\s*[:.\u2014\u2013-]|\s*$)/i.test(item.text.trim()))?.y;
  const candidates = lines.filter((item) =>
    item.y > 0 && item.y < Math.min(viewport.height * 0.6, abstractY ?? Infinity) &&
    usableTitle(item.text) !== null,
  );
  const largestSize = candidates.reduce((size, item) => Math.max(size, item.size), 0);
  // ponytail: first-page font heuristic; scanned PDFs need a future OCR path.
  if (largestSize < bodySize * 1.15) return null;
  const heading = candidates.filter((item) => item.size >= largestSize * 0.9);
  let title = "";
  let previous: typeof heading[number] | undefined;
  for (const item of heading) {
    if (previous) {
      if (item.y - previous.y > largestSize * 1.8) break;
      title += " ";
    }
    title += item.text;
    previous = item;
  }
  return usableTitle(title);
}

export async function readPdfTitle(filePath: string): Promise<string | null> {
  const [data, { loadPdfDocument }] = await Promise.all([
    readFile(filePath, { baseDir: BaseDirectory.AppData }),
    import("../../reader/pdfJsAdapter"),
  ]);
  const task = loadPdfDocument(data);
  try {
    const document = await task.promise;
    const metadata = await document.getMetadata().catch(() => null);
    const title = usableTitle(metadata?.metadata?.get("dc:title")) ??
      usableTitle((metadata?.info as { Title?: unknown } | undefined)?.Title);
    return title ?? await firstPageTitle(document);
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
