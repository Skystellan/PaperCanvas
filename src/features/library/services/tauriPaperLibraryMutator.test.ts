import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

import { TauriPaperLibraryMutator } from "./tauriPaperLibraryMutator";

describe("TauriPaperLibraryMutator", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
  });

  it("passes the paper id to the delete_paper Tauri command", async () => {
    tauri.invoke.mockResolvedValue(undefined);
    const mutator = new TauriPaperLibraryMutator();

    await expect(mutator.deletePaper("paper-1")).resolves.toBeUndefined();

    expect(tauri.invoke).toHaveBeenCalledOnce();
    expect(tauri.invoke).toHaveBeenCalledWith("delete_paper", {
      paperId: "paper-1",
    });
  });

  it("exposes an explicit storage reconciliation command", async () => {
    tauri.invoke.mockResolvedValue(undefined);
    const mutator = new TauriPaperLibraryMutator();

    await expect(mutator.reconcileStorage()).resolves.toBeUndefined();

    expect(tauri.invoke).toHaveBeenCalledWith("reconcile_pdf_storage");
  });
});
