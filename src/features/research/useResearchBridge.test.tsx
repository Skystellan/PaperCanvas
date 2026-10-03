import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "../../platform/core";
import { listen } from "../../platform/event";
import { executeWorkspaceCommand } from "../../data/workspaceClient";
import { useResearchBridge } from "./useResearchBridge";

vi.mock("../../platform/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("../../platform/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("../../data/workspaceClient", () => ({ executeWorkspaceCommand: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  window.paperCanvas = { invoke: vi.fn(), on: vi.fn(), getPathForFile: vi.fn() };
  vi.mocked(executeWorkspaceCommand).mockResolvedValue({ revision: 1, value: { batchId: "batch-1", placements: [{ paperId: "new" }] } });
});
afterEach(() => { delete window.paperCanvas; });

function setup(selectedPaperIds: string[] = []) {
  const flushPending = vi.fn(async () => {});
  const refreshWorkspace = vi.fn(async () => {});
  const hook = renderHook(() => useResearchBridge({ ready: true, selectedPaperIds, flushPending, refreshWorkspace }));
  const send = async (tool: string, args: unknown) => {
    await act(async () => {
      vi.mocked(listen).mock.calls[0][1]({ event: "research-tool-request", id: 0, payload: { id: "request", tool, args } });
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("research_tool_reply", expect.objectContaining({ id: "request" })));
  };
  return { hook, send, flushPending, refreshWorkspace };
}

it("never reads old context on startup or independent import, and saves before writing", async () => {
  const { send, flushPending, refreshWorkspace } = setup(["private-existing-paper"]);
  expect(executeWorkspaceCommand).not.toHaveBeenCalled();
  const batch = { requestId: "one", title: "New direction", papers: [] };
  await send("import_research_batch", batch);
  expect(executeWorkspaceCommand).toHaveBeenCalledExactlyOnceWith({ type: "import_research_batch", batch });
  expect(flushPending.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(executeWorkspaceCommand).mock.invocationCallOrder[0]);
  expect(refreshWorkspace).toHaveBeenCalledOnce();
});

it("uses only actual selected papers and never falls back to the board", async () => {
  const selected = setup(["one", "two"]);
  await selected.send("read_research_context", { intent: "selected_papers" });
  expect(executeWorkspaceCommand).toHaveBeenCalledExactlyOnceWith({ type: "read_research_context", intent: "selected_papers", paperIds: ["one", "two"] });
  expect(selected.flushPending).not.toHaveBeenCalled();
  selected.hook.unmount();
  vi.clearAllMocks();
  const empty = setup();
  await empty.send("read_research_context", { intent: "selected_papers" });
  expect(executeWorkspaceCommand).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenLastCalledWith("research_tool_reply", { id: "request", error: expect.stringContaining("NO_SELECTION") });
});

it("honors explicit paper IDs for gap analysis and refuses an independent context request", async () => {
  const { send } = setup(["not-requested"]);
  await send("read_research_context", { intent: "gap_analysis", paperIds: ["requested"] });
  expect(executeWorkspaceCommand).toHaveBeenCalledExactlyOnceWith({ type: "read_research_context", intent: "gap_analysis", paperIds: ["requested"] });
  vi.mocked(executeWorkspaceCommand).mockClear();
  await send("read_research_context", { intent: "independent" });
  expect(executeWorkspaceCommand).not.toHaveBeenCalled();
});

it("does not commit when saving the current draft fails", async () => {
  const { send, flushPending, refreshWorkspace } = setup();
  flushPending.mockRejectedValue(new Error("Draft save failed"));
  await send("import_research_batch", { papers: [] });
  expect(executeWorkspaceCommand).not.toHaveBeenCalled();
  expect(refreshWorkspace).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenLastCalledWith("research_tool_reply", { id: "request", error: "Draft save failed" });
});

it("reports a committed batch even if the view cannot reload", async () => {
  const { send, refreshWorkspace } = setup();
  refreshWorkspace.mockRejectedValue(new Error("View failed"));
  await send("import_research_batch", { papers: [] });
  expect(invoke).toHaveBeenLastCalledWith("research_tool_reply", { id: "request", result: expect.objectContaining({ batchId: "batch-1", viewUpdated: false }) });
});
