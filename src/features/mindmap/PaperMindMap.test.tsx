import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateMindMap } from "./PaperMindMap";
import type { MindMapRepository } from "./data/mindMapRepository";
import { MindMapRevisionConflictError } from "./data/sqliteMindMapRepository";
import type { MindMapTree } from "./model/mindMap";
import type { PersistenceWriter } from "../persistence";

const flow = vi.hoisted(() => ({
  latestProps: undefined as Record<string, unknown> | undefined,
}));

const persistence = vi.hoisted(() => ({
  name: undefined as string | undefined,
  writer: undefined as PersistenceWriter | undefined,
}));

vi.mock("../persistence", () => ({
  usePersistenceWriter: (name: string, writer: PersistenceWriter) => {
    persistence.name = name;
    persistence.writer = writer;
  },
}));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
    ReactFlow: (props: Record<string, unknown> & {
      children?: ReactNode;
      edges: Array<{ id: string; type?: string }>;
      nodes: Array<{
        data: { title: string };
        id: string;
        position: { x: number; y: number };
      }>;
    }) => {
      flow.latestProps = props;
      return (
        <div
          data-testid="mind-map-flow"
          data-pan-on-scroll={String(props.panOnScroll)}
          data-zoom-on-pinch={String(props.zoomOnPinch)}
          data-zoom-on-scroll={String(props.zoomOnScroll)}
        >
          {props.nodes.map((node) => (
            <output data-testid={`node-${node.id}`} key={node.id}>
              {node.data.title}:{node.position.x},{node.position.y}
            </output>
          ))}
          {props.edges.map((edge) => (
            <output data-edge-type={edge.type} key={edge.id}>
              {edge.id}
            </output>
          ))}
          {props.children}
        </div>
      );
    },
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
  };
});

import { PaperMindMap } from "./PaperMindMap";

function existingTree(): MindMapTree {
  return {
    schemaVersion: 1,
    revision: 3,
    sourcePrompt: "Existing prompt",
    updatedAt: 100,
    nodes: [
      { id: "root", title: "Old tree", details: "", parentId: null, x: 0, y: 0 },
      { id: "child", title: "Child", details: "", parentId: "root", x: 300, y: 0 },
    ],
  };
}

function repositoryWith(tree: MindMapTree | null) {
  return {
    load: vi.fn().mockResolvedValue(tree),
    save: vi.fn().mockResolvedValue(undefined),
  } satisfies MindMapRepository;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("PaperMindMap", () => {
  beforeEach(() => {
    flow.latestProps = undefined;
    persistence.name = undefined;
    persistence.writer = undefined;
  });

  it("loads a paper-specific map with straight edges and trackpad-native gestures", async () => {
    const repository = repositoryWith(existingTree());
    render(<PaperMindMap paperId="paper-1" repository={repository} />);

    expect(await screen.findByText(/Old tree/)).toBeInTheDocument();
    const canvas = screen.getByTestId("mind-map-flow");
    expect(canvas).toHaveAttribute("data-pan-on-scroll", "true");
    expect(canvas).toHaveAttribute("data-zoom-on-scroll", "false");
    expect(canvas).toHaveAttribute("data-zoom-on-pinch", "true");
    expect(screen.getByText("mind-map-edge:child")).toHaveAttribute(
      "data-edge-type",
      "straight",
    );
    expect(repository.load).toHaveBeenCalledWith("paper-1");
  });

  it("validates and atomically saves a generated tree before showing it", async () => {
    const user = userEvent.setup();
    const repository = repositoryWith(existingTree());
    const generated: MindMapTree = {
      schemaVersion: 1,
      revision: 1,
      sourcePrompt: "provider metadata",
      updatedAt: 1,
      nodes: [
        { id: "root", title: "New tree", details: "", parentId: null, x: 99, y: 99 },
      ],
    };
    const generateMindMap = vi.fn().mockResolvedValue(generated);
    const onGenerationStatusChange = vi.fn();
    render(
      <PaperMindMap
        generateMindMap={generateMindMap}
        onGenerationStatusChange={onGenerationStatusChange}
        paperId="paper-1"
        repository={repository}
      />,
    );
    await screen.findByText(/Old tree/);

    const prompt = screen.getByLabelText("Mind map prompt");
    await user.clear(prompt);
    await user.type(prompt, "Map the paper's argument");
    await user.click(screen.getByRole("button", { name: "Regenerate mind map" }));

    await waitFor(() =>
      expect(repository.save).toHaveBeenCalledWith(
        "paper-1",
        expect.objectContaining({
          revision: 4,
          sourcePrompt: "Map the paper's argument",
          nodes: [expect.objectContaining({ title: "New tree", x: 0, y: 0 })],
        }),
        3,
      ),
    );
    expect(await screen.findByText(/New tree/)).toBeInTheDocument();
    expect(onGenerationStatusChange).toHaveBeenCalledWith("generating");
    expect(onGenerationStatusChange).toHaveBeenLastCalledWith("idle");
  });

  it("rolls back a failed generated save without trapping close in retry saving", async () => {
    const user = userEvent.setup();
    const repository = {
      load: vi.fn().mockResolvedValue(existingTree()),
      save: vi.fn().mockRejectedValue(new Error("disk full")),
    } satisfies MindMapRepository;
    const generateMindMap = vi.fn().mockResolvedValue({
      ...existingTree(),
      nodes: [
        {
          id: "root",
          title: "Unsaved generated tree",
          details: "",
          parentId: null,
          x: 0,
          y: 0,
        },
      ],
    });
    render(
      <PaperMindMap
        generateMindMap={generateMindMap}
        paperId="paper-1"
        repository={repository}
      />,
    );
    await screen.findByText(/Old tree/);

    await user.click(screen.getByRole("button", { name: "Regenerate mind map" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not be generated or saved/i,
    );
    expect(screen.getByText(/Old tree/)).toBeInTheDocument();
    await waitFor(() => expect(persistence.writer?.isDirty()).toBe(false));
    await expect(persistence.writer?.flush()).resolves.toBeUndefined();
  });

  it("keeps the old graph when generated JSON is invalid", async () => {
    const user = userEvent.setup();
    const repository = repositoryWith(existingTree());
    const generateMindMap = vi.fn().mockResolvedValue({
      ...existingTree(),
      nodes: [
        { id: "a", title: "A", details: "", parentId: "b", x: 0, y: 0 },
        { id: "b", title: "B", details: "", parentId: "a", x: 0, y: 0 },
      ],
    });
    render(
      <PaperMindMap
        generateMindMap={generateMindMap}
        paperId="paper-1"
        repository={repository}
      />,
    );
    await screen.findByText(/Old tree/);

    await user.click(screen.getByRole("button", { name: "Regenerate mind map" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/valid tree/i);
    expect(screen.getByText(/Old tree/)).toBeInTheDocument();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("stops an in-flight generation and ignores a provider that resolves late", async () => {
    const user = userEvent.setup();
    const repository = repositoryWith(existingTree());
    let resolveGeneration!: (tree: MindMapTree) => void;
    const generateMindMap = vi.fn<GenerateMindMap>(
      () => new Promise<MindMapTree>((resolve) => {
        resolveGeneration = resolve;
      }),
    );
    render(
      <PaperMindMap
        generateMindMap={generateMindMap}
        paperId="paper-1"
        repository={repository}
      />,
    );
    await screen.findByText(/Old tree/);

    await user.click(screen.getByRole("button", { name: "Regenerate mind map" }));
    expect(screen.getByRole("button", { name: "Stop generation" })).toBeVisible();
    const request = generateMindMap.mock.calls[0]![0];
    await user.click(screen.getByRole("button", { name: "Stop generation" }));
    expect(request.signal.aborted).toBe(true);

    await act(async () => resolveGeneration({ ...existingTree(), nodes: [
      { id: "root", title: "Too late", details: "", parentId: null, x: 0, y: 0 },
    ] }));
    expect(repository.save).not.toHaveBeenCalled();
    expect(screen.getByText(/Old tree/)).toBeInTheDocument();
  });

  it("registers generation as dirty and flush cancels then drains the provider", async () => {
    const user = userEvent.setup();
    const repository = repositoryWith(existingTree());
    const generation = createDeferred<MindMapTree>();
    const generateMindMap = vi.fn<GenerateMindMap>(() => generation.promise);
    render(
      <PaperMindMap
        generateMindMap={generateMindMap}
        paperId="paper-1"
        repository={repository}
      />,
    );
    await screen.findByText(/Old tree/);

    await user.click(screen.getByRole("button", { name: "Regenerate mind map" }));
    const writer = persistence.writer!;
    const request = generateMindMap.mock.calls[0]![0];
    expect(persistence.name).toBe("mind-map:paper-1");
    expect(writer.isDirty()).toBe(true);

    let didFlush = false;
    const flushPromise = writer.flush().then(() => {
      didFlush = true;
    });
    expect(request.signal.aborted).toBe(true);
    await act(async () => Promise.resolve());
    expect(didFlush).toBe(false);

    await act(async () => {
      generation.resolve({
        ...existingTree(),
        nodes: [
          {
            id: "root",
            title: "Late result",
            details: "",
            parentId: null,
            x: 0,
            y: 0,
          },
        ],
      });
      await flushPromise;
    });

    expect(repository.save).not.toHaveBeenCalled();
    expect(writer.isDirty()).toBe(false);
  });

  it("does not allow a second generation to start while flush is draining", async () => {
    const user = userEvent.setup();
    const repository = repositoryWith(existingTree());
    const firstGeneration = createDeferred<MindMapTree>();
    const secondGeneration = createDeferred<MindMapTree>();
    const generateMindMap = vi
      .fn<GenerateMindMap>()
      .mockImplementationOnce(() => firstGeneration.promise)
      .mockImplementationOnce(() => secondGeneration.promise);
    render(
      <PaperMindMap
        generateMindMap={generateMindMap}
        paperId="paper-1"
        repository={repository}
      />,
    );
    await screen.findByText(/Old tree/);

    await user.click(screen.getByRole("button", { name: "Regenerate mind map" }));
    let flushPromise!: Promise<void>;
    act(() => {
      flushPromise = persistence.writer!.flush();
    });
    await user.click(
      await screen.findByRole("button", { name: "Regenerate mind map" }),
    );
    const callsDuringFlush = generateMindMap.mock.calls.length;

    await act(async () => {
      const lateTree = {
        ...existingTree(),
        nodes: [
          {
            id: "root",
            title: "Late result",
            details: "",
            parentId: null,
            x: 0,
            y: 0,
          },
        ],
      } satisfies MindMapTree;
      firstGeneration.resolve(lateTree);
      secondGeneration.resolve(lateTree);
      await flushPromise;
    });

    expect(callsDuringFlush).toBe(1);
    expect(persistence.writer!.isDirty()).toBe(false);
  });

  it("snaps an overlapping manual drag and persists the new full-tree revision", async () => {
    const repository = repositoryWith(existingTree());
    render(<PaperMindMap paperId="paper-1" repository={repository} />);
    await screen.findByText(/Old tree/);

    const props = flow.latestProps as {
      onNodeDragStop: (event: unknown, node: {
        id: string;
        position: { x: number; y: number };
      }) => void;
    };
    act(() => {
      props.onNodeDragStop({}, { id: "child", position: { x: 0, y: 0 } });
    });

    await waitFor(() => expect(repository.save).toHaveBeenCalled());
    const [, savedValue, expectedRevision] = repository.save.mock.calls[0]!;
    const saved = savedValue as MindMapTree;
    expect(expectedRevision).toBe(3);
    expect(saved.revision).toBe(4);
    expect(saved.nodes.find((node) => node.id === "child")).not.toMatchObject({
      x: 0,
      y: 0,
    });
  });

  it("keeps a failed manual save dirty and makes flush reject", async () => {
    const save = createDeferred<void>();
    const repository = {
      load: vi.fn().mockResolvedValue(existingTree()),
      save: vi.fn(() => save.promise),
    } satisfies MindMapRepository;
    render(<PaperMindMap paperId="paper-1" repository={repository} />);
    await screen.findByText(/Old tree/);

    const props = flow.latestProps as {
      onNodeDragStop: (event: unknown, node: {
        id: string;
        position: { x: number; y: number };
      }) => void;
    };
    act(() => {
      props.onNodeDragStop({}, { id: "child", position: { x: 420, y: 40 } });
    });
    const writer = persistence.writer!;
    expect(writer.isDirty()).toBe(true);
    const flushPromise = writer.flush();

    await act(async () => save.reject(new Error("disk full")));
    await expect(flushPromise).rejects.toThrow("disk full");
    expect(writer.isDirty()).toBe(true);
  });

  it("reloads the latest tree after a revision conflict so the next save can succeed", async () => {
    const first = existingTree();
    const latest: MindMapTree = {
      ...existingTree(),
      revision: 4,
      updatedAt: 200,
      nodes: existingTree().nodes.map((node) =>
        node.id === "root" ? { ...node, title: "Latest tree" } : node,
      ),
    };
    const repository = {
      load: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(latest),
      save: vi
        .fn()
        .mockRejectedValueOnce(new MindMapRevisionConflictError())
        .mockResolvedValueOnce(undefined),
    } satisfies MindMapRepository;
    render(<PaperMindMap paperId="paper-1" repository={repository} />);
    await screen.findByText(/Old tree/);

    let props = flow.latestProps as {
      onNodeDragStop: (event: unknown, node: {
        id: string;
        position: { x: number; y: number };
      }) => void;
    };
    act(() => {
      props.onNodeDragStop({}, { id: "child", position: { x: 420, y: 40 } });
    });

    expect(await screen.findByText(/Latest tree/)).toBeInTheDocument();
    expect(repository.load).toHaveBeenCalledTimes(2);
    expect(persistence.writer!.isDirty()).toBe(false);
    await expect(persistence.writer!.flush()).resolves.toBeUndefined();

    props = flow.latestProps as typeof props;
    act(() => {
      props.onNodeDragStop({}, { id: "child", position: { x: 520, y: 60 } });
    });
    await waitFor(() => expect(repository.save).toHaveBeenCalledTimes(2));
    expect(repository.save.mock.calls[1]?.[2]).toBe(4);
    expect(repository.save.mock.calls[1]?.[1].revision).toBe(5);
  });

  it("clears a stale revision conflict after a failed reload is retried successfully", async () => {
    const latest: MindMapTree = {
      ...existingTree(),
      revision: 4,
      nodes: existingTree().nodes.map((node) =>
        node.id === "root" ? { ...node, title: "Recovered latest tree" } : node,
      ),
    };
    const repository = {
      load: vi
        .fn()
        .mockResolvedValueOnce(existingTree())
        .mockRejectedValueOnce(new Error("reload busy"))
        .mockResolvedValueOnce(latest),
      save: vi.fn().mockRejectedValueOnce(new MindMapRevisionConflictError()),
    } satisfies MindMapRepository;
    render(<PaperMindMap paperId="paper-1" repository={repository} />);
    await screen.findByText(/Old tree/);

    const props = flow.latestProps as {
      onNodeDragStop: (event: unknown, node: {
        id: string;
        position: { x: number; y: number };
      }) => void;
    };
    act(() => {
      props.onNodeDragStop({}, { id: "child", position: { x: 420, y: 40 } });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /latest version could not be reloaded/i,
    );
    expect(persistence.writer!.isDirty()).toBe(true);
    await expect(persistence.writer!.flush()).rejects.toBeInstanceOf(
      MindMapRevisionConflictError,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/Recovered latest tree/)).toBeInTheDocument();
    expect(persistence.writer!.isDirty()).toBe(false);
    await expect(persistence.writer!.flush()).resolves.toBeUndefined();
  });

  it("shows a retryable load failure without invoking AI", async () => {
    const repository: MindMapRepository = {
      load: vi.fn().mockRejectedValueOnce(new Error("db offline")).mockResolvedValue(null),
      save: vi.fn(),
    };
    const generateMindMap = vi.fn();
    render(
      <PaperMindMap
        generateMindMap={generateMindMap}
        paperId="paper-1"
        repository={repository}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load/i);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(repository.load).toHaveBeenCalledTimes(2));
    expect(generateMindMap).not.toHaveBeenCalled();
  });
});
