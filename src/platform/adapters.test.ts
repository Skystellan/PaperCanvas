import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Channel, invoke, isTauri } from "./core";
import { listen } from "./event";
import { getCurrentWindow } from "./window";
import { getCurrentWebview } from "./webview";
import { BaseDirectory, readFile } from "./fs";
import { open } from "./dialog";
import Database from "./sql";

type Handler = (payload: unknown) => void | Promise<void>;
const listeners = new Map<string, Set<Handler>>();
const nativeInvoke = vi.fn();
const getPathForFile = vi.fn();
async function emit(event: string, payload?: unknown) {
  await Promise.all([...listeners.get(event) ?? []].map((handler) => handler(payload)));
}

beforeEach(() => {
  nativeInvoke.mockReset();
  getPathForFile.mockReset();
  listeners.clear();
  window.paperCanvas = {
    invoke: nativeInvoke,
    getPathForFile,
    on(event, callback) {
      const handlers = listeners.get(event) ?? new Set<Handler>();
      listeners.set(event, handlers);
      handlers.add(callback);
      return () => { handlers.delete(callback); };
    },
  };
});
afterEach(() => { delete window.paperCanvas; });

describe("Electron platform adapters", () => {
  it("routes commands and event payloads and removes subscriptions", async () => {
    expect(isTauri()).toBe(true);
    nativeInvoke.mockResolvedValue({ ok: true });
    await expect(invoke("import_pdf", { sourcePath: "/paper.pdf" })).resolves.toEqual({ ok: true });
    expect(nativeInvoke).toHaveBeenCalledWith("import_pdf", { sourcePath: "/paper.pdf" });
    const callback = vi.fn();
    const stop = await listen("paper-web-chat-updated", callback);
    await emit("paper-web-chat-updated", { id: "chat" });
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ payload: { id: "chat" } }));
    stop();
    await emit("paper-web-chat-updated", {});
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("subscribes before starting Codex, filters request ids and cleans up", async () => {
    const channel = new Channel<unknown>();
    channel.onmessage = vi.fn();
    nativeInvoke.mockImplementation(async () => {
      await emit("codex-stream", { requestId: "other", event: { type: "error" } });
      await emit("codex-stream", { requestId: "one", event: { type: "completed" } });
    });
    await invoke("start_codex_turn", { request: { requestId: "one" }, onEvent: channel });
    expect(nativeInvoke).toHaveBeenCalledWith("start_codex_turn", { request: { requestId: "one" } });
    expect(channel.onmessage).toHaveBeenCalledExactlyOnceWith({ type: "completed" });
    expect(listeners.get("codex-stream")?.size).toBe(0);
    nativeInvoke.mockRejectedValue(new Error("failed"));
    await expect(invoke("start_codex_turn", { request: { requestId: "one" }, onEvent: channel })).rejects.toThrow("failed");
    expect(listeners.get("codex-stream")?.size).toBe(0);
  });

  it("honors async save-on-close prevention and allows explicit destroy", async () => {
    const appWindow = getCurrentWindow();
    let finishSave!: () => void;
    const saved = new Promise<void>((resolve) => { finishSave = resolve; });
    const stop = await appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      await saved;
      await appWindow.destroy();
    });
    const closing = emit("native-close-requested");
    expect(nativeInvoke).not.toHaveBeenCalled();
    finishSave();
    await closing;
    expect(nativeInvoke).toHaveBeenCalledExactlyOnceWith("window_destroy");
    stop();
    nativeInvoke.mockClear();
    await appWindow.onCloseRequested(() => {});
    await emit("native-close-requested");
    expect(nativeInvoke).toHaveBeenCalledExactlyOnceWith("window_destroy");
  });

  it("maps database, PDF file and dialog operations", async () => {
    nativeInvoke.mockResolvedValueOnce("sqlite:papercanvas.db");
    const db = await Database.load("sqlite:papercanvas.db");
    expect(db.path).toBe("sqlite:papercanvas.db");
    expect(nativeInvoke).toHaveBeenLastCalledWith("database_load");
    nativeInvoke.mockResolvedValueOnce([{ id: 1 }]);
    await expect(db.select("SELECT ?", [1])).resolves.toEqual([{ id: 1 }]);
    expect(nativeInvoke).toHaveBeenLastCalledWith("database_select", { query: "SELECT ?", values: [1] });
    nativeInvoke.mockResolvedValueOnce({ rowsAffected: 1 });
    await expect(db.execute("DELETE FROM papers")).resolves.toEqual({ rowsAffected: 1 });
    expect(nativeInvoke).toHaveBeenLastCalledWith("database_execute", { query: "DELETE FROM papers", values: [] });
    nativeInvoke.mockResolvedValueOnce([37, 80, 68, 70]);
    await expect(readFile("papers/a.pdf", { baseDir: BaseDirectory.AppData })).resolves.toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(nativeInvoke).toHaveBeenLastCalledWith("read_file", { path: "papers/a.pdf" });
    nativeInvoke.mockResolvedValueOnce(["/a.pdf"]);
    await expect(open({ multiple: true })).resolves.toEqual(["/a.pdf"]);
    expect(nativeInvoke).toHaveBeenLastCalledWith("open_pdf_dialog");
  });

  it("uses preload paths for dropped files, client coordinates, and removable DOM listeners", async () => {
    const handler = vi.fn();
    const stop = await getCurrentWebview().onDragDropEvent(handler);
    const file = new File(["pdf"], "paper.pdf");
    getPathForFile.mockReturnValue("/granted/paper.pdf");
    const drop = new MouseEvent("drop", { clientX: 50, clientY: 70, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [file] } });
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(getPathForFile).toHaveBeenCalledExactlyOnceWith(file);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ payload: { type: "drop", paths: ["/granted/paper.pdf"], position: { x: 50, y: 70 } } }));
    stop();
    window.dispatchEvent(drop);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
