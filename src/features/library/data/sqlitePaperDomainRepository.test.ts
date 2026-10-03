import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceCommandRunner } from "../../../data/workspaceClient";
import type { PaperDomain } from "../model/paperDomain";
import { SqlitePaperDomainRepository } from "./sqlitePaperDomainRepository";

const command = vi.fn<WorkspaceCommandRunner>();

describe("SqlitePaperDomainRepository", () => {
  beforeEach(() => {
    command.mockReset();
  });

  it("returns the service's domain records in their persisted order", async () => {
    const domains: PaperDomain[] = [
      { id: "domain-systems", name: "Systems", createdAt: 10, updatedAt: 20 },
      { id: "domain-ai", name: "AI", createdAt: 30, updatedAt: 40 },
    ];
    command.mockResolvedValue({ revision: 5, value: domains });
    const repository = new SqlitePaperDomainRepository(command as WorkspaceCommandRunner);

    await expect(repository.list()).resolves.toBe(domains);

    expect(command).toHaveBeenCalledExactlyOnceWith({ type: "list_domains" });
  });

  it("leaves name normalization and generated metadata to the service", async () => {
    const domain: PaperDomain = {
      id: "persisted-domain",
      name: "Human–AI",
      createdAt: 123,
      updatedAt: 456,
    };
    command.mockResolvedValue({ revision: 6, value: domain });
    const repository = new SqlitePaperDomainRepository(command as WorkspaceCommandRunner);

    await expect(repository.create("  Human–AI  ")).resolves.toBe(domain);

    expect(command).toHaveBeenCalledExactlyOnceWith({ type: "create_domain", name: "  Human–AI  " });
  });

  it.each(["", "   ", "a".repeat(81)])("propagates service validation of the raw name %j", async (name) => {
    const failure = new Error("领域名称必须为 1 到 80 个字符。");
    command.mockRejectedValue(failure);
    const repository = new SqlitePaperDomainRepository(command as WorkspaceCommandRunner);

    await expect(repository.create(name)).rejects.toBe(failure);

    expect(command).toHaveBeenCalledExactlyOnceWith({ type: "create_domain", name });
  });

  it("forwards rename, assignment, unassignment, and deletion without a board revision", async () => {
    command.mockResolvedValue({ revision: 8, value: null });
    const repository = new SqlitePaperDomainRepository(command as WorkspaceCommandRunner);

    await expect(repository.rename("domain-' OR 1=1 --", "  Systems  ")).resolves.toBeUndefined();
    await expect(repository.assignPaper("paper-' OR 1=1 --", "domain-ai")).resolves.toBeUndefined();
    await expect(repository.assignPaper("paper-2", null)).resolves.toBeUndefined();
    await expect(repository.delete("domain-ai")).resolves.toBeUndefined();

    expect(command.mock.calls).toEqual([
      [{ type: "rename_domain", domainId: "domain-' OR 1=1 --", name: "  Systems  " }],
      [{ type: "assign_paper", paperId: "paper-' OR 1=1 --", domainId: "domain-ai" }],
      [{ type: "assign_paper", paperId: "paper-2", domainId: null }],
      [{ type: "delete_domain", domainId: "domain-ai" }],
    ]);
  });

  const operations: [string, (repository: SqlitePaperDomainRepository) => Promise<unknown>][] = [
    ["list", (repository) => repository.list()],
    ["create", (repository) => repository.create("AI")],
    ["rename", (repository) => repository.rename("missing", "New name")],
    ["delete", (repository) => repository.delete("missing")],
    ["assign", (repository) => repository.assignPaper("missing", "domain-ai")],
    ["unassign", (repository) => repository.assignPaper("missing", null)],
  ];

  it.each(operations)("propagates %s failures without retrying or claiming success", async (_name, operation) => {
    const failure = new Error("workspace command failed");
    command.mockRejectedValue(failure);
    const repository = new SqlitePaperDomainRepository(command as WorkspaceCommandRunner);

    await expect(operation(repository)).rejects.toBe(failure);
    expect(command).toHaveBeenCalledOnce();
  });
});
