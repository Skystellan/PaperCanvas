import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersistenceCoordinator } from "../persistence";
import type { BoardRepository } from "./data/boardRepository";
import type { BoardNodeRecord } from "./model/boardNode";
import { Whiteboard } from "./Whiteboard";
import { fetchGithubStars } from "../library/services/githubRepository";
import { invoke } from "../../platform/core";

vi.mock("../library/services/githubRepository", () => ({ fetchGithubStars: vi.fn() }));
vi.mock("../../platform/core", () => ({ invoke: vi.fn(), isTauri: () => false }));

// Keep React Flow itself real; jsdom only needs element measurements.
beforeEach(() => {
  vi.mocked(fetchGithubStars).mockReset().mockResolvedValue(1500);
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("paperCanvas", {});
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.setAttribute("open", ""); } },
    close: { configurable: true, value() { this.removeAttribute("open"); } },
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("react-flow__node") ? 280 : 1000;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("react-flow__node") ? 128 : 700;
  });
  vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; });
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: { width: 1000, height: 700 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function setup(extraConnection = false, github: Partial<BoardNodeRecord["paper"]> = {}) {
  const nodes: BoardNodeRecord[] = (extraConnection ? ["a", "b", "c", "d"] : ["a", "b"]).map((id, i) => ({
    id, boardId: "board-default",
    paper: { id: `paper-${id}`, title: `Paper ${id}`, authors: null, year: null,
      filePath: `${id}.pdf`, domainId: null, createdAt: i, ...(id === "a" ? github : {}) },
    position: { x: i * 400, y: 100 }, size: { width: 280, height: 128 },
  }));
  const repository = {
    loadBoard: vi.fn().mockResolvedValue({ nodes, edges: [{ id: "a-b",
      boardId: "board-default", sourceNodeId: "a", targetNodeId: "b", relation: null },
      ...(extraConnection ? [{ id: "c-d", boardId: "board-default", sourceNodeId: "c", targetNodeId: "d", relation: null }] : [])] }),
    saveNodePositions: vi.fn().mockResolvedValue(undefined),
    createPaperNode: vi.fn(), createEdge: vi.fn(),
    updateEdgeRelation: vi.fn().mockResolvedValue(undefined),
    deleteEdges: vi.fn().mockResolvedValue(undefined),
    deleteNodes: vi.fn().mockResolvedValue(undefined),
    updateEdgeAnnotations: vi.fn().mockResolvedValue(undefined),
    updatePaperGithub: vi.fn().mockResolvedValue(undefined),
    updatePaperGithubStars: vi.fn().mockResolvedValue(undefined),
  } satisfies BoardRepository;
  const view = render(<PersistenceCoordinator><Whiteboard repository={repository} domains={[]} /></PersistenceCoordinator>);
  return { repository, ...view };
}

describe("real React Flow deletion", () => {
  it("opens GitHub immediately and automatically saves Stars without a dialog or another click", async () => {
    let resolve!: (stars: number) => void;
    vi.mocked(fetchGithubStars).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const githubUrl = "https://github.com/example/code";
    const { repository } = setup(false, { githubUrl, githubStars: 42 });
    const badge = await screen.findByRole("button", { name: /Paper a：已记录 GitHub 仓库/ });
    expect(fetchGithubStars).not.toHaveBeenCalled();
    fireEvent.click(badge);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_research_source", { url: githubUrl });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(badge).toHaveTextContent("★ 42");
    // Leaving for the browser must not cancel the background refresh.
    fireEvent.blur(window);
    await act(async () => resolve(1500));
    expect(repository.updatePaperGithubStars).toHaveBeenCalledExactlyOnceWith("paper-a", githubUrl, 1500);
    expect(badge).toHaveTextContent("★ 1.5K");
    expect(repository.updatePaperGithub).not.toHaveBeenCalled();
    fireEvent.click(badge);
    await waitFor(() => expect(fetchGithubStars).toHaveBeenCalledTimes(2));
  });

  it.each(["fetch", "save"])("keeps the cached Stars when background %s fails while still opening GitHub", async failure => {
    const { repository } = setup(false, { githubUrl: "https://github.com/example/code", githubStars: 42 });
    if (failure === "fetch") vi.mocked(fetchGithubStars).mockRejectedValueOnce(new Error("rate limited"));
    else repository.updatePaperGithubStars.mockRejectedValueOnce(new Error("conflict"));
    const badge = await screen.findByRole("button", { name: /Paper a：已记录 GitHub 仓库/ });
    await act(async () => fireEvent.click(badge));
    expect(invoke).toHaveBeenCalledOnce();
    expect(badge).toHaveTextContent("★ 42");
    expect(screen.queryByRole("dialog")).toBeNull();
    if (failure === "fetch") expect(repository.updatePaperGithubStars).not.toHaveBeenCalled();
  });

  it("does not apply a late refresh to a newly edited repository", async () => {
    let resolve!: (stars: number) => void;
    vi.mocked(fetchGithubStars).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const githubUrl = "https://github.com/example/code";
    const { repository } = setup(false, { githubUrl, githubStars: 42 });
    const badge = await screen.findByRole("button", { name: /Paper a：已记录 GitHub 仓库/ });
    fireEvent.click(badge);
    fireEvent.click(screen.getByText("Paper a"));
    fireEvent.click(screen.getByRole("button", { name: "编辑 GitHub 仓库" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://github.com/example/new" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => resolve(9999));
    expect(repository.updatePaperGithub).toHaveBeenCalledExactlyOnceWith("paper-a", "https://github.com/example/new", null);
    expect(badge).not.toHaveTextContent("★");
    fireEvent.click(badge);
    expect(invoke).toHaveBeenLastCalledWith("open_research_source", { url: "https://github.com/example/new" });
    await waitFor(() => expect(badge).toHaveTextContent("★ 1.5K"));
  });

  it("keeps an automatically refreshed count when an unchanged link is saved from an already open editor", async () => {
    let resolve!: (stars: number) => void;
    vi.mocked(fetchGithubStars).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const { repository } = setup(false, { githubUrl: "https://github.com/example/code", githubStars: 42 });
    const badge = await screen.findByRole("button", { name: /Paper a：已记录 GitHub 仓库/ });
    fireEvent.click(badge);
    fireEvent.click(screen.getByText("Paper a"));
    fireEvent.click(screen.getByRole("button", { name: "编辑 GitHub 仓库" }));
    await act(async () => resolve(0));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(repository.updatePaperGithub).not.toHaveBeenCalled();
    expect(badge).toHaveTextContent("★ 0");
  });

  it("adds and clears a repository from the toolbar without editing Stars or triggering a refresh", async () => {
    const user = userEvent.setup();
    const { repository } = setup();
    fireEvent.click(await screen.findByText("Paper a"));
    expect(screen.queryByRole("button", { name: /Paper a：.*GitHub/ })).toBeNull();
    expect(fetchGithubStars).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "添加 GitHub 仓库" }));
    const dialog = screen.getByRole("dialog", { name: "GitHub 仓库" });
    await user.type(within(dialog).getByRole("textbox", { name: "仓库链接" }), "https://github.com/example/code");
    repository.updatePaperGithub.mockRejectedValueOnce(new Error("offline"));
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败，输入已保留");
    expect(within(dialog).getByRole("textbox")).toHaveValue("https://github.com/example/code");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(repository.updatePaperGithub).toHaveBeenLastCalledWith("paper-a", "https://github.com/example/code", null);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "GitHub 仓库" })).toBeNull());
    expect(fetchGithubStars).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Paper a：已记录 GitHub 仓库/ })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "编辑 GitHub 仓库" }));
    expect(fetchGithubStars).not.toHaveBeenCalled();
    await user.clear(screen.getByRole("textbox", { name: "仓库链接" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(repository.updatePaperGithub).toHaveBeenLastCalledWith("paper-a", null, null);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "GitHub 仓库" })).toBeNull());
    expect(screen.queryByRole("button", { name: /Paper a：.*GitHub/ })).toBeNull();
    expect(repository.deleteNodes).not.toHaveBeenCalled();
    expect(repository.createEdge).not.toHaveBeenCalled();
  });

  it("rejects non-repository links and isolates dialog keyboard shortcuts from the canvas", async () => {
    const user = userEvent.setup();
    const { repository } = setup();
    fireEvent.click(await screen.findByText("Paper a"));
    await user.click(screen.getByRole("button", { name: "添加 GitHub 仓库" }));
    await user.type(screen.getByRole("textbox", { name: "仓库链接" }), "https://github.com.evil.test/owner/repo");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请输入 GitHub 仓库链接");
    fireEvent.keyDown(screen.getByRole("button", { name: "取消" }), { key: "Delete" });
    expect(repository.deleteNodes).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(repository.updatePaperGithub).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "GitHub 仓库" })).toBeNull();
  });

  it("keeps all connections visible and selectable while a paper remains selected", async () => {
    setup(true);
    const related = await screen.findByTestId("rf__edge-a-b");
    const unrelated = await screen.findByTestId("rf__edge-c-d");
    expect(related.querySelector(".whiteboard__edge-halo")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Paper a"));
    await waitFor(() => expect(screen.getByText("Paper a").closest(".react-flow__node")).toHaveClass("selected"));
    expect(unrelated).not.toHaveClass("is-unrelated");
    expect(related).not.toHaveClass("is-unrelated");
    fireEvent.click(unrelated.querySelector(".react-flow__edge-interaction")!);
    await waitFor(() => expect(unrelated).toHaveClass("selected"));
    expect(unrelated).not.toHaveClass("is-unrelated");
  });

  it.each(["Delete", "Backspace"])("selects an edge and deletes with %s", async (key) => {
    const { repository } = setup();
    const edge = await screen.findByTestId("rf__edge-a-b");
    fireEvent.click(edge.querySelector(".react-flow__edge-interaction")!);
    await waitFor(() => expect(edge).toHaveClass("selected"));
    fireEvent.keyDown(edge, { key });
    fireEvent.keyUp(edge, { key });
    await waitFor(() => expect(repository.deleteEdges).toHaveBeenCalledWith(["a-b"]));
    await waitFor(() => expect(screen.queryByTestId("rf__edge-a-b")).toBeNull());
  });

  it("offers a visible delete action after keyboard selection", async () => {
    const user = userEvent.setup();
    const { repository } = setup();
    const edge = await screen.findByTestId("rf__edge-a-b");
    act(() => edge.focus());
    fireEvent.keyDown(edge, { key: "Enter" });
    await user.click(await screen.findByRole("button", { name: "删除选中连线" }));
    expect(repository.deleteEdges).toHaveBeenCalledWith(["a-b"]);
    await waitFor(() => expect(screen.queryByTestId("rf__edge-a-b")).toBeNull());
  });

  it("edits the edge color inside the annotation dialog and still supports keyboard deletion", async () => {
    const user = userEvent.setup();
    const { repository } = setup();
    fireEvent.click(await screen.findByTestId("rf__edge-a-b"));
    const editor = within(screen.getByRole("dialog", { name: "连线备注" }));
    expect(editor.getByRole("group", { name: "连线颜色" })).toBeVisible();
    expect(within(screen.getByRole("toolbar", { name: "白板视图" })).queryByRole("group", { name: "连线颜色" })).toBeNull();
    expect(editor.getAllByRole("textbox")).toHaveLength(1);
    expect(editor.getByRole("textbox", { name: "批注" })).toBeVisible();
    expect(editor.queryByLabelText("证据")).toBeNull();
    await user.click(editor.getByRole("button", { name: "Support" }));
    expect(repository.updateEdgeRelation).toHaveBeenCalledWith("a-b", "support");
    expect(screen.getByTestId("rf__edge-a-b")).toHaveClass("whiteboard__edge--support");
    expect(editor.getByRole("button", { name: "Support" })).toHaveAttribute("aria-pressed", "true");
    await user.click(editor.getByRole("button", { name: "Challenge" }));
    expect(repository.updateEdgeRelation).toHaveBeenLastCalledWith("a-b", "challenge");
    expect(screen.getByTestId("rf__edge-a-b")).toHaveClass("whiteboard__edge--challenge");
    await user.click(editor.getByRole("button", { name: "未分类" }));
    expect(repository.updateEdgeRelation).toHaveBeenLastCalledWith("a-b", null);
    expect(editor.getByRole("button", { name: "未分类" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("rf__edge-a-b")).not.toHaveClass("whiteboard__edge--challenge");
    await user.keyboard("{Delete}");
    await waitFor(() => expect(repository.deleteEdges).toHaveBeenCalledWith(["a-b"]));
    await waitFor(() => expect(screen.queryByTestId("rf__edge-a-b")).toBeNull());
  });

  it("deletes selected cards and their connections through the canvas", async () => {
    const { repository } = setup();
    await screen.findByTestId("rf__edge-a-b");
    fireEvent.click(screen.getByText("Paper a"));
    const remove = await screen.findByRole("button", { name: "从白板移除选中卡片" });
    fireEvent.click(remove);
    await waitFor(() => expect(repository.deleteNodes).toHaveBeenCalledWith(["a"]));
    await waitFor(() => expect(screen.queryByText("Paper a")).toBeNull());
    expect(screen.queryByTestId("rf__edge-a-b")).toBeNull();
    expect(repository.deleteEdges).not.toHaveBeenCalled();
  });

  it("keeps the edge editor in sync when multi-selection deselects an edge", async () => {
    const { repository } = setup();
    const edge = await screen.findByTestId("rf__edge-a-b");
    fireEvent.click(edge);
    expect(screen.getByRole("group", { name: "连线颜色" })).toBeVisible();
    fireEvent.keyDown(window, { key: "Control" });
    fireEvent.click(edge, { ctrlKey: true });
    fireEvent.keyUp(window, { key: "Control" });
    expect(edge).not.toHaveClass("selected");
    expect(screen.queryByRole("group", { name: "连线颜色" })).toBeNull();
    fireEvent.keyDown(edge, { key: "Delete" });
    await act(async () => undefined);
    expect(repository.deleteEdges).not.toHaveBeenCalled();
  });

  it("deletes multiple selected cards with one keyboard request", async () => {
    const { repository } = setup();
    await screen.findByTestId("rf__edge-a-b");
    fireEvent.click(screen.getByText("Paper a"));
    fireEvent.keyDown(window, { key: "Control" });
    fireEvent.click(screen.getByText("Paper b"), { ctrlKey: true });
    fireEvent.keyUp(window, { key: "Control" });
    fireEvent.keyDown(document.body, { key: "Backspace" });
    await waitFor(() => expect(repository.deleteNodes).toHaveBeenCalledWith(["a", "b"]));
    await waitFor(() => expect(screen.queryByText("Paper a")).toBeNull());
    expect(screen.queryByText("Paper b")).toBeNull();
  });

  it("ignores deletion inside text fields and contenteditable descendants, and while inactive", async () => {
    const { repository, rerender } = setup();
    const edge = await screen.findByTestId("rf__edge-a-b");
    fireEvent.click(edge);
    fireEvent.keyDown(screen.getByLabelText("批注"), { key: "Delete" });
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    editable.innerHTML = "<span>Draft</span>";
    document.body.append(editable);
    fireEvent.keyDown(editable.firstElementChild!, { key: "Backspace" });
    editable.remove();
    await act(async () => undefined);
    expect(repository.deleteEdges).not.toHaveBeenCalled();
    rerender(<PersistenceCoordinator><Whiteboard active={false} repository={repository} domains={[]} /></PersistenceCoordinator>);
    fireEvent.keyDown(document.body, { key: "Delete" });
    await act(async () => undefined);
    expect(repository.deleteEdges).not.toHaveBeenCalled();
    expect(screen.getByTestId("rf__edge-a-b")).toBeInTheDocument();
  });

  it("deletes a saved annotated edge after returning from an inactive reader workspace", async () => {
    const { repository, rerender } = setup();
    fireEvent.click(await screen.findByTestId("rf__edge-a-b"));
    fireEvent.change(screen.getByLabelText("批注"), { target: { value: "Support" } });
    fireEvent.click(screen.getByRole("button", { name: "保存批注" }));
    await waitFor(() => expect(repository.updateEdgeAnnotations).toHaveBeenCalledWith("a-b", { explanation: "Support", evidence: "" }));
    rerender(<PersistenceCoordinator><Whiteboard active={false} repository={repository} domains={[]} /></PersistenceCoordinator>);
    rerender(<PersistenceCoordinator><Whiteboard active={true} repository={repository} domains={[]} /></PersistenceCoordinator>);
    fireEvent.click(screen.getByTestId("rf__edge-a-b"));
    act(() => (document.activeElement as HTMLElement)?.blur());
    fireEvent.keyDown(screen.getByRole("region", { name: "Paper canvas" }), { key: "Delete" });
    await waitFor(() => expect(repository.deleteEdges).toHaveBeenCalledWith(["a-b"]));
    await waitFor(() => expect(screen.queryByTestId("rf__edge-a-b")).toBeNull());
  });
});
