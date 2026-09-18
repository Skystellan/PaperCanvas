import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { WebChatPanel } from "./WebChatPanel";
import { layoutPaperWebChat, listPaperWebChats } from "./services/paperWebChats";
import type { Paper } from "../library";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("./services/paperWebChats", () => ({ listPaperWebChats: vi.fn(), layoutPaperWebChat: vi.fn(async () => {}) }));
const paper: Paper = { id: "paper-a", title: "Paper A", authors: null, year: null, filePath: "papers/a.pdf", domainId: null, createdAt: 1 };
const chat = { id: "chat-a", paperId: paper.id, title: "公式推导", url: "https://chatgpt.com/c/6aa9ff1f-b11c-83ee-8e6f-f69405b4f239", lastOpenedAt: 10 };

describe("paper conversation bindings", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(listPaperWebChats).mockResolvedValue([chat]); });

  it("restores the last discussion and switches between discussions for the same paper", async () => {
    vi.mocked(listPaperWebChats).mockResolvedValue([chat, { ...chat, id: "chat-b", title: "实验复现", lastOpenedAt: 5 }]);
    render(<WebChatPanel paper={paper} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("chat-a"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "chat-b" } });
    expect(screen.getByRole("combobox")).toHaveValue("chat-b");
    await waitFor(() => expect(layoutPaperWebChat).toHaveBeenCalledWith("chat-a", null));
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
