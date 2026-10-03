import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceCommandRunner } from "../../../data/workspaceClient";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  readPdfTitle: vi.fn(),
  executeWorkspaceCommand: vi.fn<WorkspaceCommandRunner>(),
}));

vi.mock("../../../platform/core", () => ({ invoke: tauri.invoke }));
vi.mock("../../../platform/dialog", () => ({ open: tauri.open }));
vi.mock("./pdfTitle", () => ({ readPdfTitle: tauri.readPdfTitle }));
vi.mock("../../../data/workspaceClient", () => ({
  executeWorkspaceCommand: tauri.executeWorkspaceCommand,
}));

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
    tauri.readPdfTitle.mockReset().mockResolvedValue(null);
    tauri.executeWorkspaceCommand.mockReset().mockResolvedValue({ revision: 2, value: null });
  });

  it("persists the PDF title instead of its arXiv filename before returning the paper", async () => {
    tauri.invoke.mockResolvedValue({ ...importedPaper, title: "2303.08774v2" });
    tauri.readPdfTitle.mockResolvedValue("A Researcher's Guide to Transformers");

    const papers = await new TauriPaperImporter().importPaths(["/tmp/2303.08774v2.pdf"]);

    expect(papers[0].title).toBe("A Researcher's Guide to Transformers");
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith("import_pdf", {
      sourcePath: "/tmp/2303.08774v2.pdf",
      domainId: null,
    });
    expect(tauri.readPdfTitle).toHaveBeenCalledWith(importedPaper.filePath);
    expect(tauri.executeWorkspaceCommand).toHaveBeenCalledExactlyOnceWith({
      type: "update_paper_title",
      paperId: importedPaper.id,
      title: "A Researcher's Guide to Transformers",
    });
  });

  it.each(["missing", "unchanged", "unreadable", "save failed"])(
    "keeps the committed import and filename when its title is %s",
    async (failure) => {
      tauri.invoke.mockResolvedValue(importedPaper);
      if (failure === "unchanged") tauri.readPdfTitle.mockResolvedValue(importedPaper.title);
      if (failure === "unreadable") tauri.readPdfTitle.mockRejectedValue(new Error("PDF parsing failed"));
      if (failure === "save failed") {
        tauri.readPdfTitle.mockResolvedValue("Extracted title");
        tauri.executeWorkspaceCommand.mockRejectedValue(new Error("workspace unavailable"));
      }

      await expect(new TauriPaperImporter().importPaths(["/tmp/paper.pdf"]))
        .resolves.toEqual([importedPaper]);
      expect(tauri.invoke).toHaveBeenCalledOnce();
      if (failure === "save failed") {
        expect(tauri.executeWorkspaceCommand).toHaveBeenCalledExactlyOnceWith({
          type: "update_paper_title", paperId: importedPaper.id, title: "Extracted title",
        });
      } else {
        expect(tauri.executeWorkspaceCommand).not.toHaveBeenCalled();
      }
    },
  );

  it("waits for title persistence before returning the updated paper", async () => {
    tauri.invoke.mockResolvedValue(importedPaper);
    tauri.readPdfTitle.mockResolvedValue("Extracted title");
    let finishSave!: () => void;
    tauri.executeWorkspaceCommand.mockReturnValue(new Promise((resolve) => {
      finishSave = () => resolve({ revision: 2, value: null });
    }));
    const completed = vi.fn();
    const importing = new TauriPaperImporter().importPaths(["/tmp/paper.pdf"]);
    void importing.then(completed);

    await vi.waitFor(() => expect(tauri.executeWorkspaceCommand).toHaveBeenCalledOnce());
    expect(completed).not.toHaveBeenCalled();

    finishSave();
    await expect(importing).resolves.toEqual([{ ...importedPaper, title: "Extracted title" }]);
  });

  it("continues a batch after optional title persistence fails", async () => {
    tauri.invoke
      .mockResolvedValueOnce(importedPaper)
      .mockResolvedValueOnce(secondImportedPaper);
    tauri.readPdfTitle
      .mockResolvedValueOnce("First extracted title")
      .mockResolvedValueOnce("Second extracted title");
    tauri.executeWorkspaceCommand.mockRejectedValueOnce(new Error("workspace unavailable"));

    await expect(new TauriPaperImporter().importPaths(["/tmp/one.pdf", "/tmp/two.pdf"]))
      .resolves.toEqual([importedPaper, { ...secondImportedPaper, title: "Second extracted title" }]);

    expect(tauri.invoke).toHaveBeenCalledTimes(2);
    expect(tauri.executeWorkspaceCommand.mock.calls).toEqual([
      [{ type: "update_paper_title", paperId: importedPaper.id, title: "First extracted title" }],
      [{ type: "update_paper_title", paperId: secondImportedPaper.id, title: "Second extracted title" }],
    ]);
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
