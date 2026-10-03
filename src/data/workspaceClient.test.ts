import { beforeEach, expect, it, vi } from "vitest";
import { invoke, isTauri } from "../platform/core";
import { listen } from "../platform/event";
import { getDatabase } from "./sqliteDatabase";
import { executeWorkspaceCommand, listenForExternalWorkspaceChanges, workspaceOrigin, WorkspaceConflictError } from "./workspaceClient";

vi.mock("../platform/core", () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("../platform/event", () => ({ listen: vi.fn() }));
vi.mock("./sqliteDatabase", () => ({ getDatabase: vi.fn(async () => ({})) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
});

it("initializes storage before forwarding the command and its observed revision", async () => {
  const reply = { revision: 4, value: null, changed: true };
  vi.mocked(invoke).mockResolvedValue(reply);
  const request = { type: "delete_edges" as const, edgeIds: ["edge"] };
  await expect(executeWorkspaceCommand(request, 3)).resolves.toBe(reply);
  expect(getDatabase).toHaveBeenCalledOnce();
  expect(vi.mocked(getDatabase).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(invoke).mock.invocationCallOrder[0]);
  expect(invoke).toHaveBeenCalledWith("workspace_command", { request, expectedRevision: 3, origin: workspaceOrigin });
});

it("reports a revision conflict without retrying the stale write", async () => {
  vi.mocked(invoke).mockRejectedValue("WORKSPACE_CONFLICT");
  await expect(executeWorkspaceCommand({ type: "delete_edges", edgeIds: ["edge"] }, 3)).rejects.toBeInstanceOf(WorkspaceConflictError);
  expect(invoke).toHaveBeenCalledOnce();
});

it("ignores this renderer's notifications but delivers other clients' changes", async () => {
  const stop = vi.fn();
  vi.mocked(listen).mockResolvedValue(stop);
  const changed = vi.fn();
  await expect(listenForExternalWorkspaceChanges(changed)).resolves.toBe(stop);
  const handler = vi.mocked(listen).mock.calls[0][1];
  handler({ event: "workspace-changed", id: 0, payload: { revision: 4, origin: workspaceOrigin } });
  expect(changed).not.toHaveBeenCalled();
  handler({ event: "workspace-changed", id: 0, payload: { revision: 5, origin: "another-client" } });
  handler({ event: "workspace-changed", id: 0, payload: { revision: 6, origin: null } });
  expect(changed).toHaveBeenCalledTimes(2);
});

it("does not register a native listener in browser preview", async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  const stop = await listenForExternalWorkspaceChanges(vi.fn());
  stop();
  expect(listen).not.toHaveBeenCalled();
});
