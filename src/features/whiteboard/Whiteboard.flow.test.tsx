import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersistenceCoordinator } from "../persistence";
import type { BoardRepository } from "./data/boardRepository";
import type { BoardNodeRecord } from "./model/boardNode";
import { Whiteboard } from "./Whiteboard";

// Keep React Flow itself real; jsdom only needs element measurements.
beforeEach(() => {
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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(extraConnection = false) {
  const nodes: BoardNodeRecord[] = (extraConnection ? ["a", "b", "c", "d"] : ["a", "b"]).map((id, i) => ({
    id, boardId: "board-default",
    paper: { id: `paper-${id}`, title: `Paper ${id}`, authors: null, year: null,
      filePath: `${id}.pdf`, domainId: null, createdAt: i },
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
  } satisfies BoardRepository;
  const view = render(<PersistenceCoordinator><Whiteboard repository={repository} domains={[]} /></PersistenceCoordinator>);
  return { repository, ...view };
}

describe("real React Flow deletion", () => {
  it("keeps straight edges selectable and dims unrelated connections when focusing a paper", async () => {
    setup(true);
    const related = await screen.findByTestId("rf__edge-a-b");
    const unrelated = await screen.findByTestId("rf__edge-c-d");
    expect(related.querySelector(".whiteboard__edge-halo")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Paper a"));
    await waitFor(() => expect(unrelated).toHaveClass("is-unrelated"));
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

  it("still deletes the selected edge after changing its relation from the toolbar", async () => {
    const user = userEvent.setup();
    const { repository } = setup();
    fireEvent.click(await screen.findByTestId("rf__edge-a-b"));
    await user.click(screen.getByRole("button", { name: "Support" }));
    expect(repository.updateEdgeRelation).toHaveBeenCalledWith("a-b", "support");
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
    expect(screen.getByRole("group", { name: "连线关系" })).toBeVisible();
    fireEvent.keyDown(window, { key: "Control" });
    fireEvent.click(edge, { ctrlKey: true });
    fireEvent.keyUp(window, { key: "Control" });
    expect(edge).not.toHaveClass("selected");
    expect(screen.queryByRole("group", { name: "连线关系" })).toBeNull();
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
    fireEvent.keyDown(screen.getByLabelText("解释"), { key: "Delete" });
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
    fireEvent.change(screen.getByLabelText("解释"), { target: { value: "Support" } });
    fireEvent.change(screen.getByLabelText("证据"), { target: { value: "Page 3" } });
    fireEvent.click(screen.getByRole("button", { name: "保存解释与证据" }));
    await waitFor(() => expect(repository.updateEdgeAnnotations).toHaveBeenCalledWith("a-b", { explanation: "Support", evidence: "Page 3" }));
    rerender(<PersistenceCoordinator><Whiteboard active={false} repository={repository} domains={[]} /></PersistenceCoordinator>);
    rerender(<PersistenceCoordinator><Whiteboard active={true} repository={repository} domains={[]} /></PersistenceCoordinator>);
    fireEvent.click(screen.getByTestId("rf__edge-a-b"));
    act(() => (document.activeElement as HTMLElement)?.blur());
    fireEvent.keyDown(screen.getByRole("region", { name: "Paper canvas" }), { key: "Delete" });
    await waitFor(() => expect(repository.deleteEdges).toHaveBeenCalledWith(["a-b"]));
    await waitFor(() => expect(screen.queryByTestId("rf__edge-a-b")).toBeNull());
  });
});
