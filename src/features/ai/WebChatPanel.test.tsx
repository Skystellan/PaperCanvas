import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebChatPanel } from "./WebChatPanel";
import { layoutPaperWebChat, listPaperWebChats } from "./services/paperWebChats";
import type { Paper } from "../library";
import { ReaderToolbarContext } from "../reader/ReaderToolbarContext";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("./services/paperWebChats", () => ({ listPaperWebChats: vi.fn(), layoutPaperWebChat: vi.fn(async () => {}) }));
const paper: Paper = { id: "paper-a", title: "Paper A", authors: null, year: null, filePath: "papers/a.pdf", domainId: null, createdAt: 1 };
const chat = { id: "chat-a", paperId: paper.id, title: "公式推导", url: "https://chatgpt.com/c/6aa9ff1f-b11c-83ee-8e6f-f69405b4f239", lastOpenedAt: 10 };

describe("paper conversation bindings", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(listPaperWebChats).mockResolvedValue([chat]); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  function layoutHarness() {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    let resize!: () => void;
    const disconnect = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    let width = 400;
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => new DOMRect(100, 100, width, 500));
    return {
      frames, measure, disconnect,
      resize(value: number) { width = value; resize(); },
      async flush() {
        await act(async () => {
          const callbacks = [...frames.values()];
          frames.clear();
          callbacks.forEach((callback) => callback(0));
        });
      },
    };
  }

  it("stops measuring at rest and updates bounds only after layout events", async () => {
    const layout = layoutHarness();
    const view = render(<WebChatPanel paper={paper} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue(chat.id));
    await layout.flush();
    await layout.flush();
    expect(layout.frames.size).toBe(0);
    const reads = layout.measure.mock.calls.length;
    await layout.flush();
    expect(layout.measure).toHaveBeenCalledTimes(reads);
    expect(layoutPaperWebChat).toHaveBeenCalledTimes(1);
    layout.resize(450);
    layout.resize(480);
    expect(layout.frames.size).toBe(1);
    await layout.flush();
    expect(layoutPaperWebChat).toHaveBeenLastCalledWith(chat.id, expect.objectContaining({ width: 480 }));
    view.unmount();
    expect(layout.disconnect).toHaveBeenCalled();
    expect(layout.frames.size).toBe(0);
    expect(layoutPaperWebChat).toHaveBeenLastCalledWith(chat.id, null);
  });

  it("does not lose a resize while a native update is pending and stops work when hidden", async () => {
    const layout = layoutHarness();
    let complete!: () => void;
    vi.mocked(layoutPaperWebChat).mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    const panel = (visible: boolean) => <ReaderToolbarContext.Provider value={{ workspace: null, chat: null, visible }}><WebChatPanel paper={paper} /></ReaderToolbarContext.Provider>;
    const view = render(panel(true));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue(chat.id));
    await layout.flush();
    layout.resize(480);
    await layout.flush();
    expect(layoutPaperWebChat).toHaveBeenCalledTimes(1);
    await act(async () => complete());
    await layout.flush();
    expect(layoutPaperWebChat).toHaveBeenLastCalledWith(chat.id, expect.objectContaining({ width: 480 }));
    view.rerender(panel(false));
    expect(layout.frames.size).toBe(0);
    expect(layoutPaperWebChat).toHaveBeenLastCalledWith(chat.id, null);
    view.rerender(panel(true));
    await layout.flush();
    expect(layoutPaperWebChat).toHaveBeenLastCalledWith(chat.id, expect.objectContaining({ width: 480 }));
    view.unmount();
  });

  it("restores the last discussion and switches between discussions for the same paper", async () => {
    vi.mocked(listPaperWebChats).mockResolvedValue([chat, { ...chat, id: "chat-b", title: "实验复现", lastOpenedAt: 5 }]);
    render(<WebChatPanel paper={paper} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("chat-a"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "chat-b" } });
    expect(screen.getByRole("combobox")).toHaveValue("chat-b");
    await waitFor(() => expect(layoutPaperWebChat).toHaveBeenCalledWith("chat-a", null));
  });

  it("opens the requested recent discussion rather than the latest one", async () => {
    vi.mocked(listPaperWebChats).mockResolvedValue([chat, { ...chat, id: "chat-b", title: "实验复现", lastOpenedAt: 5 }]);
    render(<WebChatPanel paper={paper} initialChatId="chat-b" />);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("chat-b"));
  });

  it("creates a discussion bound to the open paper without uploading or submitting messages", async () => {
    vi.mocked(invoke).mockResolvedValue({ ...chat, id: "new-chat", title: "新对话", url: null });
    render(<WebChatPanel paper={paper} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "新对话" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    expect(screen.queryByLabelText("讨论名称")).not.toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_paper_web_chat", { paperId: paper.id, id: null, title: "新对话", url: null }));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("new-chat"));
    expect(screen.getByText("发出首条消息后自动保存对话链接")).toBeVisible();
  });

  it("associates a pasted conversation link with this paper", async () => {
    vi.mocked(invoke).mockResolvedValue(chat);
    render(<WebChatPanel paper={paper} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "关联已有对话" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "关联已有对话" }));
    fireEvent.change(screen.getByLabelText("ChatGPT 对话链接"), { target: { value: chat.url } });
    fireEvent.click(screen.getByRole("button", { name: "保存并打开" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_paper_web_chat", expect.objectContaining({ paperId: paper.id, url: chat.url })));
  });

  it("opens the bound discussion in the user's browser", async () => {
    render(<WebChatPanel paper={paper} />);
    fireEvent.click(await screen.findByRole("button", { name: "在浏览器中打开" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_paper_web_chat_external", { id: chat.id }));
  });

  it("retries the webpage and keeps another conversation's load state separate", async () => {
    render(<WebChatPanel paper={paper} />);
    await screen.findByRole("button", { name: "重新加载网页" });
    const callback = vi.mocked(listen).mock.calls.find(([event]) => event === "paper-web-chat-load-state")?.[1];
    expect(callback).toBeDefined();
    act(() => callback!({ event: "paper-web-chat-load-state", id: 1, payload: { id: "other-chat", status: "failed", message: "其他对话失败" } }));
    expect(screen.queryByText("其他对话失败")).not.toBeInTheDocument();
    act(() => callback!({ event: "paper-web-chat-load-state", id: 1, payload: { id: chat.id, status: "verification", message: "网站验证尚未完成" } }));
    expect(screen.getByRole("status")).toHaveTextContent("网站验证尚未完成");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("reload_paper_web_chat", { id: chat.id }));
    act(() => callback!({ event: "paper-web-chat-load-state", id: 1, payload: { id: chat.id, status: "ready", message: "" } }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(/正在打开 ChatGPT/)).not.toBeInTheDocument();
  });

  it("explains the embedded Google sign-in limit and opens the saved chat in a browser", async () => {
    render(<WebChatPanel paper={paper} />);
    await screen.findByRole("button", { name: "登录帮助" });
    const callback = vi.mocked(listen).mock.calls.find(([event]) => event === "paper-web-chat-login-required")?.[1];
    expect(callback).toBeDefined();
    act(() => callback!({ event: "paper-web-chat-login-required", id: 1, payload: { id: chat.id } }));
    expect(screen.getByRole("status")).toHaveTextContent("浏览器的登录状态不会同步到这里");
    fireEvent.click(screen.getByRole("button", { name: "打开浏览器继续" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_paper_web_chat_external", { id: chat.id }));
    fireEvent.click(screen.getByRole("button", { name: "关联浏览器对话" }));
    expect(screen.getByLabelText("ChatGPT 对话链接")).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not load paper A's late result into paper B", async () => {
    let resolveA!: (value: typeof chat[]) => void;
    vi.mocked(listPaperWebChats).mockImplementation((id) => id === paper.id ? new Promise((resolve) => { resolveA = resolve; }) : Promise.resolve([]));
    const view = render(<WebChatPanel paper={paper} />);
    view.rerender(<WebChatPanel paper={{ ...paper, id: "paper-b", title: "Paper B" }} />);
    await act(async () => resolveA([chat]));
    expect(screen.queryByRole("option", { name: "公式推导" })).not.toBeInTheDocument();
    expect(screen.getByText("Paper B")).toBeVisible();
  });
});
