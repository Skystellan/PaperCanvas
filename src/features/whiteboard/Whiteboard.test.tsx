import type { DragEvent, ReactNode } from "react";
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi, type Mocked } from "vitest";
import type { PersistenceWriter } from "../persistence";
import type { BoardRepository } from "./data/boardRepository";
import type { BoardEdgeRecord } from "./model/boardEdge";
import type { BoardNodeRecord, PaperFlowNode } from "./model/boardNode";

const flow = vi.hoisted(() => ({
  fitView: vi.fn(),
  setCenter: vi.fn(),
  deleteElements: vi.fn(),
  getZoom: vi.fn(() => 1),
  screenToFlowPosition: vi.fn(({ x, y }: { x: number; y: number }) => ({ x, y })),
}));

const persistence = vi.hoisted(() => ({
  writer: undefined as PersistenceWriter | undefined,
}));

const motion = vi.hoisted(() => ({
  callback: null as FrameRequestCallback | null,
  nextId: 1,
}));

vi.mock("../persistence", () => ({
  usePersistenceWriter: (_name: string, writer: PersistenceWriter) => {
    persistence.writer = writer;
  },
}));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();

  return {
    ...actual,
    useReactFlow: () => ({
      fitView: flow.fitView,
      setCenter: flow.setCenter,
      deleteElements: flow.deleteElements,
      getZoom: flow.getZoom,
      screenToFlowPosition: flow.screenToFlowPosition,
    }),
    ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
    ReactFlow: ({
      nodes,
      edges,
      onNodesChange,
      onEdgesChange,
      onNodeDragStart,
      onNodeDrag,
      onNodeDragStop,
      onNodeClick,
      onEdgeClick,
      onBeforeDelete,
      onDrop,
      onDragOver,
      onNodeDoubleClick,
      nodesConnectable,
      nodesDraggable,
      connectOnClick,
      panActivationKeyCode,
      panOnScroll,
      panOnScrollMode,
      panOnScrollSpeed,
      zoomOnPinch,
      zoomOnScroll,
      children,
    }: {
      nodes: PaperFlowNode[];
      edges: Array<{
        ariaLabel?: string;
        className?: string;
        id: string;
        source: string;
        target: string;
        type?: string;
      }>;
      onNodesChange: (changes: Array<Record<string, unknown>>) => void;
      onEdgesChange: (changes: Array<Record<string, unknown>>) => void;
      onNodeDragStart?: (
        event: unknown,
        node: PaperFlowNode,
        nodes: PaperFlowNode[],
      ) => void;
      onNodeDrag: (
        event: unknown,
        node: PaperFlowNode,
        nodes: PaperFlowNode[],
      ) => void;
      onNodeDragStop: (
        event: unknown,
        node: PaperFlowNode,
        nodes: PaperFlowNode[],
      ) => void;
      onNodeClick?: (event: unknown, node: PaperFlowNode) => void;
      onEdgeClick?: (event: unknown, edge: (typeof edges)[number]) => void;
      onBeforeDelete: (items: {
        nodes: PaperFlowNode[];
        edges: Array<{ id: string; source: string; target: string }>;
      }) => Promise<boolean | { nodes: PaperFlowNode[]; edges: typeof edges }>;
      onDrop: (event: DragEvent<HTMLDivElement>) => void;
      onDragOver: (event: DragEvent<HTMLDivElement>) => void;
      onNodeDoubleClick: (event: unknown, node: PaperFlowNode) => void;
      nodesConnectable: boolean;
      nodesDraggable: boolean;
      connectOnClick: boolean;
      panActivationKeyCode?: string | string[] | null;
      panOnScroll: boolean;
      panOnScrollMode: string;
      panOnScrollSpeed: number;
      zoomOnPinch: boolean;
      zoomOnScroll: boolean;
      children: ReactNode;
    }) => {
      flow.deleteElements.mockImplementation(async (selection: { nodes: PaperFlowNode[]; edges: typeof edges }) => {
        const nodeIds = new Set(selection.nodes.map(({ id }) => id));
        const matchingEdges = edges.filter((edge) => selection.edges.some(({ id }) => id === edge.id) || nodeIds.has(edge.source) || nodeIds.has(edge.target));
        const result = await onBeforeDelete({ nodes: selection.nodes, edges: matchingEdges });
        const removed = typeof result === "boolean" ? result ? { nodes: selection.nodes, edges: matchingEdges } : { nodes: [], edges: [] } : result;
        onEdgesChange(removed.edges.map(({ id }) => ({ id, type: "remove" })));
        onNodesChange(removed.nodes.map(({ id }) => ({ id, type: "remove" })));
      });
      const first = nodes[0];
      const second = nodes[1];
      const nearFirst =
        first && second
          ? {
              ...first,
              position: {
                x: second.position.x - 280 - 80,
                y: second.position.y,
              },
            }
          : null;
      const draggedFirst =
        first && second
          ? { ...first, position: { x: 300, y: second.position.y } }
          : null;
      const selectedFirst = first
        ? {
            ...first,
            position: {
              x: first.position.x + 20,
              y: first.position.y + 10,
            },
          }
        : null;
      const selectedSecond = second
        ? {
            ...second,
            position: {
              x: second.position.x + 20,
              y: second.position.y + 10,
            },
          }
        : null;
      const selectedNodes = nodes.map((node) => ({
        ...node,
        position: {
          x: node.position.x + 20,
          y: node.position.y + 10,
        },
      }));

      return (
      <div
        data-testid="react-flow"
        data-nodes-connectable={nodesConnectable}
        data-nodes-draggable={nodesDraggable}
        data-connect-on-click={connectOnClick}
        data-pan-activation-key-code={String(panActivationKeyCode)}
        data-pan-on-scroll={panOnScroll}
        data-pan-on-scroll-mode={panOnScrollMode}
        data-pan-on-scroll-speed={panOnScrollSpeed}
        data-zoom-on-pinch={zoomOnPinch}
        data-zoom-on-scroll={zoomOnScroll}
        onDrop={onDrop}
        onDragOver={onDragOver}
      >
        {nodes.map((node) => (
          <div key={node.id}>
            <button
              type="button"
              onClick={() => {
                onNodesChange(nodes.map(({ id }) => ({ id, type: "select", selected: id === node.id })));
                onEdgesChange(edges.map(({ id }) => ({ id, type: "select", selected: false })));
                onNodeClick?.({}, node);
              }}
              onDoubleClick={() => onNodeDoubleClick({}, node)}
            >
              {node.data.paper.title}
            </button>
            <output data-testid={`position-${node.id}`}>
              {node.position.x},{node.position.y}
            </output>
            <output data-testid={`class-${node.id}`}>{node.className ?? ""}</output>
            <button
              type="button"
              aria-label={`Move ${node.data.paper.title}`}
              onClick={() =>
                onNodesChange([
                  {
                    id: node.id,
                    type: "position",
                    position: {
                      x: node.position.x + 40,
                      y: node.position.y + 24,
                    },
                    dragging: false,
                  },
                ])
              }
            >
              Move
            </button>
            <button
              type="button"
              aria-label={`Drag ${node.data.paper.title}`}
              onClick={() =>
                onNodesChange([
                  {
                    id: node.id,
                    type: "position",
                    position: {
                      x: node.position.x + 20,
                      y: node.position.y + 10,
                    },
                    dragging: true,
                  },
                ])
              }
            >
              Drag
            </button>
          </div>
        ))}
        {nearFirst && first && (
          <>
          <button
            type="button"
            aria-label={`Approach ${first.data.paper.title}`}
            onClick={() => onNodeDrag({}, nearFirst, [nearFirst])}
          >
            Approach
          </button>
          <button
            type="button"
            aria-label={`Release near ${first.data.paper.title}`}
            onClick={() => onNodeDragStop({}, nearFirst, [nearFirst])}
          >
            Release
          </button>
          </>
        )}
        {draggedFirst && first && second && (
          <>
            <button
              type="button"
              aria-label={`Push ${first.data.paper.title} into ${second.data.paper.title}`}
              onClick={() => {
                onNodeDragStart?.({}, first, [first]);
                onNodesChange([
                  {
                    dragging: true,
                    id: first.id,
                    position: draggedFirst.position,
                    type: "position",
                  },
                ]);
                onNodeDrag({}, draggedFirst, [draggedFirst]);
              }}
            >
              Push
            </button>
            <button
              type="button"
              aria-label={`Release drag ${first.data.paper.title}`}
              onClick={() => {
                onNodesChange([
                  {
                    dragging: false,
                    id: first.id,
                    position: first.position,
                    type: "position",
                  },
                ]);
                onNodeDragStop({}, first, [first]);
              }}
            >
              Release drag
            </button>
          </>
        )}
        {selectedFirst && selectedSecond && first && second && (
          <>
            <button
              type="button"
              aria-label="Drag selected cards"
              onClick={() => {
                onNodeDragStart?.({}, first, [first, second]);
                onNodesChange([
                  {
                    dragging: true,
                    id: first.id,
                    position: selectedFirst.position,
                    type: "position",
                  },
                  {
                    dragging: true,
                    id: second.id,
                    position: selectedSecond.position,
                    type: "position",
                  },
                ]);
                onNodeDrag({}, selectedFirst, [selectedFirst, selectedSecond]);
              }}
            >
              Drag selection
            </button>
            <button
              type="button"
              aria-label="Release selected cards"
              onClick={() => {
                const releasedSecond = {
                  ...second,
                  position: { ...second.position, x: second.position.x + 1 },
                };
                onNodesChange([
                  {
                    dragging: false,
                    id: first.id,
                    position: first.position,
                    type: "position",
                  },
                  {
                    dragging: false,
                    id: second.id,
                    position: releasedSecond.position,
                    type: "position",
                  },
                ]);
                onNodeDragStop({}, first, [first, releasedSecond]);
              }}
            >
              Release selection
            </button>
          </>
        )}
        {first && (
          <>
            <button
              type="button"
              aria-label="Drag all cards"
              onClick={() => {
                onNodeDragStart?.({}, first, nodes);
                onNodesChange(
                  selectedNodes.map((node) => ({
                    dragging: true,
                    id: node.id,
                    position: node.position,
                    type: "position",
                  })),
                );
                onNodeDrag({}, selectedNodes[0], selectedNodes);
              }}
            >
              Drag all
            </button>
            <button
              type="button"
              aria-label="Release all cards"
              onClick={() => {
                onNodesChange(
                  nodes.map((node) => ({
                    dragging: false,
                    id: node.id,
                    position: node.position,
                    type: "position",
                  })),
                );
                onNodeDragStop({}, first, nodes);
              }}
            >
              Release all
            </button>
          </>
        )}
        {edges.map((edge) => (
          <div key={edge.id}>
            <output
              data-testid={`edge-${edge.id}`}
              data-edge-class={edge.className ?? ""}
              data-edge-label={edge.ariaLabel ?? ""}
              data-edge-type={edge.type ?? ""}
            >
              {edge.source}-{edge.target}
            </output>
            <button
              type="button"
              aria-label={`Select ${edge.id}`}
              onClick={() => {
                onEdgesChange(edges.map(({ id }) => ({ id, type: "select", selected: id === edge.id })));
                onEdgeClick?.({}, edge);
              }}
            >
              Select
            </button>
            <button
              type="button"
              aria-label={`Keyboard select ${edge.id}`}
              onClick={() =>
                onEdgesChange([{ id: edge.id, type: "select", selected: true }])
              }
            >
              Keyboard select
            </button>
            <button
              type="button"
              aria-label={`Delete ${edge.id}`}
              onClick={() => {
                void onBeforeDelete({ nodes: [], edges: [edge] }).then((result) => {
                  const allowed =
                    typeof result === "boolean" ? result : result.edges.length > 0;
                  if (allowed) onEdgesChange([{ id: edge.id, type: "remove" }]);
                });
              }}
            >
              Delete
            </button>
          </div>
        ))}
        {children}
      </div>
      );
    },
    Background: () => null,
    Controls: () => null,
    ViewportPortal: ({ children }: { children: ReactNode }) => children,
  };
});

import { PAPER_DRAG_MIME, Whiteboard } from "./Whiteboard";

const firstNode: BoardNodeRecord = {
  id: "node-attention",
  boardId: "board-default",
  paper: {
    id: "paper-attention",
    title: "Attention Is All You Need",
    authors: "Vaswani et al.",
    year: 2017,
    filePath: "papers/attention.pdf",
    domainId: "domain-transformers",
    createdAt: 1,
  },
  position: { x: 120, y: 110 },
  size: { width: 280, height: 128 },
};

const secondNode: BoardNodeRecord = {
  id: "node-bert",
  boardId: "board-default",
  paper: {
    id: "paper-bert",
    title: "BERT",
    authors: "Devlin et al.",
    year: 2019,
    filePath: "papers/bert.pdf",
    domainId: "domain-transformers",
    createdAt: 2,
  },
  position: { x: 520, y: 245 },
  size: { width: 280, height: 128 },
};

const firstEdge: BoardEdgeRecord = {
  id: "edge-attention-bert",
  boardId: "board-default",
  sourceNodeId: "node-attention",
  targetNodeId: "node-bert",
  relation: null,
  explanation: "",
  evidence: "",
};

function createRepository() {
  const repository = {
    loadBoard: vi.fn().mockResolvedValue({ nodes: [firstNode], edges: [] }),
    saveNodePositions: vi.fn().mockResolvedValue(undefined),
    createPaperNode: vi.fn().mockResolvedValue(secondNode),
    createEdge: vi.fn().mockResolvedValue(firstEdge),
    updateEdgeRelation: vi.fn().mockResolvedValue(undefined),
    updateEdgeAnnotations: vi.fn().mockResolvedValue(undefined),
    deleteNodes: vi.fn().mockResolvedValue(undefined),
    deleteEdges: vi.fn().mockResolvedValue(undefined),
  };
  return repository as typeof repository & Mocked<BoardRepository>;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function dropPaper(paperId: string, clientX = 10, clientY = 20) {
  const target = screen.getByTestId("react-flow");
  const event = createEvent.drop(target);
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY },
    dataTransfer: {
      value: {
        getData: (type: string) =>
          type === PAPER_DRAG_MIME ? paperId : "",
      },
    },
  });
  fireEvent(target, event);
}

function renderedPosition(nodeId: string) {
  const [x, y] = screen
    .getByTestId(`position-${nodeId}`)
    .textContent!.split(",")
    .map(Number);
  return { x, y };
}

function renderedDomainFrame(domainId: string) {
  const frame = screen.getByTestId(`domain-frame-${domainId}`);
  const coordinates = frame.style.transform.match(
    /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/,
  );
  return {
    x: Number(coordinates?.[1]),
    y: Number(coordinates?.[2]),
    width: Number.parseFloat(frame.style.width),
    height: Number.parseFloat(frame.style.height),
  };
}

function expectRenderedNodesNotToOverlap(
  nodeIds: readonly string[],
  gap = 0,
) {
  const width = 280;
  const height = 128;
  for (let firstIndex = 0; firstIndex < nodeIds.length; firstIndex += 1) {
    const first = renderedPosition(nodeIds[firstIndex]);
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < nodeIds.length;
      secondIndex += 1
    ) {
      const second = renderedPosition(nodeIds[secondIndex]);
      const separated =
        first.x + width + gap <= second.x ||
        second.x + width + gap <= first.x ||
        first.y + height + gap <= second.y ||
        second.y + height + gap <= first.y;
      expect(
        separated,
        `${nodeIds[firstIndex]} ${JSON.stringify(first)} overlaps ${nodeIds[secondIndex]} ${JSON.stringify(second)}`,
      ).toBe(true);
    }
  }
}

describe("Whiteboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    motion.callback = null;
    motion.nextId = 1;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        motion.callback = callback;
        const id = motion.nextId;
        motion.nextId += 1;
        return id;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false }) as MediaQueryList),
    );
    persistence.writer = undefined;
    flow.getZoom.mockReturnValue(1);
    flow.fitView.mockResolvedValue(true);
    flow.screenToFlowPosition.mockImplementation(({ x, y }) => ({ x, y }));
  });

  it("focuses an existing card across scopes, repeats requests, and does not add absent papers", async () => {
    const repository = createRepository();
    const domains = [{ id: "domain-transformers", name: "Transformers" }];
    const view = render(<Whiteboard repository={repository} domains={domains} />);
    await screen.findByText(firstNode.paper.title);
    fireEvent.click(screen.getByRole("button", { name: "未分区" }));
    expect(screen.queryByText(firstNode.paper.title)).toBeNull();
    view.rerender(<Whiteboard repository={repository} domains={domains}
      paperFocusRequest={{ paperId: firstNode.paper.id, revision: 1 }} />);
    expect(await screen.findByText(firstNode.paper.title)).toBeVisible();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "从白板移除选中卡片" })).toBeVisible();
    expect(flow.setCenter).toHaveBeenCalledWith(260, 174, { zoom: 1, duration: 300 });
    view.rerender(<Whiteboard repository={repository} domains={domains}
      paperFocusRequest={{ paperId: firstNode.paper.id, revision: 2 }} />);
    expect(flow.setCenter).toHaveBeenCalledTimes(2);
    view.rerender(<Whiteboard repository={repository} domains={domains}
      paperFocusRequest={{ paperId: "absent", revision: 3 }} />);
    expect(flow.setCenter).toHaveBeenCalledTimes(2);
    expect(repository.createPaperNode).not.toHaveBeenCalled();
    expect(repository.saveNodePositions).not.toHaveBeenCalled();
  });

  it("waits for loading before handling a paper focus request", async () => {
    const repository = createRepository();
    const loading = deferred<{ nodes: BoardNodeRecord[]; edges: BoardEdgeRecord[] }>();
    repository.loadBoard.mockReturnValue(loading.promise);
    render(<Whiteboard repository={repository} paperFocusRequest={{ paperId: firstNode.paper.id, revision: 1 }} />);
    expect(flow.setCenter).not.toHaveBeenCalled();
    await act(async () => loading.resolve({ nodes: [firstNode], edges: [] }));
    expect(flow.setCenter).toHaveBeenCalledOnce();
  });

  it("keeps annotation drafts across selection, retries errors, and flushes the latest edit before navigation", async () => {
    const repository = createRepository();
    repository.loadBoard.mockResolvedValue({ nodes: [firstNode, secondNode], edges: [firstEdge] });
    render(<Whiteboard repository={repository} />);
    fireEvent.click(await screen.findByRole("button", { name: `Select ${firstEdge.id}` }));
    fireEvent.change(screen.getByLabelText("解释"), { target: { value: "Same result" } });
    fireEvent.change(screen.getByLabelText("证据"), { target: { value: "Page 4" } });
    expect(persistence.writer?.isDirty()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: firstNode.paper.title }));
    expect(screen.queryByLabelText("解释")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `Select ${firstEdge.id}` }));
    expect(screen.getByLabelText("解释")).toHaveValue("Same result");
    repository.updateEdgeAnnotations.mockRejectedValueOnce(new Error("disk full"));
    await act(async () => {
      await expect(persistence.writer!.flush()).rejects.toThrow("disk full");
    });
    expect(screen.getByRole("alert")).toHaveTextContent("草稿已保留");
    expect(persistence.writer?.isDirty()).toBe(true);

    const saving = deferred<void>();
    repository.updateEdgeAnnotations.mockReturnValueOnce(saving.promise);
    fireEvent.click(screen.getByRole("button", { name: "重试保存解释与证据" }));
    fireEvent.change(screen.getByLabelText("解释"), { target: { value: "Latest explanation" } });
    await act(async () => { saving.resolve(); await persistence.writer!.flush(); });
    expect(repository.updateEdgeAnnotations).toHaveBeenLastCalledWith(firstEdge.id, {
      explanation: "Latest explanation", evidence: "Page 4",
    });
    expect(persistence.writer?.isDirty()).toBe(false);
    expect(screen.getByLabelText("解释")).toHaveValue("Latest explanation");
  });

  it("drains position saves before removing a card, retains failed deletions, and allows drag-back", async () => {
    const repository = createRepository();
    const saving = deferred<void>();
    repository.saveNodePositions.mockReturnValueOnce(saving.promise);
    repository.deleteNodes.mockRejectedValueOnce(new Error("busy"));
    const view = render(<Whiteboard repository={repository} />);
    fireEvent.click(await screen.findByRole("button", { name: `Move ${firstNode.paper.title}` }));
    fireEvent.click(screen.getByRole("button", { name: firstNode.paper.title }));
    fireEvent.click(screen.getByRole("button", { name: "从白板移除选中卡片" }));
    expect(repository.deleteNodes).not.toHaveBeenCalled();
    await act(async () => saving.resolve());
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be removed");
    expect(screen.getByText(firstNode.paper.title)).toBeVisible();
    fireEvent.keyDown(document.body, { key: "Delete" });
    await waitFor(() => expect(screen.queryByText(firstNode.paper.title)).toBeNull());
    repository.loadBoard.mockResolvedValue({ nodes: [], edges: [] });
    view.rerender(<Whiteboard repository={repository} paperCatalogChange={{ kind: "organized", paperIds: [], revision: 1 }} />);
    await waitFor(() => expect(repository.loadBoard).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(firstNode.paper.title)).toBeNull();
    repository.createPaperNode.mockResolvedValueOnce(firstNode);
    dropPaper(firstNode.paper.id);
    expect(await screen.findByText(firstNode.paper.title)).toBeVisible();
    expect(repository.createPaperNode).toHaveBeenCalledOnce();
  });

  it("loads persisted cards and ordinary edges as one board", async () => {
    const repository = createRepository();
    repository.loadBoard.mockResolvedValue({
      nodes: [firstNode, secondNode],
      edges: [firstEdge],
    });

    render(<Whiteboard repository={repository} />);

    expect(screen.getByRole("status")).toHaveTextContent("Opening canvas");
    expect(await screen.findByText("Attention Is All You Need")).toBeVisible();
    expect(screen.getByTestId("edge-edge-attention-bert")).toHaveTextContent(
      "node-attention-node-bert",
    );
  });

  it("keeps saved node positions without scheduling a load animation", async () => {
    const repository = createRepository();
    const farNode: BoardNodeRecord = {
      ...secondNode,
      position: { x: 920, y: 110 },
    };
    repository.loadBoard.mockResolvedValue({
      nodes: [firstNode, farNode],
      edges: [firstEdge],
    });
    render(<Whiteboard repository={repository} />);
    await screen.findByText("BERT");

    expect(motion.callback).toBeNull();
    expect(renderedPosition(firstNode.id)).toEqual(firstNode.position);
    expect(renderedPosition(farNode.id)).toEqual(farNode.position);
    expect(repository.saveNodePositions).not.toHaveBeenCalled();
  });

  it("does not animate saved positions when reduced motion is requested", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as MediaQueryList),
    );
    const repository = createRepository();
    repository.loadBoard.mockResolvedValue({
      nodes: [firstNode, { ...secondNode, position: { x: 920, y: 110 } }],
      edges: [firstEdge],
    });
    render(<Whiteboard repository={repository} />);
    await screen.findByText("BERT");

    expect(motion.callback).toBeNull();
    expect(repository.saveNodePositions).not.toHaveBeenCalled();
  });

  it("repairs saved intersecting regions without mixing their member nodes", async () => {
    const repository = createRepository();
    const records: BoardNodeRecord[] = [
      { ...firstNode, position: { x: 0, y: 0 } },
      {
        ...firstNode,
        id: "node-a-two",
        paper: { ...firstNode.paper, id: "paper-a-two", title: "A Two" },
        position: { x: 1_000, y: 1_000 },
      },
      {
        ...secondNode,
        id: "node-b-one",
        paper: {
          ...secondNode.paper,
          id: "paper-b-one",
          title: "B One",
          domainId: "domain-vision",
        },
        position: { x: 0, y: 1_000 },
      },
      {
        ...secondNode,
        id: "node-b-two",
        paper: {
          ...secondNode.paper,
          id: "paper-b-two",
          title: "B Two",
          domainId: "domain-vision",
        },
        position: { x: 1_000, y: 0 },
      },
    ];
    repository.loadBoard.mockResolvedValue({ nodes: records, edges: [] });
    render(
      <Whiteboard
        repository={repository}
        domains={[
          { id: "domain-transformers", name: "领域 A" },
          { id: "domain-vision", name: "领域 B" },
        ]}
      />,
    );
    await screen.findByText("B Two");

    expect(motion.callback).toBeNull();
    const first = renderedDomainFrame("domain-transformers");
    const second = renderedDomainFrame("domain-vision");
    expect(first.x + first.width <= second.x || second.x + second.width <= first.x ||
      first.y + first.height <= second.y || second.y + second.height <= first.y).toBe(true);
    for (const record of records) {
      const frame = record.paper.domainId === "domain-transformers" ? first : second;
      const position = renderedPosition(record.id);
      expect(position.x).toBeGreaterThan(frame.x);
      expect(position.y).toBeGreaterThan(frame.y);
      expect(position.x + record.size.width).toBeLessThan(frame.x + frame.width);
      expect(position.y + record.size.height).toBeLessThan(frame.y + frame.height);
    }
    await waitFor(() => expect(repository.saveNodePositions).toHaveBeenCalledOnce());
  });

  it("cools a drag without relocating whole domains on its final frame", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const visionNode: BoardNodeRecord = {
      ...secondNode,
      paper: { ...secondNode.paper, domainId: "domain-vision" },
    };
    repository.loadBoard.mockResolvedValue({
      nodes: [firstNode, visionNode],
      edges: [],
    });
    render(
      <Whiteboard
        repository={repository}
        domains={[
          { id: "domain-transformers", name: "领域 A" },
          { id: "domain-vision", name: "领域 B" },
        ]}
      />,
    );
    await screen.findByText("BERT");

    await user.click(
      screen.getByRole("button", {
        name: "Push Attention Is All You Need into BERT",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Release drag Attention Is All You Need" }),
    );
    let previous = [renderedPosition(firstNode.id), renderedPosition(visionNode.id)];
    for (let frame = 0; frame < 300 && motion.callback; frame += 1) {
      const callback = motion.callback;
      motion.callback = null;
      act(() => callback?.(frame * 16));
      const positions = [renderedPosition(firstNode.id), renderedPosition(visionNode.id)];
      positions.forEach((position, index) => {
        expect(Math.hypot(position.x - previous[index].x, position.y - previous[index].y)).toBeLessThan(40);
      });
      previous = positions;
    }
    expect(motion.callback).toBeNull();
    await act(async () => persistence.writer?.flush());
    expect(repository.saveNodePositions).toHaveBeenLastCalledWith([
      { id: firstNode.id, ...previous[0] },
      { id: visionNode.id, ...previous[1] },
    ]);
  });

  it("moves the background with a freely dragged node and smoothly yields neighboring regions", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const pushedNode: BoardNodeRecord = {
      ...secondNode,
      paper: { ...secondNode.paper, domainId: "domain-pushed" },
    };
    const fixedNode: BoardNodeRecord = {
      ...secondNode,
      id: "node-fixed",
      paper: {
        ...secondNode.paper,
        id: "paper-fixed",
        title: "Fixed Paper",
        domainId: "domain-fixed",
      },
      position: { x: 960, y: 245 },
    };
    repository.loadBoard.mockResolvedValue({
      nodes: [firstNode, pushedNode, fixedNode],
      edges: [{ ...firstEdge, targetNodeId: pushedNode.id }],
    });
    render(
      <Whiteboard
        repository={repository}
        domains={[
          { id: "domain-transformers", name: "领域 A" },
          { id: "domain-pushed", name: "领域 B" },
          { id: "domain-fixed", name: "领域 C" },
        ]}
      />,
    );
    await screen.findByText("Fixed Paper");
    const pushedPosition = renderedPosition(pushedNode.id);
    const fixedPosition = renderedPosition(fixedNode.id);
    const frames = ["domain-transformers", "domain-pushed", "domain-fixed"].map(renderedDomainFrame);

    await user.click(
      screen.getByRole("button", {
        name: "Push Attention Is All You Need into BERT",
      }),
    );
    expect(renderedPosition(pushedNode.id)).toEqual(pushedPosition);
    expect(renderedPosition(firstNode.id)).toEqual({ x: 300, y: pushedPosition.y });
    const movedFrame = renderedDomainFrame("domain-transformers");
    expect(movedFrame.x).toBe(300 - 48);
    expect(movedFrame.y).toBe(pushedPosition.y - 48);
    expect(movedFrame).not.toEqual(frames[0]);
    let previous = [pushedPosition, fixedPosition];
    for (let frame = 0; frame < 90; frame += 1) {
      const callback = motion.callback;
      motion.callback = null;
      act(() => callback?.(frame * 16));
      const positions = [renderedPosition(pushedNode.id), renderedPosition(fixedNode.id)];
      positions.forEach((position, index) => {
        expect(Math.hypot(position.x - previous[index].x, position.y - previous[index].y)).toBeLessThanOrEqual(24.00001);
      });
      previous = positions;
      expect(renderedPosition(firstNode.id)).toEqual({ x: 300, y: pushedPosition.y });
    }
    expect(renderedPosition(pushedNode.id)).not.toEqual(pushedPosition);
    const activeFrame = renderedDomainFrame("domain-transformers");
    const otherFrame = renderedDomainFrame("domain-pushed");
    expect(activeFrame.x + activeFrame.width <= otherFrame.x || otherFrame.x + otherFrame.width <= activeFrame.x ||
      activeFrame.y + activeFrame.height <= otherFrame.y || otherFrame.y + otherFrame.height <= activeFrame.y).toBe(true);
    await user.click(
      screen.getByRole("button", { name: "Release drag Attention Is All You Need" }),
    );
    await act(async () => persistence.writer?.flush());
    expectRenderedNodesNotToOverlap([firstNode.id, pushedNode.id, fixedNode.id]);
    for (const domainId of ["domain-transformers", "domain-pushed", "domain-fixed"]) {
      const frame = renderedDomainFrame(domainId);
      expect(Number.isFinite(frame.x + frame.y + frame.width + frame.height)).toBe(true);
    }
  });

  it("keeps every card mutually exclusive at the settled force targets", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const leftNode = {
      ...firstNode,
      position: { x: 0, y: 0 },
    };
    const rightNode = {
      ...secondNode,
      position: { x: 800, y: 0 },
    };
    const blockerNode: BoardNodeRecord = {
      ...secondNode,
      id: "node-blocker",
      paper: {
        ...secondNode.paper,
        id: "paper-blocker",
        title: "Blocker",
        createdAt: 3,
      },
      position: { x: 480, y: 0 },
    };
    repository.loadBoard.mockResolvedValue({
      nodes: [leftNode, rightNode, blockerNode],
      edges: [firstEdge],
    });
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Blocker");
    await user.click(screen.getByRole("button", { name: "重新整理布局" }));

    await act(async () => persistence.writer?.flush());

    expectRenderedNodesNotToOverlap([
      leftNode.id,
      rightNode.id,
      blockerNode.id,
    ]);
  });

  it("moves cards continuously while collisions settle", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const leftNode = {
      ...firstNode,
      position: { x: 0, y: 0 },
    };
    const rightNode = {
      ...secondNode,
      position: { x: 800, y: 0 },
    };
    const blockerNode: BoardNodeRecord = {
      ...secondNode,
      id: "node-blocker",
      paper: {
        ...secondNode.paper,
        id: "paper-blocker",
        title: "Blocker",
        createdAt: 3,
      },
      position: { x: 480, y: 0 },
    };
    repository.loadBoard.mockResolvedValue({
      nodes: [leftNode, rightNode, blockerNode],
      edges: [firstEdge],
    });
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Blocker");
    await user.click(screen.getByRole("button", { name: "重新整理布局" }));

    const nodeIds = [leftNode.id, rightNode.id, blockerNode.id];
    let previous = nodeIds.map(renderedPosition);
    for (let frame = 1; frame <= 300 && motion.callback; frame += 1) {
      const callback = motion.callback;
      motion.callback = null;
      act(() => callback?.(frame * 16));
      const positions = nodeIds.map(renderedPosition);
      positions.forEach((position, index) => {
        expect(Math.hypot(position.x - previous[index].x, position.y - previous[index].y)).toBeLessThan(60);
      });
      previous = positions;
    }
    expect(motion.callback).toBeNull();
    expectRenderedNodesNotToOverlap(nodeIds);
  });

  it("keeps a dragged card group rigid and releases it into the cooling layout", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const nodes: BoardNodeRecord[] = [
      { ...firstNode, id: "a", position: { x: 0, y: 0 } },
      { ...secondNode, id: "b", position: { x: 1_000, y: 0 } },
      { ...firstNode, id: "c", position: { x: 304, y: 48 } },
      { ...secondNode, id: "d", position: { x: 1_304, y: 48 } },
    ];
    repository.loadBoard.mockResolvedValue({
      nodes,
      edges: [
        {
          boardId: "board-default",
          id: "edge-ab",
          sourceNodeId: "a",
          targetNodeId: "b",
        },
        {
          boardId: "board-default",
          id: "edge-cd",
          sourceNodeId: "c",
          targetNodeId: "d",
        },
      ],
    });
    render(<Whiteboard repository={repository} />);
    await screen.findByTestId("position-d");
    await user.click(screen.getByRole("button", { name: "Drag all cards" }));
    const dragFrame = motion.callback;
    act(() => dragFrame?.(16));
    expect(renderedPosition("c").y - renderedPosition("a").y).toBe(48);
    expect(renderedPosition("d").y - renderedPosition("b").y).toBe(48);

    const heldPositions = nodes.map(({ id }) => renderedPosition(id));
    await user.click(screen.getByRole("button", { name: "Release all cards" }));
    const releaseFrame = motion.callback;
    act(() => releaseFrame?.(32));
    expect(nodes.map(({ id }) => renderedPosition(id))).not.toEqual(heldPositions);
  });

  it("reloads the existing canvas for each new deleted catalog revision", async () => {
    const repository = createRepository();
    repository.loadBoard
      .mockResolvedValueOnce({
        nodes: [firstNode, secondNode],
        edges: [firstEdge],
      })
      .mockResolvedValue({ nodes: [firstNode], edges: [] });
    const { rerender } = render(
      <Whiteboard repository={repository} paperCatalogChange={null} />,
    );
    await screen.findByText("BERT");
    const flowCanvas = screen.getByTestId("react-flow");
    expect(repository.loadBoard).toHaveBeenCalledOnce();

    rerender(
      <Whiteboard
        repository={repository}
        paperCatalogChange={{
          kind: "imported",
          paperIds: ["paper-new"],
          revision: 1,
        }}
      />,
    );
    await act(async () => Promise.resolve());
    expect(repository.loadBoard).toHaveBeenCalledOnce();

    const deletion = {
      kind: "deleted" as const,
      paperIds: ["paper-bert"],
      revision: 2,
    };
    rerender(
      <Whiteboard
        repository={repository}
        paperCatalogChange={deletion}
      />,
    );
    await waitFor(() => expect(repository.loadBoard).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("BERT")).not.toBeInTheDocument());
    expect(screen.getByTestId("react-flow")).toBe(flowCanvas);

    rerender(
      <Whiteboard
        repository={repository}
        paperCatalogChange={{ ...deletion }}
      />,
    );
    await act(async () => Promise.resolve());
    expect(repository.loadBoard).toHaveBeenCalledTimes(2);
  });

  it("ignores an in-flight position save from before a deletion reload", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const oldSave = deferred<void>();
    repository.loadBoard
      .mockResolvedValueOnce({
        nodes: [firstNode, secondNode],
        edges: [],
      })
      .mockResolvedValue({ nodes: [firstNode], edges: [] });
    repository.saveNodePositions
      .mockReturnValueOnce(oldSave.promise)
      .mockResolvedValue(undefined);
    const { rerender } = render(
      <Whiteboard repository={repository} paperCatalogChange={null} />,
    );
    await screen.findByText("BERT");

    await user.click(
      screen.getByRole("button", { name: "Move Attention Is All You Need" }),
    );
    await waitFor(() => expect(repository.saveNodePositions).toHaveBeenCalledOnce());

    rerender(
      <Whiteboard
        repository={repository}
        paperCatalogChange={{
          kind: "deleted",
          paperIds: ["paper-bert"],
          revision: 1,
        }}
      />,
    );
    await waitFor(() => expect(repository.loadBoard).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("BERT")).not.toBeInTheDocument());

    oldSave.resolve(undefined);
    await act(async () => oldSave.promise);
    await act(async () => persistence.writer?.flush());

    expect(repository.saveNodePositions).toHaveBeenCalledOnce();
    expect(persistence.writer?.isDirty()).toBe(false);
  });

  it("maps two-finger scrolling to free panning while preserving pinch zoom", async () => {
    const repository = createRepository();
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Attention Is All You Need");

    const flowCanvas = screen.getByTestId("react-flow");
    expect(flowCanvas).toHaveAttribute("data-pan-on-scroll", "true");
    expect(flowCanvas).toHaveAttribute("data-pan-on-scroll-mode", "free");
    expect(flowCanvas).toHaveAttribute("data-pan-on-scroll-speed", "1");
    expect(flowCanvas).toHaveAttribute("data-zoom-on-scroll", "false");
    expect(flowCanvas).toHaveAttribute("data-zoom-on-pinch", "true");
  });

  it("persists the complete settled layout and retains failed intent for retry", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    repository.saveNodePositions
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(undefined);
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Attention Is All You Need");

    await user.click(screen.getByRole("button", { name: "Move Attention Is All You Need" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save the canvas",
    );
    expect(screen.getByTestId("position-node-attention")).toHaveTextContent(
      "160,134",
    );
    await user.click(screen.getByRole("button", { name: "Retry save" }));

    await waitFor(() => expect(repository.saveNodePositions).toHaveBeenCalledTimes(2));
    expect(repository.saveNodePositions).toHaveBeenLastCalledWith([
      { id: "node-attention", x: 160, y: 134 },
    ]);
  });

  it("flushes the latest in-progress drag through the app persistence writer", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Attention Is All You Need");

    await user.click(screen.getByRole("button", { name: "Drag Attention Is All You Need" }));
    expect(repository.saveNodePositions).not.toHaveBeenCalled();
    expect(persistence.writer?.isDirty()).toBe(true);

    await act(async () => persistence.writer?.flush());

    expect(repository.saveNodePositions).toHaveBeenCalledWith([
      { id: "node-attention", x: 140, y: 120 },
    ]);
    expect(persistence.writer?.isDirty()).toBe(false);
  });

  it("projects a Library drop and adds the DB-created stable node only after success", async () => {
    const repository = createRepository();
    flow.screenToFlowPosition.mockReturnValue({ x: 88, y: 99 });
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Attention Is All You Need");

    dropPaper("paper-bert", 400, 260);

    expect(flow.screenToFlowPosition).toHaveBeenCalledWith({ x: 400, y: 260 });
    expect(repository.createPaperNode).toHaveBeenCalledWith("paper-bert", {
      x: 88,
      y: -42,
    });
    expect(await screen.findByText("BERT")).toBeVisible();
    expect(screen.getByTestId("position-node-bert")).toHaveTextContent("520,245");
    expectRenderedNodesNotToOverlap([firstNode.id, secondNode.id]);
    await waitFor(() => expect(repository.saveNodePositions).toHaveBeenLastCalledWith([
      { id: firstNode.id, ...renderedPosition(firstNode.id) },
      { id: secondNode.id, ...renderedPosition(secondNode.id) },
    ]));
  });

  it("places a bridged native Library drop at its logical canvas position", async () => {
    const repository = createRepository();
    const onPaperDropComplete = vi.fn();
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        bottom: 800,
        height: 748,
        left: 220,
        right: 1280,
        top: 52,
        width: 1060,
        x: 220,
        y: 52,
        toJSON: () => ({}),
      });
    flow.screenToFlowPosition.mockReturnValue({ x: 72, y: 84 });
    render(
      <Whiteboard
        repository={repository}
        paperDropIntent={{
          paperId: "paper-bert",
          clientX: 380,
          clientY: 240,
        }}
        onPaperDropComplete={onPaperDropComplete}
      />,
    );
    await screen.findByText("Attention Is All You Need");

    await waitFor(() =>
      expect(flow.screenToFlowPosition).toHaveBeenCalledWith({ x: 380, y: 240 }),
    );
    expect(repository.createPaperNode).toHaveBeenCalledWith("paper-bert", {
      x: 72,
      y: -42,
    });
    expect(onPaperDropComplete).toHaveBeenCalledOnce();
    expect(await screen.findByText("BERT")).toBeVisible();
    bounds.mockRestore();
  });

  it("ignores a bridged Library drop released outside the canvas", async () => {
    const repository = createRepository();
    const onPaperDropComplete = vi.fn();
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        bottom: 800,
        height: 748,
        left: 220,
        right: 1280,
        top: 52,
        width: 1060,
        x: 220,
        y: 52,
        toJSON: () => ({}),
      });
    render(
      <Whiteboard
        repository={repository}
        paperDropIntent={{
          paperId: "paper-bert",
          clientX: 100,
          clientY: 240,
        }}
        onPaperDropComplete={onPaperDropComplete}
      />,
    );

    await waitFor(() => expect(onPaperDropComplete).toHaveBeenCalledOnce());
    expect(repository.createPaperNode).not.toHaveBeenCalled();
    bounds.mockRestore();
  });

  it("does not leave a ghost node and deduplicates concurrent paper drops", async () => {
    const repository = createRepository();
    const creation = deferred<BoardNodeRecord>();
    repository.createPaperNode.mockReturnValue(creation.promise);
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Attention Is All You Need");
    dropPaper("paper-bert");
    dropPaper("paper-bert");
    expect(repository.createPaperNode).toHaveBeenCalledOnce();
    expect(screen.queryByText("BERT")).not.toBeInTheDocument();

    await act(async () => creation.reject(new Error("write failed")));
    expect(await screen.findByRole("alert")).toHaveTextContent("paper card");
    expect(screen.queryByText("BERT")).not.toBeInTheDocument();
  });

  it("reserves collision-free positions for different papers dropped before either write finishes", async () => {
    const repository = createRepository();
    const firstCreation = deferred<BoardNodeRecord>();
    const secondCreation = deferred<BoardNodeRecord>();
    repository.createPaperNode
      .mockReturnValueOnce(firstCreation.promise)
      .mockReturnValueOnce(secondCreation.promise);
    flow.screenToFlowPosition.mockReturnValue({ x: 1_000, y: 1_000 });
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Attention Is All You Need");

    dropPaper("paper-pending-1");
    dropPaper("paper-pending-2");

    expect(repository.createPaperNode).toHaveBeenNthCalledWith(
      1,
      "paper-pending-1",
      { x: 1_000, y: 1_000 },
    );
    expect(repository.createPaperNode).toHaveBeenNthCalledWith(
      2,
      "paper-pending-2",
      { x: 1_000, y: 848 },
    );

    await act(async () => {
      firstCreation.reject(new Error("write failed"));
      secondCreation.reject(new Error("write failed"));
      await Promise.allSettled([firstCreation.promise, secondCreation.promise]);
    });
  });

  it("ignores malformed drops and non-finite projected coordinates", async () => {
    const repository = createRepository();
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Attention Is All You Need");

    dropPaper("", 1, 2);
    flow.screenToFlowPosition.mockReturnValue({ x: Number.NaN, y: 4 });
    dropPaper("paper-new", 1, 2);

    expect(repository.createPaperNode).not.toHaveBeenCalled();
  });

  it("does not preview or create a connection merely because cards are near", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    repository.loadBoard.mockResolvedValue({ nodes: [firstNode, secondNode], edges: [] });
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Attention Is All You Need");

    await user.click(
      screen.getByRole("button", { name: "Approach Attention Is All You Need" }),
    );
    expect(screen.getByTestId("class-node-bert")).toBeEmptyDOMElement();
    expect(screen.queryByTestId("edge-__magnetic-preview__")).not.toBeInTheDocument();
    expect(repository.createEdge).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Release near Attention Is All You Need" }),
    );

    expect(repository.createEdge).not.toHaveBeenCalled();
    expect(screen.queryByTestId("edge-edge-attention-bert")).not.toBeInTheDocument();
  });

  it("uses Space plus two node clicks for an explicit connection and Esc to exit", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const creation = deferred<BoardEdgeRecord>();
    repository.loadBoard.mockResolvedValue({ nodes: [firstNode, secondNode], edges: [] });
    repository.createEdge.mockReturnValue(creation.promise);
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Attention Is All You Need");

    expect(screen.getByTestId("react-flow")).toHaveAttribute(
      "data-nodes-connectable",
      "false",
    );
    expect(screen.getByTestId("react-flow")).toHaveAttribute(
      "data-connect-on-click",
      "false",
    );
    expect(screen.getByTestId("react-flow")).toHaveAttribute(
      "data-pan-activation-key-code",
      "null",
    );

    fireEvent.keyDown(document.body, { key: " " });
    expect(screen.getByText(/连线模式：请选择第一个节点/)).toBeVisible();
    expect(screen.getByTestId("react-flow")).toHaveAttribute(
      "data-nodes-draggable",
      "false",
    );

    await user.click(
      screen.getByRole("button", { name: "Attention Is All You Need" }),
    );
    expect(screen.getByText(/连线模式：请选择第二个节点/)).toBeVisible();
    expect(screen.getByTestId("class-node-attention")).toHaveTextContent(
      "is-connection-source",
    );
    await user.click(screen.getByRole("button", { name: "BERT" }));

    expect(repository.createEdge).toHaveBeenCalledOnce();
    expect(repository.createEdge).toHaveBeenCalledWith(
      "node-attention",
      "node-bert",
    );
    expect(screen.queryByTestId("edge-edge-attention-bert")).not.toBeInTheDocument();

    await act(async () => creation.resolve(firstEdge));
    expect(await screen.findByTestId("edge-edge-attention-bert")).toHaveAttribute(
      "data-edge-type",
      "straight",
    );
    expect(screen.getByText(/连线模式：请选择第一个节点/)).toBeVisible();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByText(/连线模式：/)).not.toBeInTheDocument();
    expect(screen.getByTestId("react-flow")).toHaveAttribute(
      "data-nodes-draggable",
      "true",
    );
  });

  it("lets an existing neutral edge become Support or Challenge", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    repository.loadBoard.mockResolvedValue({
      nodes: [firstNode, secondNode],
      edges: [{ ...firstEdge, relation: null }],
    });
    render(<Whiteboard repository={repository} />);
    await screen.findByTestId("edge-edge-attention-bert");

    await user.click(screen.getByRole("button", { name: "Select edge-attention-bert" }));
    await user.click(screen.getByRole("button", { name: "Support" }));

    expect(repository.updateEdgeRelation).toHaveBeenCalledWith(
      "edge-attention-bert",
      "support",
    );
    await waitFor(() =>
      expect(screen.getByTestId("edge-edge-attention-bert")).toHaveAttribute(
        "data-edge-class",
        "whiteboard__edge--support",
      ),
    );

    await user.click(screen.getByRole("button", { name: "Challenge" }));
    expect(repository.updateEdgeRelation).toHaveBeenLastCalledWith(
      "edge-attention-bert",
      "challenge",
    );
    await waitFor(() =>
      expect(screen.getByTestId("edge-edge-attention-bert")).toHaveAttribute(
        "data-edge-class",
        "whiteboard__edge--challenge",
      ),
    );
  });

  it("opens the relation editor when keyboard selection selects an edge", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    repository.loadBoard.mockResolvedValue({
      nodes: [firstNode, secondNode],
      edges: [firstEdge],
    });
    render(<Whiteboard repository={repository} />);
    const edge = await screen.findByTestId("edge-edge-attention-bert");

    expect(edge).toHaveAttribute("data-edge-label", "Neutral connection");
    await user.click(
      screen.getByRole("button", {
        name: "Keyboard select edge-attention-bert",
      }),
    );

    expect(screen.getByRole("group", { name: "连线关系" })).toBeVisible();
  });

  it("keeps an active drag pinned when a pending connection finishes saving", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const creation = deferred<BoardEdgeRecord>();
    repository.loadBoard.mockResolvedValue({ nodes: [firstNode, secondNode], edges: [] });
    repository.createEdge.mockReturnValue(creation.promise);
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Attention Is All You Need");

    fireEvent.keyDown(document.body, { key: " " });
    await user.click(
      screen.getByRole("button", { name: "Attention Is All You Need" }),
    );
    await user.click(screen.getByRole("button", { name: "BERT" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await user.click(
      screen.getByRole("button", {
        name: "Push Attention Is All You Need into BERT",
      }),
    );
    expect(renderedPosition(firstNode.id)).toEqual({ x: 300, y: 245 });

    await act(async () => creation.resolve(firstEdge));
    const firstFrame = motion.callback;
    motion.callback = null;
    act(() => firstFrame?.(16));

    expect(renderedPosition(firstNode.id)).toEqual({ x: 300, y: 245 });
  });

  it("continues cooling a released card when a pending connection finishes saving", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const creation = deferred<BoardEdgeRecord>();
    repository.loadBoard.mockResolvedValue({ nodes: [firstNode, secondNode], edges: [] });
    repository.createEdge.mockReturnValue(creation.promise);
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Attention Is All You Need");

    fireEvent.keyDown(document.body, { key: " " });
    await user.click(
      screen.getByRole("button", { name: "Attention Is All You Need" }),
    );
    await user.click(screen.getByRole("button", { name: "BERT" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await user.click(
      screen.getByRole("button", {
        name: "Push Attention Is All You Need into BERT",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Release drag Attention Is All You Need" }),
    );

    await act(async () => creation.resolve(firstEdge));
    await act(async () => persistence.writer?.flush());

    expect(renderedPosition(firstNode.id)).not.toEqual({ x: 300, y: 245 });
    expect(repository.saveNodePositions).toHaveBeenLastCalledWith([
      { id: firstNode.id, ...renderedPosition(firstNode.id) },
      { id: secondNode.id, ...renderedPosition(secondNode.id) },
    ]);
  });

  it("does not cancel the current domain layout when another domain's connection finishes", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const creation = deferred<BoardEdgeRecord>();
    const visionNodes: BoardNodeRecord[] = [
      {
        ...firstNode,
        id: "node-vision-a",
        paper: {
          ...firstNode.paper,
          id: "paper-vision-a",
          title: "Vision A",
          domainId: "domain-vision",
        },
        position: { x: 1_500, y: 0 },
      },
      {
        ...secondNode,
        id: "node-vision-b",
        paper: {
          ...secondNode.paper,
          id: "paper-vision-b",
          title: "Vision B",
          domainId: "domain-vision",
        },
        position: { x: 2_500, y: 0 },
      },
    ];
    repository.loadBoard.mockResolvedValue({
      nodes: [firstNode, secondNode, ...visionNodes],
      edges: [],
    });
    repository.createEdge.mockReturnValue(creation.promise);
    render(
      <Whiteboard
        repository={repository}
        domains={[
          { id: "domain-transformers", name: "领域 A" },
          { id: "domain-vision", name: "领域 B" },
        ]}
      />,
    );
    await screen.findByText("Vision B");
    fireEvent.keyDown(document.body, { key: " " });
    await user.click(
      screen.getByRole("button", { name: "Attention Is All You Need" }),
    );
    await user.click(screen.getByRole("button", { name: "BERT" }));
    await user.click(screen.getByRole("button", { name: "领域 B" }));
    await user.click(screen.getByRole("button", { name: "重新整理布局" }));
    vi.mocked(cancelAnimationFrame).mockClear();

    await act(async () => creation.resolve(firstEdge));

    expect(cancelAnimationFrame).not.toHaveBeenCalled();
  });

  it("flushes a layout started by a pending connection before returning", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const creation = deferred<BoardEdgeRecord>();
    repository.loadBoard.mockResolvedValue({ nodes: [firstNode, secondNode], edges: [] });
    repository.createEdge.mockReturnValue(creation.promise);
    render(<Whiteboard repository={repository} />);
    await screen.findByText("BERT");
    await act(async () => persistence.writer?.flush());
    repository.saveNodePositions.mockClear();

    fireEvent.keyDown(document.body, { key: " " });
    await user.click(
      screen.getByRole("button", { name: "Attention Is All You Need" }),
    );
    await user.click(screen.getByRole("button", { name: "BERT" }));

    const flushPromise = persistence.writer!.flush();
    await act(async () => creation.resolve(firstEdge));
    await act(async () => flushPromise);

    expect(persistence.writer!.isDirty()).toBe(false);
    expect(repository.saveNodePositions).toHaveBeenCalledWith([
      { id: firstNode.id, ...renderedPosition(firstNode.id) },
      { id: secondNode.id, ...renderedPosition(secondNode.id) },
    ]);
  });

  it("ignores Space in editing controls and rejects duplicate or self pairs", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    repository.loadBoard.mockResolvedValue({
      nodes: [firstNode, secondNode],
      edges: [firstEdge],
    });
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Attention Is All You Need");

    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: " " });
    fireEvent.keyDown(screen.getByRole("button", { name: "All" }), { key: " " });
    expect(screen.queryByText(/连线模式：/)).not.toBeInTheDocument();
    input.remove();

    fireEvent.keyDown(document.body, { key: " " });
    const attention = screen.getByRole("button", {
      name: "Attention Is All You Need",
    });
    const bert = screen.getByRole("button", { name: "BERT" });
    await user.click(attention);
    await user.click(attention);
    await user.click(bert);
    await user.click(attention);

    expect(repository.createEdge).not.toHaveBeenCalled();
  });

  it("keeps the dragged card under the pointer and moves its neighbor gradually before saving", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    repository.loadBoard.mockResolvedValue({
      nodes: [firstNode, secondNode],
      edges: [],
    });
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Attention Is All You Need");

    await user.click(
      screen.getByRole("button", {
        name: "Push Attention Is All You Need into BERT",
      }),
    );

    expect(screen.getByTestId("position-node-attention")).toHaveTextContent(
      "300,245",
    );
    expect(renderedPosition(secondNode.id)).toEqual(secondNode.position);
    expect(repository.saveNodePositions).not.toHaveBeenCalled();

    const firstFrame = motion.callback;
    expect(firstFrame).not.toBeNull();
    act(() => firstFrame?.(16));
    const intermediate = screen.getByTestId("position-node-bert").textContent;
    expect(Number(intermediate?.split(",")[0])).toBeGreaterThan(secondNode.position.x);
    expect(Number(intermediate?.split(",")[0]) - secondNode.position.x).toBeLessThan(40);
    expect(renderedPosition(firstNode.id)).toEqual({ x: 300, y: 245 });

    await user.click(
      screen.getByRole("button", { name: "Release drag Attention Is All You Need" }),
    );
    await act(async () => persistence.writer?.flush());

    expect(renderedPosition(firstNode.id)).not.toEqual({ x: 300, y: 245 });
    expect(repository.saveNodePositions).toHaveBeenCalledOnce();
    const saved = repository.saveNodePositions.mock.calls[0][0];
    expect(saved).toEqual([
      { id: firstNode.id, ...renderedPosition(firstNode.id) },
      { id: secondNode.id, ...renderedPosition(secondNode.id) },
    ]);
    expectRenderedNodesNotToOverlap([firstNode.id, secondNode.id]);
  });

  it("uses a stretched connection to pull the linked structure without moving the dragged card", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const linkedNode: BoardNodeRecord = {
      ...secondNode,
      id: "node-linked",
      paper: {
        ...secondNode.paper,
        id: "paper-linked",
        title: "Linked Paper",
        createdAt: 3,
      },
      position: { x: -300, y: 245 },
    };
    repository.loadBoard.mockResolvedValue({
      nodes: [firstNode, secondNode, linkedNode],
      edges: [
        {
          id: "edge-attention-linked",
          boardId: "board-default",
          sourceNodeId: firstNode.id,
          targetNodeId: linkedNode.id,
        },
      ],
    });
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Linked Paper");

    await user.click(
      screen.getByRole("button", {
        name: "Push Attention Is All You Need into BERT",
      }),
    );

    expect(screen.getByTestId("position-node-attention")).toHaveTextContent(
      "300,245",
    );
    const linkedBeforeFrame = Number(
      screen
        .getByTestId("position-node-linked")
        .textContent?.split(",")[0],
    );
    expect(linkedBeforeFrame).toBe(-300);
    const firstFrame = motion.callback;
    expect(firstFrame).not.toBeNull();
    act(() => firstFrame?.(16));
    expect(
      Number(
        screen
          .getByTestId("position-node-linked")
          .textContent?.split(",")[0],
      ),
    ).toBeGreaterThan(linkedBeforeFrame);
    expect(screen.getByTestId("position-node-attention")).toHaveTextContent(
      "300,245",
    );

    await user.click(
      screen.getByRole("button", { name: "Release drag Attention Is All You Need" }),
    );
    await act(async () => persistence.writer?.flush());

    const saveCalls = repository.saveNodePositions.mock.calls;
    const saved = saveCalls[saveCalls.length - 1]?.[0];
    const savedAttention = saved?.find(({ id }) => id === firstNode.id);
    const savedLinked = saved?.find(({ id }) => id === linkedNode.id);
    expect(savedAttention).toEqual({
      id: firstNode.id,
      ...renderedPosition(firstNode.id),
    });
    expect(savedLinked?.x).toBeGreaterThan(-300);
  });

  it("allows the connected graph beyond two hops to respond during a drag", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const thirdNode: BoardNodeRecord = {
      ...secondNode,
      id: "node-third",
      paper: { ...secondNode.paper, id: "paper-third", title: "Third" },
      position: { x: 1_000, y: 245 },
    };
    const distantNode: BoardNodeRecord = {
      ...secondNode,
      id: "node-distant",
      paper: { ...secondNode.paper, id: "paper-distant", title: "Distant" },
      position: { x: 1_600, y: 245 },
    };
    repository.loadBoard.mockResolvedValue({
      nodes: [firstNode, secondNode, thirdNode, distantNode],
      edges: [
        firstEdge,
        {
          id: "edge-bert-third",
          boardId: "board-default",
          sourceNodeId: secondNode.id,
          targetNodeId: thirdNode.id,
        },
        {
          id: "edge-third-distant",
          boardId: "board-default",
          sourceNodeId: thirdNode.id,
          targetNodeId: distantNode.id,
        },
      ],
    });
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Distant");

    await user.click(
      screen.getByRole("button", {
        name: "Push Attention Is All You Need into BERT",
      }),
    );
    const firstFrame = motion.callback;
    motion.callback = null;
    act(() => firstFrame?.(16));

    expect(renderedPosition(distantNode.id)).not.toEqual(distantNode.position);
    expect(renderedPosition(firstNode.id)).toEqual({ x: 300, y: 245 });
  });

  it("persists a multi-card drag as one complete release snapshot", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    repository.loadBoard.mockResolvedValue({
      nodes: [firstNode, secondNode],
      edges: [],
    });
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Attention Is All You Need");

    await user.click(screen.getByRole("button", { name: "Drag selected cards" }));
    expect(screen.getByTestId("position-node-attention")).toHaveTextContent(
      "140,120",
    );
    expect(screen.getByTestId("position-node-bert")).toHaveTextContent(
      "540,255",
    );
    expect(repository.saveNodePositions).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Release selected cards" }),
    );
    await act(async () => persistence.writer?.flush());

    expect(repository.saveNodePositions).toHaveBeenCalledOnce();
    expect(repository.saveNodePositions).toHaveBeenCalledWith([
      { id: firstNode.id, ...renderedPosition(firstNode.id) },
      { id: secondNode.id, ...renderedPosition(secondNode.id) },
    ]);
  });

  it("smoothly repels a neighbor reached by any card in a multi-card drag", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const staticNeighbor: BoardNodeRecord = {
      ...secondNode,
      id: "node-static-neighbor",
      paper: {
        ...secondNode.paper,
        id: "paper-static-neighbor",
        title: "Static Neighbor",
        createdAt: 3,
      },
      position: { x: 824, y: 245 },
    };
    repository.loadBoard.mockResolvedValue({
      nodes: [firstNode, secondNode, staticNeighbor],
      edges: [],
    });
    render(<Whiteboard repository={repository} />);
    await screen.findByText("Static Neighbor");

    await user.click(screen.getByRole("button", { name: "Drag selected cards" }));
    expect(renderedPosition(staticNeighbor.id)).toEqual(staticNeighbor.position);
    const firstFrame = motion.callback;
    expect(firstFrame).not.toBeNull();
    act(() => firstFrame?.(16));
    const intermediate = Number(
      screen
        .getByTestId("position-node-static-neighbor")
        .textContent?.split(",")[0],
    );
    expect(intermediate).toBeGreaterThan(824);
    expect(intermediate - staticNeighbor.position.x).toBeLessThan(20);
    expect(renderedPosition(firstNode.id)).toEqual({ x: 140, y: 120 });
    expect(renderedPosition(secondNode.id)).toEqual({ x: 540, y: 255 });

    await user.click(screen.getByRole("button", { name: "Release selected cards" }));
    await act(async () => persistence.writer?.flush());

    const saved = repository.saveNodePositions.mock.calls[0][0];
    for (const node of [firstNode, secondNode, staticNeighbor]) {
      expect(saved.find(({ id }) => id === node.id)).toEqual({
        id: node.id,
        ...renderedPosition(node.id),
      });
    }
    expectRenderedNodesNotToOverlap([
      firstNode.id,
      secondNode.id,
      staticNeighbor.id,
    ]);
  });

  it("keeps a persisted edge when deletion fails and removes it after success", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    repository.loadBoard.mockResolvedValue({
      nodes: [firstNode, secondNode],
      edges: [firstEdge],
    });
    repository.deleteEdges
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(undefined);
    render(<Whiteboard repository={repository} />);
    await screen.findByTestId("edge-edge-attention-bert");

    await user.click(screen.getByRole("button", { name: "Delete edge-attention-bert" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("connection");
    expect(screen.getByTestId("edge-edge-attention-bert")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Delete edge-attention-bert" }));
    await waitFor(() =>
      expect(screen.queryByTestId("edge-edge-attention-bert")).not.toBeInTheDocument(),
    );
    expect(repository.deleteEdges).toHaveBeenCalledWith(["edge-attention-bert"]);
  });

  it("opens the selected paper only on a card double click", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const onOpenPaper = vi.fn();
    render(<Whiteboard repository={repository} onOpenPaper={onOpenPaper} />);
    const card = await screen.findByRole("button", { name: "Attention Is All You Need" });

    await user.click(card);
    expect(onOpenPaper).not.toHaveBeenCalled();
    await user.dblClick(card);
    expect(onOpenPaper).toHaveBeenCalledWith(firstNode.paper);
  });

  it("does not open a paper while Space connection mode is active", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const onOpenPaper = vi.fn();
    render(<Whiteboard repository={repository} onOpenPaper={onOpenPaper} />);
    const card = await screen.findByRole("button", {
      name: "Attention Is All You Need",
    });

    fireEvent.keyDown(document.body, { key: " " });
    await user.dblClick(card);
    expect(onOpenPaper).not.toHaveBeenCalled();
  });

  it("filters canonical nodes and edges by domain and frames domains only in All", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const visionNode: BoardNodeRecord = {
      ...secondNode,
      id: "node-vision",
      paper: {
        ...secondNode.paper,
        id: "paper-vision",
        title: "Vision Paper",
        domainId: "domain-vision",
      },
      position: { x: 900, y: 100 },
    };
    const looseNode: BoardNodeRecord = {
      ...secondNode,
      id: "node-loose",
      paper: {
        ...secondNode.paper,
        id: "paper-loose",
        title: "Loose Paper",
        domainId: null,
      },
      position: { x: 1_200, y: 100 },
    };
    repository.loadBoard.mockResolvedValue({
      nodes: [firstNode, secondNode, visionNode, looseNode],
      edges: [
        firstEdge,
        {
          id: "edge-cross-domain",
          boardId: "board-default",
          sourceNodeId: firstNode.id,
          targetNodeId: visionNode.id,
        },
      ],
    });
    render(
      <Whiteboard
        repository={repository}
        domains={[
          { id: "domain-transformers", name: "领域 A" },
          { id: "domain-vision", name: "领域 B" },
        ]}
      />,
    );
    await screen.findByText("Vision Paper");

    expect(screen.getByTestId("domain-frame-domain-transformers")).toHaveTextContent(
      "领域 A",
    );
    expect(screen.getByTestId("domain-frame-domain-vision")).toHaveTextContent(
      "领域 B",
    );
    expect(screen.getByTestId("edge-edge-cross-domain")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "领域 A" }));
    expect(screen.getByText("Attention Is All You Need")).toBeVisible();
    expect(screen.getByText("BERT")).toBeVisible();
    expect(screen.queryByText("Vision Paper")).not.toBeInTheDocument();
    expect(screen.queryByTestId("edge-edge-cross-domain")).not.toBeInTheDocument();
    expect(screen.queryByTestId("domain-frame-domain-transformers")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "未分区" }));
    expect(screen.getByText("Loose Paper")).toBeVisible();
    expect(screen.queryByText("Attention Is All You Need")).not.toBeInTheDocument();
  });

  it("reorganizes only the selected domain and fits it in the viewport", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    const domainANodes = [
      { ...firstNode, position: { x: 0, y: 0 } },
      { ...secondNode, position: { x: 400, y: 0 } },
    ];
    const domainBNodes: BoardNodeRecord[] = [
      {
        ...firstNode,
        id: "node-vision-a",
        paper: {
          ...firstNode.paper,
          id: "paper-vision-a",
          title: "Vision A",
          domainId: "domain-vision",
        },
        position: { x: 2_000, y: 0 },
      },
      {
        ...secondNode,
        id: "node-vision-b",
        paper: {
          ...secondNode.paper,
          id: "paper-vision-b",
          title: "Vision B",
          domainId: "domain-vision",
        },
        position: { x: 3_400, y: 0 },
      },
    ];
    repository.loadBoard.mockResolvedValue({
      nodes: [...domainANodes, ...domainBNodes],
      edges: [
        {
          id: "edge-vision",
          boardId: "board-default",
          sourceNodeId: "node-vision-a",
          targetNodeId: "node-vision-b",
          relation: null,
        },
      ],
    });
    render(
      <Whiteboard
        repository={repository}
        domains={[
          { id: "domain-transformers", name: "领域 A" },
          { id: "domain-vision", name: "领域 B" },
        ]}
      />,
    );
    await screen.findByText("Vision B");
    const domainABefore = domainANodes.map(({ id }) => renderedPosition(id));
    flow.fitView.mockClear();
    await user.click(screen.getByRole("button", { name: "重新整理布局" }));

    await user.click(screen.getByRole("button", { name: "领域 B" }));

    expect(screen.queryByText("Attention Is All You Need")).not.toBeInTheDocument();
    expect(renderedPosition("node-vision-a")).not.toEqual(
      domainBNodes[0].position,
    );
    const fitOptions = flow.fitView.mock.calls[0]?.[0] as
      | { nodes?: Array<{ id: string }> }
      | undefined;
    expect(fitOptions?.nodes?.map(({ id }) => id)).toEqual([
      "node-vision-a",
      "node-vision-b",
    ]);
    await user.click(screen.getByRole("button", { name: "重新整理布局" }));
    await act(async () => persistence.writer?.flush());

    await user.click(screen.getByRole("button", { name: "All" }));
    expect(domainANodes.map(({ id }) => renderedPosition(id))).toEqual(
      domainABefore,
    );
  });

  it("loads domain tabs itself and refreshes them after an organized catalog change", async () => {
    const repository = createRepository();
    const domainRepository = {
      list: vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: "domain-transformers",
            name: "领域 A",
            createdAt: 1,
            updatedAt: 1,
          },
        ])
        .mockResolvedValue([
          {
            id: "domain-transformers",
            name: "新名称",
            createdAt: 1,
            updatedAt: 2,
          },
        ]),
    };
    const { rerender } = render(
      <Whiteboard
        repository={repository}
        domainRepository={domainRepository}
      />,
    );

    expect(await screen.findByRole("button", { name: "领域 A" })).toBeVisible();
    rerender(
      <Whiteboard
        repository={repository}
        domainRepository={domainRepository}
        paperCatalogChange={{
          kind: "organized",
          paperIds: [firstNode.paper.id],
          revision: 1,
        }}
      />,
    );

    expect(await screen.findByRole("button", { name: "新名称" })).toBeVisible();
    expect(domainRepository.list).toHaveBeenCalledTimes(2);
    expect(repository.loadBoard).toHaveBeenCalledTimes(2);
  });

  it("lets the user retry an initial board load failure", async () => {
    const user = userEvent.setup();
    const repository = createRepository();
    repository.loadBoard
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ nodes: [firstNode], edges: [] });
    render(<Whiteboard repository={repository} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Attention Is All You Need")).toBeVisible();
  });
});
