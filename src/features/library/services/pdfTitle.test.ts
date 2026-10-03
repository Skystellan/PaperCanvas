import { beforeEach, describe, expect, it, vi } from "vitest";
// Run the bundled worker in-process so these tests parse actual PDF bytes.
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { readPdfTitle } from "./pdfTitle";

const files = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("../../../platform/fs", () => ({
  BaseDirectory: { AppData: 14 },
  readFile: files.readFile,
}));

// Real PDF objects exercise metadata decoding and PDF.js text coordinates.
function pdfFixture({ title, xmpTitle, content = "" }: {
  title?: string;
  xmpTitle?: string;
  content?: string;
} = {}): Uint8Array {
  const metadata = xmpTitle === undefined ? "" :
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmpTitle}</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>`;
  const encodedTitle = title === undefined ? "" : "feff" + Array.from(title)
    .map((character) => character.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${metadata ? "/Metadata 7 0 R" : ""} >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< ${title === undefined ? "" : `/Title <${encodedTitle}>`} >>`,
    `<< /Type /Metadata /Subtype /XML /Length ${metadata.length} >>\nstream\n${metadata}\nendstream`,
  ];
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${start}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

const paperContent = [
  // The arXiv stamp is larger than the title but rotated along the page margin.
  "BT /F1 28 Tf 0 1 -1 0 20 200 Tm (arXiv:2303.08774v2) Tj ET",
  "BT /F1 18 Tf 80 720 Td (Attention) Tj ( Is) Tj ( All) Tj ET",
  "BT /F1 18 Tf 80 696 Td (You Need) Tj ET",
  "BT /F1 12 Tf 80 655 Td (Alice Smith and Bob Jones) Tj ET",
  "BT /F1 10 Tf 80 610 Td (Abstract) Tj ET",
  "BT /F1 10 Tf 80 590 Td (This paper studies a model. The body text is longer than the title and uses a smaller font.) Tj ET",
  "BT /F1 24 Tf 80 540 Td (A Large Body Heading) Tj ET",
].join("\n");

describe("readPdfTitle with real PDFs", () => {
  beforeEach(() => files.readFile.mockReset());

  it("reads and normalizes a Unicode metadata title from the managed PDF", async () => {
    files.readFile.mockResolvedValue(pdfFixture({ title: "  论文标题：\n Transformer 方法  " }));

    await expect(readPdfTitle("papers/paper-1.pdf")).resolves.toBe("论文标题： Transformer 方法");
    expect(files.readFile).toHaveBeenCalledWith("papers/paper-1.pdf", { baseDir: 14 });
  });

  it("prefers a valid XMP title over the document info title", async () => {
    files.readFile.mockResolvedValue(pdfFixture({ title: "Outdated title", xmpTitle: "The Actual Paper Title" }));
    await expect(readPdfTitle("papers/paper-1.pdf")).resolves.toBe("The Actual Paper Title");
  });

  it.each([undefined, "Untitled", "2303.08774v2", "arXiv:2303.08774v2", "main.tex"])(
    "extracts a multiline title when metadata is %s, ignoring the margin, authors and body",
    async (title) => {
      files.readFile.mockResolvedValue(pdfFixture({ title, content: paperContent }));
      await expect(readPdfTitle("papers/paper-1.pdf")).resolves.toBe("Attention Is All You Need");
    },
  );

  it.each(["", "BT /F1 12 Tf 80 720 Td (Plain text without a distinct title) Tj ET"])(
    "returns no title for a page without a recognizable heading",
    async (content) => {
      files.readFile.mockResolvedValue(pdfFixture({ content }));
      await expect(readPdfTitle("papers/paper-1.pdf")).resolves.toBeNull();
    },
  );

  it("rejects an unreadable PDF so the importer can retain the filename", async () => {
    files.readFile.mockResolvedValue(new TextEncoder().encode("%PDF-1.7\nbroken"));
    await expect(readPdfTitle("papers/paper-1.pdf")).rejects.toThrow();
  });
});
