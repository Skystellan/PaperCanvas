import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PaperRepository } from "./data/paperRepository";
import type { PaperDomainRepository } from "./data/paperDomainRepository";
import type { Paper } from "./model/paper";
import type { PaperDomain } from "./model/paperDomain";
import type { PaperImporter } from "./services/paperImporter";
import { PaperBatchImportError } from "./services/tauriPaperImporter";

const tauriWebview = vi.hoisted(() => ({
  onDragDropEvent: vi.fn(),
}));
const defaultDomainRepository = vi.hoisted(() => ({
  assignPaper: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(async () => []),
  rename: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => tauriWebview,
}));
vi.mock("./data/sqlitePaperDomainRepository", () => ({
  sqlitePaperDomainRepository: defaultDomainRepository,
}));

import { PAPER_DRAG_MIME, PaperLibrary } from "./PaperLibrary";

const imported: Paper = {
  id: "paper-imported",
  title: "Imported Paper",
  authors: null,
  year: null,
  filePath: "papers/imported.pdf",
  createdAt: 1_774_000_000_000,
  domainId: "domain-ai",
};

const legacy: Paper = {
  id: "paper-legacy",
  title: "Legacy Canvas Paper",
  authors: "Past Author",
  year: 2010,
  filePath: null,
  createdAt: 1,
  domainId: null,
};

const secondImported: Paper = {
  id: "paper-imported-2",
  title: "Second Imported Paper",
  authors: "Another Author",
  year: 2024,
  filePath: "papers/imported-2.pdf",
  createdAt: 1_774_000_000_001,
  domainId: null,
};

const aiDomain: PaperDomain = {
  id: "domain-ai",
  name: "AI",
  createdAt: 1,
  updatedAt: 1,
};

function createRepository(papers: Paper[] = [imported, legacy]) {
  return {
    list: vi.fn().mockResolvedValue(papers),
    getById: vi.fn(),
  } satisfies PaperRepository;
}

function createImporter() {
  return {
    chooseAndImport: vi.fn().mockResolvedValue([]),
    importPaths: vi.fn().mockResolvedValue([]),
  } satisfies PaperImporter;
}

function createDomainRepository(domains: PaperDomain[] = [aiDomain]) {
  return {
    assignPaper: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(async (name: string) => ({
      id: "domain-created",
      name,
      createdAt: 2,
      updatedAt: 2,
    })),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue(domains),
    rename: vi.fn().mockResolvedValue(undefined),
  } satisfies PaperDomainRepository;
}

function createMutator() {
  return {
    deletePaper: vi.fn().mockResolvedValue(undefined),
    reconcileStorage: vi.fn().mockResolvedValue(undefined),
  };
}

describe("PaperLibrary", () => {
  let dragDropHandler:
    | ((event: {
        payload: {
          type: string;
          paths?: string[];
          position?: { x: number; y: number };
        };
      }) => void)
    | undefined;
  const unlisten = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    dragDropHandler = undefined;
    tauriWebview.onDragDropEvent.mockImplementation(
      async (
        handler: (event: {
          payload: {
            type: string;
            paths?: string[];
            position?: { x: number; y: number };
          };
        }) => void,
      ) => {
        dragDropHandler = handler;
        return unlisten;
      },
    );
  });

  it("loads papers, keeps legacy entries visible, and filters locally", async () => {
    const repository = createRepository();
    const user = userEvent.setup();
    render(
      <PaperLibrary repository={repository} importer={createImporter()} />,
    );

    expect(screen.getByText("正在加载论文…")).toBeInTheDocument();
    expect(await screen.findByText("Imported Paper")).toBeInTheDocument();
    expect(screen.getByText("Legacy Canvas Paper")).toBeInTheDocument();
    expect(screen.getByText("无本地 PDF")).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox"), "legacy");

    expect(screen.queryByText("Imported Paper")).not.toBeInTheDocument();
    expect(screen.getByText("Legacy Canvas Paper")).toBeInTheDocument();
    expect(repository.list).toHaveBeenCalledOnce();
  });

  it("groups papers into collapsible domains and temporarily expands search matches", async () => {
    const user = userEvent.setup();
    render(
      <PaperLibrary
        domainRepository={createDomainRepository()}
        importer={createImporter()}
        repository={createRepository()}
      />,
    );

    const aiToggle = await screen.findByRole("button", { name: "AI（1）" });
    expect(screen.getByRole("button", { name: "未分区（1）" })).toBeVisible();
    await user.click(aiToggle);
    expect(aiToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Imported Paper")).not.toBeVisible();

    await user.type(screen.getByRole("searchbox"), "Imported");
    expect(screen.getByText("Imported Paper")).toBeVisible();
    expect(aiToggle).toHaveAttribute("aria-expanded", "true");
  });

  it("moves a paper only after pending workspace persistence is flushed", async () => {
    const domainRepository = createDomainRepository();
    const beforeOrganizationChange = vi.fn().mockResolvedValue(undefined);
    const onOrganizationChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <PaperLibrary
        beforeOrganizationChange={beforeOrganizationChange}
        domainRepository={domainRepository}
        importer={createImporter()}
        onOrganizationChanged={onOrganizationChanged}
        repository={createRepository()}
      />,
    );

    await user.selectOptions(
      await screen.findByLabelText("移动 Legacy Canvas Paper 到领域"),
      aiDomain.id,
    );

    await waitFor(() =>
      expect(domainRepository.assignPaper).toHaveBeenCalledWith(
        legacy.id,
        aiDomain.id,
      ),
    );
    expect(beforeOrganizationChange).toHaveBeenCalledOnce();
    expect(beforeOrganizationChange.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(domainRepository.assignPaper).mock.invocationCallOrder[0],
    );
    expect(onOrganizationChanged).toHaveBeenCalledWith([legacy.id]);
  });

  it("imports a multi-select batch directly into the chosen domain", async () => {
    const importer = createImporter();
    const user = userEvent.setup();
    render(
      <PaperLibrary
        domainRepository={createDomainRepository()}
        importer={importer}
        repository={createRepository()}
      />,
    );

    await user.selectOptions(
      await screen.findByLabelText("导入 PDF 到领域"),
      aiDomain.id,
    );
    await user.click(screen.getByRole("button", { name: "导入 PDF" }));

    expect(importer.chooseAndImport).toHaveBeenCalledWith({
      domainId: aiDomain.id,
    });
  });

  it("creates, renames, and safely deletes a domain without deleting papers", async () => {
    const domainRepository = createDomainRepository();
    const onOrganizationChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <PaperLibrary
        domainRepository={domainRepository}
        importer={createImporter()}
        onOrganizationChanged={onOrganizationChanged}
        repository={createRepository()}
      />,
    );

    await screen.findByRole("button", { name: "AI（1）" });
    await user.click(screen.getByRole("button", { name: "新建领域" }));
    await user.type(screen.getByLabelText("新领域名称"), "Systems");
    await user.click(screen.getByRole("button", { name: "保存领域" }));
    await waitFor(() => expect(domainRepository.create).toHaveBeenCalledWith("Systems"));

    await user.click(screen.getByRole("button", { name: "重命名 AI" }));
    const rename = screen.getByLabelText("领域名称");
    await user.clear(rename);
    await user.type(rename, "Machine Learning");
    await user.click(screen.getByRole("button", { name: "保存重命名" }));
    await waitFor(() =>
      expect(domainRepository.rename).toHaveBeenCalledWith(
        aiDomain.id,
        "Machine Learning",
      ),
    );

    await user.click(screen.getByRole("button", { name: "删除 AI" }));
    expect(screen.getByRole("dialog", { name: "删除领域" })).toHaveTextContent(
      /论文会移到“未分区”/,
    );
    await user.click(screen.getByRole("button", { name: "确认删除领域" }));
    await waitFor(() =>
      expect(domainRepository.delete).toHaveBeenCalledWith(aiDomain.id),
    );
    expect(onOrganizationChanged).toHaveBeenCalled();
  });

  it("traps focus in the domain delete dialog and restores it on Escape", async () => {
    const user = userEvent.setup();
    render(
      <PaperLibrary
        domainRepository={createDomainRepository()}
        importer={createImporter()}
        repository={createRepository()}
      />,
    );
    const deleteButton = await screen.findByRole("button", {
      name: "删除 AI",
    });

    await user.click(deleteButton);
    const dialog = screen.getByRole("dialog", { name: "删除领域" });
    const cancelButton = within(dialog).getByRole("button", { name: "取消" });
    const confirmButton = within(dialog).getByRole("button", {
      name: "确认删除领域",
    });
    expect(cancelButton).toHaveFocus();

    await user.tab({ shift: true });
    expect(confirmButton).toHaveFocus();
    await user.tab();
    expect(cancelButton).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "删除领域" })).not.toBeInTheDocument();
    expect(deleteButton).toHaveFocus();
  });

  it("reconciles managed storage once after the database first loads", async () => {
    const mutator = createMutator();
    const view = render(
      <PaperLibrary
        repository={createRepository()}
        importer={createImporter()}
        mutator={mutator}
      />,
    );

    await screen.findByText("Imported Paper");
    view.rerender(
      <PaperLibrary
        repository={createRepository()}
        importer={createImporter()}
        mutator={mutator}
      />,
    );

    expect(mutator.reconcileStorage).toHaveBeenCalledOnce();
  });

  it("marks the paper selected by the workspace", async () => {
    render(
      <PaperLibrary
        repository={createRepository()}
        importer={createImporter()}
        selectedPaperId="paper-imported"
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Imported Paper" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Legacy Canvas Paper（无本地 PDF）" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("shows a recoverable load error and retries", async () => {
    const repository = createRepository();
    repository.list
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce([imported, legacy]);
    const user = userEvent.setup();
    render(
      <PaperLibrary repository={repository} importer={createImporter()} />,
    );

    expect(
      await screen.findByText("无法读取论文库，请重试。"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("Imported Paper")).toBeInTheDocument();
    expect(repository.list).toHaveBeenCalledTimes(2);
  });

  it("distinguishes an empty library from an empty search result", async () => {
    const user = userEvent.setup();
    const emptyView = render(
      <PaperLibrary repository={createRepository([])} importer={createImporter()} />,
    );

    expect(
      await screen.findByText("还没有论文，导入一篇 PDF 开始。"),
    ).toBeInTheDocument();
    emptyView.unmount();

    render(
      <PaperLibrary repository={createRepository()} importer={createImporter()} />,
    );
    await screen.findByText("Imported Paper");
    await user.type(screen.getByRole("searchbox"), "nothing matches");

    expect(screen.getByText("没有匹配的论文。")).toBeInTheDocument();
  });

  it("imports every PDF selected in the picker, refreshes once, and reports both papers", async () => {
    const repository = createRepository([legacy]);
    repository.list
      .mockResolvedValueOnce([legacy])
      .mockResolvedValueOnce([secondImported, imported, legacy]);
    const importer = createImporter();
    importer.chooseAndImport.mockResolvedValue([imported, secondImported]);
    const onPapersImported = vi.fn();
    const user = userEvent.setup();
    render(
      <PaperLibrary
        repository={repository}
        importer={importer}
        onPapersImported={onPapersImported}
      />,
    );
    await screen.findByText("Legacy Canvas Paper");

    await user.click(screen.getByRole("button", { name: "导入 PDF" }));

    expect(importer.chooseAndImport).toHaveBeenCalledOnce();
    expect(await screen.findByText("Imported Paper")).toBeInTheDocument();
    expect(screen.getByText("Second Imported Paper")).toBeInTheDocument();
    expect(repository.list).toHaveBeenCalledTimes(2);
    expect(onPapersImported).toHaveBeenCalledWith([imported, secondImported]);
  });

  it("does not refresh or report an import when the picker is cancelled", async () => {
    const repository = createRepository();
    const importer = createImporter();
    const onPapersImported = vi.fn();
    const user = userEvent.setup();
    render(
      <PaperLibrary
        repository={repository}
        importer={importer}
        onPapersImported={onPapersImported}
      />,
    );
    await screen.findByText("Imported Paper");

    await user.click(screen.getByRole("button", { name: "导入 PDF" }));

    expect(repository.list).toHaveBeenCalledOnce();
    expect(onPapersImported).not.toHaveBeenCalled();
  });

  it("does not expose arbitrary importer errors in the UI", async () => {
    const repository = createRepository();
    const importer = createImporter();
    importer.chooseAndImport.mockRejectedValue(
      new Error("failed at /Users/private/secret.pdf"),
    );
    const user = userEvent.setup();
    render(<PaperLibrary repository={repository} importer={importer} />);
    await screen.findByText("Imported Paper");

    await user.click(screen.getByRole("button", { name: "导入 PDF" }));

    expect(
      await screen.findByText("无法导入 PDF，请重试。"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Users\/private/)).not.toBeInTheDocument();
    expect(repository.list).toHaveBeenCalledTimes(2);
  });

  it("publishes successful papers when a later picker import fails", async () => {
    const repository = createRepository([legacy]);
    repository.list
      .mockResolvedValueOnce([legacy])
      .mockResolvedValueOnce([imported, legacy]);
    const importer = createImporter();
    importer.chooseAndImport.mockRejectedValue(
      new PaperBatchImportError([imported], 2),
    );
    const onPapersImported = vi.fn();
    const user = userEvent.setup();
    render(
      <PaperLibrary
        repository={repository}
        importer={importer}
        onPapersImported={onPapersImported}
      />,
    );
    await screen.findByText("Legacy Canvas Paper");

    await user.click(screen.getByRole("button", { name: "导入 PDF" }));

    expect(await screen.findByText("Imported Paper")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "已导入 1 篇 PDF，另有 2 个文件导入失败。",
    );
    expect(onPapersImported).toHaveBeenCalledWith([imported]);
    expect(repository.list).toHaveBeenCalledTimes(2);
  });

  it("imports only PDF paths from a native Finder drop", async () => {
    const repository = createRepository([legacy]);
    repository.list
      .mockResolvedValueOnce([legacy])
      .mockResolvedValueOnce([imported, legacy]);
    const importer = createImporter();
    importer.importPaths.mockResolvedValue([imported]);
    const onPapersImported = vi.fn();
    render(
      <PaperLibrary
        repository={repository}
        importer={importer}
        onPapersImported={onPapersImported}
      />,
    );

    await waitFor(() => expect(dragDropHandler).toBeDefined());
    await act(async () => {
      dragDropHandler?.({
        payload: {
          type: "drop",
          paths: ["/tmp/paper.PDF", "/tmp/readme.txt"],
        },
      });
    });

    await waitFor(() =>
      expect(importer.importPaths).toHaveBeenCalledWith(["/tmp/paper.PDF"]),
    );
    expect(onPapersImported).toHaveBeenCalledWith([imported]);
    expect(await screen.findByText("Imported Paper")).toBeInTheDocument();
  });

  it("ignores another native PDF drop while an import is still running", async () => {
    let finishImport: ((papers: Paper[]) => void) | undefined;
    const importer = createImporter();
    importer.importPaths.mockReturnValue(
      new Promise<Paper[]>((resolve) => {
        finishImport = resolve;
      }),
    );
    render(
      <PaperLibrary repository={createRepository()} importer={importer} />,
    );
    await waitFor(() => expect(dragDropHandler).toBeDefined());

    act(() => {
      dragDropHandler?.({
        payload: { type: "drop", paths: ["/tmp/first.pdf"] },
      });
      dragDropHandler?.({
        payload: { type: "drop", paths: ["/tmp/second.pdf"] },
      });
    });

    expect(importer.importPaths).toHaveBeenCalledOnce();
    expect(importer.importPaths).toHaveBeenCalledWith(["/tmp/first.pdf"]);
    await act(async () => {
      finishImport?.([]);
    });
  });

  it("registers imports as close-blocking persistence operations", async () => {
    const trackPersistenceOperation = vi.fn(
      (operation: Promise<void>) => operation,
    );
    const user = userEvent.setup();
    render(
      <PaperLibrary
        repository={createRepository()}
        importer={createImporter()}
        trackPersistenceOperation={trackPersistenceOperation}
      />,
    );
    await screen.findByText("Imported Paper");

    await user.click(screen.getByRole("button", { name: "导入 PDF" }));

    expect(trackPersistenceOperation).toHaveBeenCalledOnce();
  });

  it("shows a friendly message for a native drop without PDFs", async () => {
    render(
      <PaperLibrary repository={createRepository()} importer={createImporter()} />,
    );
    await waitFor(() => expect(dragDropHandler).toBeDefined());

    act(() => {
      dragDropHandler?.({
        payload: { type: "drop", paths: ["/Users/private/notes.txt"] },
      });
    });

    expect(await screen.findByText("只支持 PDF 文件。")).toBeInTheDocument();
    expect(screen.queryByText("/Users/private/notes.txt")).not.toBeInTheDocument();
  });

  it("ignores an empty native drop emitted for an in-app paper drag", async () => {
    const importer = createImporter();
    render(
      <PaperLibrary repository={createRepository()} importer={importer} />,
    );
    await waitFor(() => expect(dragDropHandler).toBeDefined());

    act(() => {
      dragDropHandler?.({ payload: { type: "drop", paths: [] } });
    });

    expect(screen.queryByText("只支持 PDF 文件。")).not.toBeInTheDocument();
    expect(importer.importPaths).not.toHaveBeenCalled();
  });

  it("ignores native drag lifecycle events that are not drops", async () => {
    const importer = createImporter();
    render(
      <PaperLibrary repository={createRepository()} importer={importer} />,
    );
    await waitFor(() => expect(dragDropHandler).toBeDefined());

    act(() => {
      dragDropHandler?.({ payload: { type: "enter", paths: ["/tmp/paper.pdf"] } });
    });

    expect(importer.importPaths).not.toHaveBeenCalled();
  });

  it("shows a friendly error when the native drop listener cannot start", async () => {
    tauriWebview.onDragDropEvent.mockRejectedValue(
      new Error("failed at /Users/private"),
    );
    render(
      <PaperLibrary repository={createRepository()} importer={createImporter()} />,
    );

    expect(
      await screen.findByText("无法启用 Finder 拖放导入。"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Users\/private/)).not.toBeInTheDocument();
  });

  it("cleans up the native drag/drop listener on unmount", async () => {
    const view = render(
      <PaperLibrary repository={createRepository()} importer={createImporter()} />,
    );
    await waitFor(() =>
      expect(tauriWebview.onDragDropEvent).toHaveBeenCalledOnce(),
    );

    view.unmount();

    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("cleans up when listener setup completes after unmount", async () => {
    let resolveListener: ((listener: () => void) => void) | undefined;
    tauriWebview.onDragDropEvent.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveListener = resolve;
      }),
    );
    const view = render(
      <PaperLibrary repository={createRepository()} importer={createImporter()} />,
    );
    await waitFor(() =>
      expect(tauriWebview.onDragDropEvent).toHaveBeenCalledOnce(),
    );

    view.unmount();
    await act(async () => {
      resolveListener?.(unlisten);
    });

    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("bridges an in-app paper drag through the native empty-path drop", async () => {
    const onPaperDrop = vi.fn();
    render(
      <PaperLibrary
        repository={createRepository()}
        importer={createImporter()}
        onPaperDrop={onPaperDrop}
      />,
    );
    const item = await screen.findByText("Imported Paper");
    const button = item.closest("button")!;
    const setData = vi.fn();

    fireEvent.dragStart(button, {
      dataTransfer: { effectAllowed: "none", setData },
    });
    act(() => {
      dragDropHandler?.({
        payload: { type: "enter", paths: [], position: { x: 400, y: 260 } },
      });
      dragDropHandler?.({
        payload: { type: "drop", paths: [], position: { x: 400, y: 260 } },
      });
    });

    await waitFor(() =>
      expect(onPaperDrop).toHaveBeenCalledWith({
        paperId: imported.id,
        clientX: 400,
        clientY: 260,
      }),
    );
    expect(setData).toHaveBeenCalledWith(PAPER_DRAG_MIME, imported.id);
    expect(button).toHaveAttribute("draggable", "true");
    expect(screen.queryByText("只支持 PDF 文件。")).not.toBeInTheDocument();
  });

  it("notifies its owner when a paper is selected", async () => {
    const onPaperSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <PaperLibrary
        repository={createRepository()}
        importer={createImporter()}
        onPaperSelect={onPaperSelect}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Imported Paper" }),
    );

    expect(onPaperSelect).toHaveBeenCalledWith(imported);
  });

  it("asks for confirmation and lets the user cancel a paper deletion", async () => {
    const mutator = createMutator();
    const beforePaperDelete = vi.fn();
    const onPaperDeleted = vi.fn();
    const user = userEvent.setup();
    render(
      <PaperLibrary
        repository={createRepository()}
        importer={createImporter()}
        mutator={mutator}
        beforePaperDelete={beforePaperDelete}
        onPaperDeleted={onPaperDeleted}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "删除 Imported Paper" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Imported Paper/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mutator.deletePaper).not.toHaveBeenCalled();
    expect(beforePaperDelete).not.toHaveBeenCalled();
    expect(onPaperDeleted).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Imported Paper" }),
    ).toBeInTheDocument();
  });

  it("moves focus into the delete dialog, traps Tab, and restores focus on Escape", async () => {
    const user = userEvent.setup();
    render(
      <PaperLibrary
        repository={createRepository()}
        importer={createImporter()}
        mutator={createMutator()}
      />,
    );
    const deleteButton = await screen.findByRole("button", {
      name: "删除 Imported Paper",
    });

    await user.click(deleteButton);
    const dialog = screen.getByRole("dialog");
    const cancelButton = within(dialog).getByRole("button", { name: "取消" });
    const confirmButton = within(dialog).getByRole("button", {
      name: "确认删除",
    });
    expect(cancelButton).toHaveFocus();

    await user.tab({ shift: true });
    expect(confirmButton).toHaveFocus();
    await user.tab();
    expect(cancelButton).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deleteButton).toHaveFocus();
  });

  it("awaits beforePaperDelete, deletes the paper, and reports successful deletion", async () => {
    const sequence: string[] = [];
    const repository = createRepository();
    repository.list
      .mockResolvedValueOnce([imported, legacy])
      .mockResolvedValueOnce([legacy]);
    const mutator = createMutator();
    mutator.deletePaper.mockImplementation(async () => {
      sequence.push("mutator");
    });
    const beforePaperDelete = vi.fn(async () => {
      sequence.push("before:start");
      await Promise.resolve();
      sequence.push("before:end");
    });
    const onPaperDeleted = vi.fn(() => {
      sequence.push("deleted");
    });
    const user = userEvent.setup();
    render(
      <PaperLibrary
        repository={repository}
        importer={createImporter()}
        mutator={mutator}
        beforePaperDelete={beforePaperDelete}
        onPaperDeleted={onPaperDeleted}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "删除 Imported Paper" }),
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "确认删除",
      }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Imported Paper" }),
      ).not.toBeInTheDocument(),
    );
    expect(beforePaperDelete).toHaveBeenCalledWith(imported);
    expect(mutator.deletePaper).toHaveBeenCalledWith(imported.id);
    expect(onPaperDeleted).toHaveBeenCalledWith(imported);
    expect(sequence).toEqual(["before:start", "before:end", "mutator", "deleted"]);
  });

  it("registers confirmed deletion as a close-blocking persistence operation", async () => {
    const trackPersistenceOperation = vi.fn(
      (operation: Promise<void>) => operation,
    );
    const user = userEvent.setup();
    render(
      <PaperLibrary
        repository={createRepository()}
        importer={createImporter()}
        mutator={createMutator()}
        trackPersistenceOperation={trackPersistenceOperation}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "删除 Imported Paper" }),
    );
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    expect(trackPersistenceOperation).toHaveBeenCalledOnce();
  });

  it("keeps the paper when the mutator fails and does not expose local paths", async () => {
    const mutator = createMutator();
    mutator.deletePaper.mockRejectedValue(
      new Error("unlink failed at /Users/private/papers/imported.pdf"),
    );
    const beforePaperDelete = vi.fn().mockResolvedValue(undefined);
    const onPaperDeleted = vi.fn();
    const user = userEvent.setup();
    render(
      <PaperLibrary
        repository={createRepository()}
        importer={createImporter()}
        mutator={mutator}
        beforePaperDelete={beforePaperDelete}
        onPaperDeleted={onPaperDeleted}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "删除 Imported Paper" }),
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "确认删除",
      }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("无法删除论文，请重试。");
    expect(alert).not.toHaveTextContent("/Users/private");
    expect(
      screen.getByRole("button", { name: "Imported Paper" }),
    ).toBeInTheDocument();
    expect(beforePaperDelete).toHaveBeenCalledWith(imported);
    expect(mutator.deletePaper).toHaveBeenCalledWith(imported.id);
    expect(onPaperDeleted).not.toHaveBeenCalled();
  });

  it("does not invoke the mutator or remove the paper when beforePaperDelete fails", async () => {
    const mutator = createMutator();
    const beforePaperDelete = vi
      .fn()
      .mockRejectedValue(new Error("pending canvas writes failed"));
    const onPaperDeleted = vi.fn();
    const user = userEvent.setup();
    render(
      <PaperLibrary
        repository={createRepository()}
        importer={createImporter()}
        mutator={mutator}
        beforePaperDelete={beforePaperDelete}
        onPaperDeleted={onPaperDeleted}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "删除 Imported Paper" }),
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "确认删除",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法删除论文，请重试。",
    );
    expect(mutator.deletePaper).not.toHaveBeenCalled();
    expect(onPaperDeleted).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Imported Paper" }),
    ).toBeInTheDocument();
  });
});
