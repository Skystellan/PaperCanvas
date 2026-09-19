import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { listRecentPaperWebChats, type RecentPaperWebChat } from "./services/paperWebChats";
import { RecentDiscussions } from "./RecentDiscussions";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("./services/paperWebChats", () => ({ listRecentPaperWebChats: vi.fn() }));
const chat: RecentPaperWebChat = { id: "web-chat-1", paperId: "paper-1", paperTitle: "Attention", title: "模型推导", url: "https://chatgpt.com/c/test", lastOpenedAt: 1000 };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(listRecentPaperWebChats).mockResolvedValue([chat]); });

describe("RecentDiscussions", () => {
  it("resizes with dragging and the keyboard, and restores its width after hiding", async () => {
    render(<RecentDiscussions />);
    await screen.findByText("模型推导");
    const panel = screen.getByRole("complementary", { name: "Recent discussions" });
    const handle = screen.getByRole("separator", { name: "Resize recent discussions" });
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();
    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 700 }));
    fireEvent(handle, new MouseEvent("pointermove", { bubbles: true, clientX: 620 }));
    expect(panel).toHaveStyle({ width: "350px" });
    fireEvent(handle, new MouseEvent("pointerup", { bubbles: true, clientX: 620 }));
    fireEvent(handle, new MouseEvent("pointermove", { bubbles: true, clientX: 500 }));
    expect(panel).toHaveStyle({ width: "350px" });
    fireEvent.click(screen.getByRole("button", { name: "Hide recent discussions" }));
    expect(panel).toHaveStyle({ width: "36px" });
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByText("模型推导")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show recent discussions" }));
    expect(panel).toHaveStyle({ width: "350px" });
    const restored = screen.getByRole("separator");
    fireEvent.keyDown(restored, { key: "ArrowLeft" });
    expect(restored).toHaveAttribute("aria-valuenow", "366");
    fireEvent.keyDown(restored, { key: "Home" });
    fireEvent.keyDown(restored, { key: "ArrowRight" });
    expect(panel).toHaveStyle({ width: "240px" });
    fireEvent.keyDown(restored, { key: "End" });
    expect(restored.getAttribute("aria-valuenow")).toBe(restored.getAttribute("aria-valuemax"));
    fireEvent.doubleClick(restored);
    expect(panel).toHaveStyle({ width: "270px" });
  });

  it("shows paper-bound web chats and opens the exact selected conversation", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    render(<RecentDiscussions limit={5} onOpenDiscussion={open} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open 模型推导 — Attention" }));
    expect(open).toHaveBeenCalledWith(chat);
    expect(listRecentPaperWebChats).toHaveBeenCalledWith(5);
    expect(await screen.findByText("ChatGPT")).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("refreshes on return from the reader and on catalog changes", async () => {
    const view = render(<RecentDiscussions active={false} />);
    expect(listRecentPaperWebChats).not.toHaveBeenCalled();
    view.rerender(<RecentDiscussions active />);
    expect(await screen.findByText("模型推导")).toBeVisible();
    view.rerender(<RecentDiscussions active={false} />);
    vi.mocked(listRecentPaperWebChats).mockResolvedValue([{ ...chat, title: "新的聊天标题" }]);
    view.rerender(<RecentDiscussions active />);
    expect(await screen.findByText("新的聊天标题")).toBeVisible();
    vi.mocked(listRecentPaperWebChats).mockResolvedValue([]);
    view.rerender(<RecentDiscussions active catalogRevision={1} />);
    expect(await screen.findByText(/No discussions yet/)).toBeVisible();
  });

  it("refreshes native title updates without allowing a stale request to overwrite them", async () => {
    let resolveOld!: (items: RecentPaperWebChat[]) => void;
    vi.mocked(listRecentPaperWebChats).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    render(<RecentDiscussions />);
    await waitFor(() => expect(listRecentPaperWebChats).toHaveBeenCalled());
    vi.mocked(listRecentPaperWebChats).mockResolvedValue([{ ...chat, title: "最新标题" }]);
    const update = vi.mocked(listen).mock.calls[0][1];
    await act(async () => update({ event: "paper-web-chat-updated", id: 1, payload: chat }));
    expect(await screen.findByText("最新标题")).toBeVisible();
    await act(async () => resolveOld([chat]));
    expect(screen.queryByText("模型推导")).toBeNull();
  });

  it("retries database failures and displays conversations that have not started", async () => {
    vi.mocked(listRecentPaperWebChats).mockRejectedValue(new Error("busy"));
    render(<RecentDiscussions />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/);
    vi.mocked(listRecentPaperWebChats).mockResolvedValue([{ ...chat, url: null }]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Not started")).toBeVisible();
  });
});
