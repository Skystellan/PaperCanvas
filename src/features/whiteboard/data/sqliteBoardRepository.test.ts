import { describe, expect, it, vi } from "vitest";

import {
  WorkspaceConflictError,
  type WorkspaceCommandRunner,
  type WorkspaceResponse,
} from "../../../data/workspaceClient";
import type { BoardSnapshot } from "./boardRepository";
import type { BoardNodeRecord } from "../model/boardNode";
import { DEFAULT_BOARD_ID, SqliteBoardRepository } from "./sqliteBoardRepository";

function createRepository() {
  const command = vi.fn<WorkspaceCommandRunner>();
  return {
    command,
    repository: new SqliteBoardRepository(command as WorkspaceCommandRunner),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const node: BoardNodeRecord = {
  id: "persisted-node",
  boardId: DEFAULT_BOARD_ID,
  paper: {
    id: "paper-attention",
    title: "Attention Is All You Need",
    authors: "Vaswani et al.",
    year: 2017,
    filePath: "papers/attention.pdf",
    domainId: "domain-ml",
    createdAt: 1_700_000_000_000,
  },
  position: { x: 120, y: 80 },
  size: { width: 280, height: 128 },
};
const snapshot: BoardSnapshot = {
  nodes: [node],
  edges: [{
    id: "persisted-edge",
    boardId: DEFAULT_BOARD_ID,
    sourceNodeId: node.id,
    targetNodeId: "node-bert",
    relation: "challenge",
    explanation: "Different result",
    evidence: "Page 7",
  }],
};
const updates = [{ id: node.id, x: 310, y: 220 }];
const annotations = {
  explanation: "支持相同结论",
  evidence: "第 4 页：原文\n包含引号 ' 和换行",
};
const edits: [string, (repository: SqliteBoardRepository) => Promise<unknown>][] = [
  ["refresh repository Stars", (repository) => repository.updatePaperGithubStars(node.paper.id, "https://github.com/example/code", 0)],
  ["update a paper repository", (repository) => repository.updatePaperGithub(node.paper.id, "https://github.com/example/code", 0)],
  ["create a paper node", (repository) => repository.createPaperNode(node.paper.id, node.position)],
  ["create an edge", (repository) => repository.createEdge(node.id, "node-bert")],
  ["save positions", (repository) => repository.saveNodePositions(updates)],
  ["update a relation", (repository) => repository.updateEdgeRelation("edge-1", "support")],
  ["update annotations", (repository) => repository.updateEdgeAnnotations("edge-1", annotations)],
  ["delete nodes", (repository) => repository.deleteNodes([node.id])],
  ["delete edges", (repository) => repository.deleteEdges(["edge-1"])],
];

describe("SqliteBoardRepository", () => {
  it("queues a Stars refresh after a repository edit with the updated revision and original URL", async () => {
    const { command, repository } = createRepository();
    command.mockResolvedValueOnce({ revision: 9, value: snapshot })
      .mockResolvedValueOnce({ revision: 10, value: null })
      .mockResolvedValueOnce({ revision: 10, value: null });
    await repository.loadBoard();
    await Promise.all([
      repository.updatePaperGithub(node.paper.id, "https://github.com/example/new", null),
      repository.updatePaperGithubStars(node.paper.id, "https://github.com/example/code", 42),
    ]);
    expect(command.mock.calls.slice(1)).toEqual([
      [{ type: "update_paper_github", paperId: node.paper.id, githubUrl: "https://github.com/example/new", githubStars: null }, 9],
      [{ type: "update_paper_github_stars", paperId: node.paper.id, githubUrl: "https://github.com/example/code", githubStars: 42 }, 10],
    ]);
  });
  it("saves repository metadata with the board revision and advances subsequent edits", async () => {
    const { command, repository } = createRepository();
    command.mockResolvedValueOnce({ revision: 9, value: snapshot })
      .mockResolvedValueOnce({ revision: 10, value: null })
      .mockResolvedValueOnce({ revision: 11, value: null });
    await repository.loadBoard();
    await repository.updatePaperGithub(node.paper.id, "https://github.com/example/code", 0);
    await repository.saveNodePositions(updates);
    expect(command.mock.calls.slice(1)).toEqual([
      [{ type: "update_paper_github", paperId: node.paper.id, githubUrl: "https://github.com/example/code", githubStars: 0 }, 9],
      [{ type: "save_node_positions", updates }, 10],
    ]);
  });
  it.each([0, 17])("returns the loaded snapshot and uses its revision %i for edits", async (revision) => {
    const { command, repository } = createRepository();
    command
      .mockResolvedValueOnce({ revision, value: snapshot })
      .mockResolvedValueOnce({ revision: revision + 4, value: null });

    await expect(repository.loadBoard()).resolves.toBe(snapshot);
    await expect(repository.saveNodePositions(updates)).resolves.toBeUndefined();

    expect(command.mock.calls).toEqual([
      [{ type: "load_board" }, undefined],
      [{ type: "save_node_positions", updates }, revision],
    ]);
  });

  it.each(edits)("requires a loaded board before attempting to %s", async (_name, edit) => {
    const { command, repository } = createRepository();

    await expect(edit(repository)).rejects.toThrow("Load the board before editing it.");
    expect(command).not.toHaveBeenCalled();
  });

  it("returns the persisted node and edge instead of constructing local records", async () => {
    const { command, repository } = createRepository();
    command
      .mockResolvedValueOnce({ revision: 3, value: { nodes: [], edges: [] } })
      .mockResolvedValueOnce({ revision: 8, value: node })
      .mockResolvedValueOnce({ revision: 12, value: snapshot.edges[0] });
    await repository.loadBoard();

    await expect(repository.createPaperNode(node.paper.id, { x: 44, y: 72 })).resolves.toBe(node);
    await expect(repository.createEdge(node.id, "node-bert")).resolves.toBe(snapshot.edges[0]);

    expect(command.mock.calls.slice(1)).toEqual([
      [{ type: "create_paper_node", paperId: node.paper.id, position: { x: 44, y: 72 } }, 3],
      [{ type: "create_edge", sourceNodeId: node.id, targetNodeId: "node-bert" }, 8],
    ]);
  });

  it.each(["support", "challenge", null] as const)("forwards the edge relation %s", async (relation) => {
    const { command, repository } = createRepository();
    command
      .mockResolvedValueOnce({ revision: 9, value: snapshot })
      .mockResolvedValueOnce({ revision: 10, value: null });
    await repository.loadBoard();

    await expect(repository.updateEdgeRelation("edge-1", relation)).resolves.toBeUndefined();
    expect(command).toHaveBeenLastCalledWith({ type: "update_edge_relation", edgeId: "edge-1", relation }, 9);
  });

  it("forwards explanation and evidence together without changing their text", async () => {
    const { command, repository } = createRepository();
    command
      .mockResolvedValueOnce({ revision: 9, value: snapshot })
      .mockResolvedValueOnce({ revision: 10, value: null });
    await repository.loadBoard();

    await expect(repository.updateEdgeAnnotations("edge-1", annotations)).resolves.toBeUndefined();
    expect(command).toHaveBeenLastCalledWith({ type: "update_edge_annotations", edgeId: "edge-1", annotations }, 9);
  });

  it("deduplicates deletion batches without changing the caller's arrays", async () => {
    const { command, repository } = createRepository();
    command
      .mockResolvedValueOnce({ revision: 9, value: snapshot })
      .mockResolvedValueOnce({ revision: 10, value: null })
      .mockResolvedValueOnce({ revision: 11, value: null });
    await repository.loadBoard();
    const nodeIds = ["node-a", "node-b", "node-a"];
    const edgeIds = ["edge-a", "edge-b", "edge-a"];

    await expect(repository.deleteNodes(nodeIds)).resolves.toBeUndefined();
    await expect(repository.deleteEdges(edgeIds)).resolves.toBeUndefined();

    expect(command.mock.calls.slice(1)).toEqual([
      [{ type: "delete_nodes", nodeIds: ["node-a", "node-b"] }, 9],
      [{ type: "delete_edges", edgeIds: ["edge-a", "edge-b"] }, 10],
    ]);
    expect(nodeIds).toEqual(["node-a", "node-b", "node-a"]);
    expect(edgeIds).toEqual(["edge-a", "edge-b", "edge-a"]);
  });

  it("skips empty moves and deletions even before the board is loaded", async () => {
    const { command, repository } = createRepository();

    await expect(repository.saveNodePositions([])).resolves.toBeUndefined();
    await expect(repository.deleteNodes([])).resolves.toBeUndefined();
    await expect(repository.deleteEdges([])).resolves.toBeUndefined();

    expect(command).not.toHaveBeenCalled();
  });

  it("serializes pending loads, creates, and updates using each successful response revision", async () => {
    const { command, repository } = createRepository();
    const initialLoad = deferred<WorkspaceResponse<BoardSnapshot>>();
    const creation = deferred<WorkspaceResponse<BoardNodeRecord>>();
    const reload = deferred<WorkspaceResponse<BoardSnapshot>>();
    command
      .mockReturnValueOnce(initialLoad.promise)
      .mockReturnValueOnce(creation.promise)
      .mockResolvedValueOnce({ revision: 12, value: snapshot.edges[0] })
      .mockResolvedValueOnce({ revision: 15, value: null })
      .mockReturnValueOnce(reload.promise)
      .mockResolvedValueOnce({ revision: 31, value: null });

    const loading = repository.loadBoard();
    const creatingNode = repository.createPaperNode(node.paper.id, node.position);
    const creatingEdge = repository.createEdge(node.id, "node-bert");
    const updating = repository.updateEdgeRelation("persisted-edge", "support");
    const reloading = repository.loadBoard();
    const saving = repository.saveNodePositions(updates);
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command).toHaveBeenLastCalledWith({ type: "load_board" }, undefined);

    initialLoad.resolve({ revision: 4, value: snapshot });
    await loading;
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command).toHaveBeenLastCalledWith({ type: "create_paper_node", paperId: node.paper.id, position: node.position }, 4);

    creation.resolve({ revision: 9, value: node });
    await expect(creatingNode).resolves.toBe(node);
    await expect(creatingEdge).resolves.toBe(snapshot.edges[0]);
    await updating;
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(5));
    expect(command.mock.calls.slice(2)).toEqual([
      [{ type: "create_edge", sourceNodeId: node.id, targetNodeId: "node-bert" }, 9],
      [{ type: "update_edge_relation", edgeId: "persisted-edge", relation: "support" }, 12],
      [{ type: "load_board" }, undefined],
    ]);

    reload.resolve({ revision: 30, value: snapshot });
    await reloading;
    await expect(saving).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledTimes(6);
    expect(command).toHaveBeenLastCalledWith({ type: "save_node_positions", updates }, 30);
  });

  it("keeps each instance's loaded revision when another instance reads and writes", async () => {
    const { command, repository } = createRepository();
    const other = new SqliteBoardRepository(command as WorkspaceCommandRunner);
    const unloaded = new SqliteBoardRepository(command as WorkspaceCommandRunner);
    command
      .mockResolvedValueOnce({ revision: 4, value: snapshot })
      .mockResolvedValueOnce({ revision: 19, value: snapshot })
      .mockResolvedValueOnce({ revision: 23, value: null })
      .mockRejectedValueOnce(new WorkspaceConflictError());

    await repository.loadBoard();
    await other.loadBoard();
    await other.updateEdgeRelation("edge-1", "support");
    await expect(unloaded.saveNodePositions(updates)).rejects.toThrow("Load the board before editing it.");
    await expect(repository.saveNodePositions(updates)).rejects.toBeInstanceOf(WorkspaceConflictError);

    expect(command.mock.calls).toEqual([
      [{ type: "load_board" }, undefined],
      [{ type: "load_board" }, undefined],
      [{ type: "update_edge_relation", edgeId: "edge-1", relation: "support" }, 19],
      [{ type: "save_node_positions", updates }, 4],
    ]);
  });

  it("preserves the last successful revision on conflict without retrying until an explicit load", async () => {
    const { command, repository } = createRepository();
    const conflict = new WorkspaceConflictError();
    command
      .mockResolvedValueOnce({ revision: 4, value: snapshot })
      .mockResolvedValueOnce({ revision: 7, value: null })
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ revision: 40, value: snapshot })
      .mockResolvedValueOnce({ revision: 45, value: node });
    await repository.loadBoard();
    await repository.saveNodePositions(updates);

    const results = await Promise.allSettled([
      repository.createPaperNode(node.paper.id, node.position),
      repository.updateEdgeAnnotations("edge-1", annotations),
    ]);

    expect(results).toEqual([
      { status: "rejected", reason: conflict },
      { status: "rejected", reason: conflict },
    ]);
    expect(command.mock.calls).toEqual([
      [{ type: "load_board" }, undefined],
      [{ type: "save_node_positions", updates }, 4],
      [{ type: "create_paper_node", paperId: node.paper.id, position: node.position }, 7],
      [{ type: "update_edge_annotations", edgeId: "edge-1", annotations }, 7],
    ]);

    await expect(repository.loadBoard()).resolves.toBe(snapshot);
    await expect(repository.createPaperNode(node.paper.id, node.position)).resolves.toBe(node);
    expect(command.mock.calls.slice(4)).toEqual([
      [{ type: "load_board" }, undefined],
      [{ type: "create_paper_node", paperId: node.paper.id, position: node.position }, 40],
    ]);
  });

  it("does not enable edits after a failed initial load and permits a later load", async () => {
    const { command, repository } = createRepository();
    const failure = new Error("workspace unavailable");
    command
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ revision: 6, value: snapshot })
      .mockResolvedValueOnce({ revision: 7, value: null });

    await expect(repository.loadBoard()).rejects.toBe(failure);
    await expect(repository.saveNodePositions(updates)).rejects.toThrow("Load the board before editing it.");
    expect(command).toHaveBeenCalledOnce();

    await repository.loadBoard();
    await repository.saveNodePositions(updates);
    expect(command).toHaveBeenLastCalledWith({ type: "save_node_positions", updates }, 6);
  });

  it("propagates a failed reload without discarding the last successful revision", async () => {
    const { command, repository } = createRepository();
    const failure = new Error("workspace unavailable");
    command
      .mockResolvedValueOnce({ revision: 12, value: snapshot })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ revision: 13, value: null });
    await repository.loadBoard();

    await expect(repository.loadBoard()).rejects.toBe(failure);
    await repository.saveNodePositions(updates);

    expect(command).toHaveBeenCalledTimes(3);
    expect(command).toHaveBeenLastCalledWith({ type: "save_node_positions", updates }, 12);
  });
});
