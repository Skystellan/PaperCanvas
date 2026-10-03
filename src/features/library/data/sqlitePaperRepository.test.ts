import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceCommandRunner } from "../../../data/workspaceClient";
import type { Paper } from "../model/paper";
import { SqlitePaperRepository } from "./sqlitePaperRepository";

const command = vi.fn<WorkspaceCommandRunner>();
const papers: Paper[] = [
  {
    id: "paper-1",
    title: "Attention Is All You Need",
    authors: null,
    year: null,
    filePath: "papers/paper-1.pdf",
    domainId: "domain-ai",
    createdAt: 1_774_000_000_000,
  },
  {
    id: "paper-legacy",
    title: "A legacy paper",
    authors: "A. Researcher",
    year: 1999,
    filePath: null,
    domainId: null,
    createdAt: 1,
  },
];

describe("SqlitePaperRepository", () => {
  beforeEach(() => {
    command.mockReset();
  });

  it("passes the search term unchanged and returns the persisted papers", async () => {
    command.mockResolvedValue({ revision: 17, value: papers });
    const repository = new SqlitePaperRepository(command as WorkspaceCommandRunner);
    const searchTerm = "  attention%_'  ";

    await expect(repository.list(searchTerm)).resolves.toBe(papers);

    expect(command).toHaveBeenCalledExactlyOnceWith({ type: "list_papers", searchTerm });
  });

  it("requests all papers with an empty search term by default", async () => {
    command.mockResolvedValue({ revision: 17, value: [] });
    const repository = new SqlitePaperRepository(command as WorkspaceCommandRunner);

    await expect(repository.list()).resolves.toEqual([]);

    expect(command).toHaveBeenCalledExactlyOnceWith({ type: "list_papers", searchTerm: "" });
  });

  it("gets one paper by its stable id and returns the persisted record", async () => {
    const paper = { ...papers[0], id: "paper-' OR 1=1 --" };
    command.mockResolvedValue({ revision: 17, value: paper });
    const repository = new SqlitePaperRepository(command as WorkspaceCommandRunner);

    await expect(repository.getById(paper.id)).resolves.toBe(paper);

    expect(command).toHaveBeenCalledExactlyOnceWith({ type: "get_paper", id: paper.id });
  });

  it("returns null when the service reports an unknown paper", async () => {
    command.mockResolvedValue({ revision: 17, value: null });
    const repository = new SqlitePaperRepository(command as WorkspaceCommandRunner);

    await expect(repository.getById("missing")).resolves.toBeNull();
    expect(command).toHaveBeenCalledExactlyOnceWith({ type: "get_paper", id: "missing" });
  });

  it.each(["list", "getById"] as const)("propagates %s command errors without retrying", async (method) => {
    const failure = new Error("workspace unavailable");
    command.mockRejectedValue(failure);
    const repository = new SqlitePaperRepository(command as WorkspaceCommandRunner);

    await expect(repository[method]("paper-1")).rejects.toBe(failure);
    expect(command).toHaveBeenCalledOnce();
  });
});
