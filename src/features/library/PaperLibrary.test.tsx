import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    localStorage.removeItem("paper-library-width");
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

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.removeItem("paper-library-width");
  });

  it("captures a right-edge drag and remembers the width after reopening", async () => {
    const props = { repository: createRepository(), importer: createImporter() };
    const view = render(<PaperLibrary {...props} />);
    await screen.findByText("Imported Paper");
    const panel = screen.getByRole("complementary", { name: "论文库" });
    const handle = screen.getByRole("separator", { name: "调整论文库宽度" });
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();
    const pointer = (type: string, clientX: number, button = 0) => {
      fireEvent(handle, Object.assign(new MouseEvent(type, { bubbles: true, clientX, button }), { pointerId: 1 }));
    };

    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-controls", panel.id);
    pointer("pointerdown", 310, 2);
    pointer("pointermove", 390);
    expect(panel).toHaveStyle({ width: "310px" });
    expect(handle.setPointerCapture).not.toHaveBeenCalled();

    pointer("pointerdown", 310);
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
    expect(handle).toHaveFocus();
    pointer("pointermove", 390);
    expect(panel).toHaveStyle({ width: "390px" });
    expect(handle).toHaveAttribute("aria-valuenow", "390");
    pointer("pointerup", 390);
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
    pointer("pointermove", 200);
    expect(panel).toHaveStyle({ width: "390px" });

    view.unmount();
    render(<PaperLibrary {...props} />);
    await screen.findByText("Imported Paper");
    expect(screen.getByRole("complementary", { name: "论文库" })).toHaveStyle({ width: "390px" });
  });

  it.each(["pointercancel", "lostpointercapture"])("stops resizing after %s", async (eventType) => {
    render(<PaperLibrary repository={createRepository()} importer={createImporter()} />);
    await screen.findByText("Imported Paper");
    const handle = screen.getByRole("separator");
    handle.setPointerCapture = vi.fn();
    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientX: 310, button: 0 }));
    fireEvent(handle, new MouseEvent("pointermove", { bubbles: true, clientX: 350 }));
    expect(handle).toHaveAttribute("aria-valuenow", "350");
    fireEvent(handle, new Event(eventType, { bubbles: true }));
    fireEvent(handle, new MouseEvent("pointermove", { bubbles: true, clientX: 400 }));
    expect(handle).toHaveAttribute("aria-valuenow", "350");
  });

  it("supports keyboard bounds, viewport changes, and a persistent double-click reset", async () => {
    vi.stubGlobal("innerWidth", 1200);
    const user = userEvent.setup();
    const props = { repository: createRepository(), importer: createImporter() };
    const view = render(<PaperLibrary {...props} />);
    await screen.findByText("Imported Paper");
    const handle = screen.getByRole("separator");
    handle.focus();
    await user.keyboard("{ArrowRight}");
    expect(handle).toHaveAttribute("aria-valuenow", "326");
    await user.keyboard("{ArrowLeft}");
    expect(handle).toHaveAttribute("aria-valuenow", "310");
    await user.keyboard("{Home}{ArrowLeft}");
    expect(handle).toHaveAttribute("aria-valuenow", "260");
    await user.keyboard("{End}{ArrowRight}");
    expect(handle).toHaveAttribute("aria-valuenow", "504");
    expect(handle).toHaveAttribute("aria-valuemax", "504");

    vi.stubGlobal("innerWidth", 800);
    fireEvent(window, new Event("resize"));
    expect(handle).toHaveAttribute("aria-valuenow", "336");
    expect(handle).toHaveAttribute("aria-valuemax", "336");
    fireEvent.doubleClick(handle);
    expect(handle).toHaveAttribute("aria-valuenow", "310");
    view.unmount();
    render(<PaperLibrary {...props} />);
    await screen.findByText("Imported Paper");
    expect(screen.getByRole("complementary", { name: "论文库" })).toHaveStyle({ width: "310px" });
  });

  it.each([["not-a-width", "310"], ["900", "430"]])("handles stored width %s within viewport bounds", async (saved, expected) => {
    vi.stubGlobal("innerWidth", 1024);
    localStorage.setItem("paper-library-width", saved);
    render(<PaperLibrary repository={createRepository()} importer={createImporter()} />);
    await screen.findByText("Imported Paper");
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", expected);
  });

  it("still resizes when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
    render(<PaperLibrary repository={createRepository()} importer={createImporter()} />);
    await screen.findByText("Imported Paper");
    const handle = screen.getByRole("separator");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "326");
  });

  it("exposes row actions through one keyboard disclosure and dismisses it with Escape", async () => {
    const user = userEvent.setup();
    const onPaperSelect = vi.fn();
    const onOpenPaper = vi.fn();
    render(<PaperLibrary repository={createRepository()} importer={createImporter()} onPaperSelect={onPaperSelect} onOpenPaper={onOpenPaper} />);
    const trigger = await screen.findByRole("button", { name: "Imported Paper 的更多操作" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("combobox", { name: "移动 Imported Paper 到领域" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除 Imported Paper" })).not.toBeInTheDocument();

    trigger.focus();
    await user.keyboard("{Enter}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const select = screen.getByRole("combobox", { name: "移动 Imported Paper 到领域" });
    expect(select).toBeVisible();
    await user.tab();
    expect(select).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "删除 Imported Paper" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "删除 Imported Paper" })).not.toBeInTheDocument();
    expect(onPaperSelect).not.toHaveBeenCalled();
    expect(onOpenPaper).not.toHaveBeenCalled();
  });

  it("dismisses row actions on outside pointer or focus interaction and when another menu opens", async () => {
    const user = userEvent.setup();
    render(<PaperLibrary domainRepository={createDomainRepository()} repository={createRepository()} importer={createImporter()} />);
    const trigger = await screen.findByRole("button", { name: "Imported Paper 的更多操作" });
    const otherTrigger = screen.getByRole("button", { name: "Legacy Canvas Paper 的更多操作" });
    await user.click(trigger);
    document.body.addEventListener("pointerdown", (event) => event.stopPropagation(), { once: true });
    fireEvent.pointerDown(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    await user.click(otherTrigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(otherTrigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("button", { name: "删除 Imported Paper" })).not.toBeInTheDocument();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "删除 Legacy Canvas Paper" })).toHaveFocus();
    await user.tab();
    expect(otherTrigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "删除 Legacy Canvas Paper" })).not.toBeInTheDocument();
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

    await user.click(
      await screen.findByRole("button", { name: "Legacy Canvas Paper 的更多操作" }),
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "移动 Legacy Canvas Paper 到领域" }),
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

  it("selects on a single click and opens the exact paper on a double-click", async () => {
    const onPaperSelect = vi.fn();
    const onOpenPaper = vi.fn();
    const user = userEvent.setup();
    render(
      <PaperLibrary
        repository={createRepository()}
        importer={createImporter()}
        onPaperSelect={onPaperSelect}
        onOpenPaper={onOpenPaper}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Imported Paper" }),
    );

    expect(onPaperSelect).toHaveBeenCalledWith(imported);
    expect(onPaperSelect).toHaveBeenCalledOnce();
    expect(onOpenPaper).not.toHaveBeenCalled();

    await user.dblClick(screen.getByRole("button", { name: "Imported Paper" }));
    expect(onOpenPaper).toHaveBeenCalledExactlyOnceWith(imported);
    expect(onPaperSelect).toHaveBeenCalledTimes(3);
  });

  it("keeps selection and keyboard activation working without an open callback", async () => {
    const onPaperSelect = vi.fn();
    const user = userEvent.setup();
    render(<PaperLibrary repository={createRepository()} importer={createImporter()} onPaperSelect={onPaperSelect} />);
    const paper = await screen.findByRole("button", { name: "Imported Paper" });
    await user.dblClick(paper);
    expect(onPaperSelect).toHaveBeenCalledTimes(2);
    await user.keyboard("{Enter}");
    expect(onPaperSelect).toHaveBeenCalledTimes(3);
    expect(onPaperSelect).toHaveBeenLastCalledWith(imported);
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
      await screen.findByRole("button", { name: "Imported Paper 的更多操作" }),
    );
    await user.click(screen.getByRole("button", { name: "删除 Imported Paper" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Imported Paper/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Imported Paper 的更多操作" })).toHaveFocus();
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
    const menuTrigger = await screen.findByRole("button", {
      name: "Imported Paper 的更多操作",
    });

    await user.click(menuTrigger);
    await user.click(screen.getByRole("button", { name: "删除 Imported Paper" }));
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
    expect(menuTrigger).toBeVisible();
    expect(menuTrigger).toHaveFocus();
    expect(menuTrigger).toHaveAttribute("aria-expanded", "false");
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
      await screen.findByRole("button", { name: "Imported Paper 的更多操作" }),
    );
    await user.click(screen.getByRole("button", { name: "删除 Imported Paper" }));
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
      await screen.findByRole("button", { name: "Imported Paper 的更多操作" }),
    );
    await user.click(screen.getByRole("button", { name: "删除 Imported Paper" }));
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
      await screen.findByRole("button", { name: "Imported Paper 的更多操作" }),
    );
    await user.click(screen.getByRole("button", { name: "删除 Imported Paper" }));
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
      await screen.findByRole("button", { name: "Imported Paper 的更多操作" }),
    );
    await user.click(screen.getByRole("button", { name: "删除 Imported Paper" }));
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
