import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauri.open }));

import {
  PaperBatchImportError,
  PaperImportError,
  TauriPaperImporter,
} from "./tauriPaperImporter";

const importedPaper = {
  id: "paper-1",
  title: "A paper",
  authors: null,
  year: null,
  filePath: "papers/paper-1.pdf",
  domainId: null,
  createdAt: 1_774_000_000_000,
};

const secondImportedPaper = {
  ...importedPaper,
  id: "paper-2",
  title: "Another paper",
  filePath: "papers/paper-2.pdf",
  createdAt: 1_774_000_000_001,
};

describe("TauriPaperImporter", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.open.mockReset();
  });

  it("opens a multi-select PDF picker and imports every selected path", async () => {
    tauri.open.mockResolvedValue([
      "/Users/research/one.pdf",
      "/Users/research/two.pdf",
    ]);
    tauri.invoke
      .mockResolvedValueOnce(importedPaper)
      .mockResolvedValueOnce(secondImportedPaper);
    const importer = new TauriPaperImporter();

    await expect(importer.chooseAndImport()).resolves.toEqual([
      importedPaper,
      secondImportedPaper,
    ]);

    expect(tauri.open).toHaveBeenCalledWith({
      directory: false,
      multiple: true,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    expect(tauri.invoke.mock.calls).toEqual([
      ["import_pdf", { sourcePath: "/Users/research/one.pdf", domainId: null }],
      ["import_pdf", { sourcePath: "/Users/research/two.pdf", domainId: null }],
    ]);
  });

  it("returns an empty list without invoking Rust when the picker is cancelled", async () => {
    tauri.open.mockResolvedValue(null);
    const importer = new TauriPaperImporter();

    await expect(importer.chooseAndImport()).resolves.toEqual([]);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("imports Finder drop paths sequentially", async () => {
    tauri.invoke
      .mockResolvedValueOnce(importedPaper)
      .mockResolvedValueOnce(secondImportedPaper);
    const importer = new TauriPaperImporter();

    await expect(
      importer.importPaths(["/tmp/one.pdf", "/tmp/two.pdf"]),
    ).resolves.toHaveLength(2);
    expect(tauri.invoke.mock.calls).toEqual([
      ["import_pdf", { sourcePath: "/tmp/one.pdf", domainId: null }],
      ["import_pdf", { sourcePath: "/tmp/two.pdf", domainId: null }],
    ]);
  });

  it("passes the selected domain through every import in a batch", async () => {
    tauri.open.mockResolvedValue(["/tmp/one.pdf"]);
    tauri.invoke.mockResolvedValue({ ...importedPaper, domainId: "domain-ai" });
    const importer = new TauriPaperImporter();

    await expect(
      importer.chooseAndImport({ domainId: "domain-ai" }),
    ).resolves.toMatchObject([{ domainId: "domain-ai" }]);
    expect(tauri.invoke).toHaveBeenCalledWith("import_pdf", {
      sourcePath: "/tmp/one.pdf",
      domainId: "domain-ai",
    });
  });

  it("reports papers committed before a later path fails", async () => {
    tauri.invoke
      .mockResolvedValueOnce(importedPaper)
      .mockRejectedValueOnce(
        new Error("corrupt file: /Users/private/second.pdf"),
      );
    const importer = new TauriPaperImporter();

    const error = await importer
      .importPaths(["/tmp/one.pdf", "/Users/private/second.pdf"])
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PaperBatchImportError);
    expect((error as PaperBatchImportError).importedPapers).toEqual([
      importedPaper,
    ]);
    expect((error as Error).message).not.toContain("/Users/private");
  });

  it("continues past invalid PDFs and reports every successful import", async () => {
    tauri.invoke
      .mockRejectedValueOnce(new Error("corrupt first PDF"))
      .mockResolvedValueOnce(importedPaper)
      .mockRejectedValueOnce(new Error("corrupt third PDF"))
      .mockResolvedValueOnce(secondImportedPaper);
    const importer = new TauriPaperImporter();

    const error = await importer
      .importPaths([
        "/tmp/bad-first.pdf",
        "/tmp/good-second.pdf",
        "/tmp/bad-third.pdf",
        "/tmp/good-fourth.pdf",
      ])
      .catch((cause: unknown) => cause);

    expect(tauri.invoke).toHaveBeenCalledTimes(4);
    expect(error).toBeInstanceOf(PaperBatchImportError);
    expect((error as PaperBatchImportError).importedPapers).toEqual([
      importedPaper,
      secondImportedPaper,
    ]);
    expect((error as PaperBatchImportError).failedCount).toBe(2);
  });

  it("rejects a malformed command response at the trust boundary", async () => {
    tauri.open.mockResolvedValue(["/Users/private/bad.pdf"]);
    tauri.invoke.mockResolvedValue({ ...importedPaper, id: 42 });
    const importer = new TauriPaperImporter();

    await expect(importer.chooseAndImport()).rejects.toBeInstanceOf(
      PaperImportError,
    );
  });

  it("rejects a malformed domain id at the trust boundary", async () => {
    tauri.open.mockResolvedValue(["/Users/private/bad.pdf"]);
    tauri.invoke.mockResolvedValue({ ...importedPaper, domainId: 42 });
    const importer = new TauriPaperImporter();

    await expect(importer.chooseAndImport()).rejects.toBeInstanceOf(
      PaperImportError,
    );
  });

  it("returns a friendly error that never exposes a local source path", async () => {
    tauri.open.mockResolvedValue(["/Users/private/secret-paper.pdf"]);
    tauri.invoke.mockRejectedValue(
      new Error("corrupt file: /Users/private/secret-paper.pdf"),
    );
    const importer = new TauriPaperImporter();

    const error = await importer.chooseAndImport().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PaperImportError);
    expect((error as Error).message).toBe(
      "无法导入 PDF，请确认文件有效且未损坏。",
    );
    expect((error as Error).message).not.toContain("/Users/private");
  });

  it("distinguishes picker failures from PDF validation failures", async () => {
    tauri.open.mockRejectedValue(new Error("dialog unavailable at /private/tmp"));
    const importer = new TauriPaperImporter();

    await expect(importer.chooseAndImport()).rejects.toMatchObject({
      message: "无法打开文件选择器，请重试。",
    });
  });
});
