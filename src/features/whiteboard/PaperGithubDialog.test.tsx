import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGithubStars } from "../library/services/githubRepository";
import { PaperGithubDialog } from "./PaperGithubDialog";

vi.mock("../library/services/githubRepository", () => ({ fetchGithubStars: vi.fn() }));

const paper = { id: "a", title: "Paper", authors: null, year: null, domainId: null, filePath: null,
  createdAt: 0, githubUrl: "https://github.com/example/code", githubStars: 42 };

beforeEach(() => {
  vi.mocked(fetchGithubStars).mockReset();
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.setAttribute("open", ""); } },
    close: { configurable: true, value() { this.removeAttribute("open"); } },
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

describe("lazy GitHub refresh", () => {
  it("shows the review evidence for a paper without a repository, without requesting Stars", () => {
    render(<PaperGithubDialog paper={{ ...paper, githubUrl: null, githubStars: null,
      codeReview: { status: "not_found", evidenceUrl: "https://example.org/paper", evidence: "已检查论文与作者项目页，尚未发现实现代码。", checkedAt: 1 } }}
      onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("region", { name: "代码审查记录" })).toHaveTextContent("暂未找到代码");
    expect(screen.getByRole("link", { name: "查看查证依据 ↗" })).toHaveAttribute("href", "https://example.org/paper");
    expect(fetchGithubStars).not.toHaveBeenCalled();
  });
  it("makes one request per opening even in Strict Mode, persists it and fetches again on reopen", async () => {
    vi.mocked(fetchGithubStars).mockResolvedValueOnce(0).mockResolvedValueOnce(88);
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const { unmount, rerender } = render(<StrictMode><PaperGithubDialog paper={paper} onSave={onSave} onClose={onClose} /></StrictMode>);
    await screen.findByText("Stars 已从 GitHub 刷新并保存。");
    expect(onSave).toHaveBeenCalledExactlyOnceWith(paper.githubUrl, 0);
    rerender(<StrictMode><PaperGithubDialog paper={paper} onSave={onSave} onClose={onClose} /></StrictMode>);
    expect(fetchGithubStars).toHaveBeenCalledTimes(1);
    unmount();
    render(<PaperGithubDialog paper={paper} onSave={onSave} onClose={onClose} />);
    await screen.findByText("Stars 已从 GitHub 刷新并保存。");
    expect(fetchGithubStars).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith(paper.githubUrl, 88);
  });

  it("ignores a response after closing and allows cancellation while refreshing", async () => {
    let resolve!: (stars: number) => void;
    vi.mocked(fetchGithubStars).mockReturnValue(new Promise(done => { resolve = done; }));
    const onSave = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(<PaperGithubDialog paper={paper} onSave={onSave} onClose={onClose} />);
    expect(screen.getByRole("spinbutton")).toHaveValue(42);
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    await act(async () => resolve(100));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps cached Stars editable after a failed request and does not overwrite storage", async () => {
    vi.mocked(fetchGithubStars).mockRejectedValue(new Error("GitHub 请求受限，已保留上次记录。"));
    const onSave = vi.fn();
    render(<PaperGithubDialog paper={paper} onSave={onSave} onClose={vi.fn()} />);
    await screen.findByText("GitHub 请求受限，已保留上次记录。");
    expect(screen.getByRole("spinbutton")).toHaveValue(42);
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("reports a persistence failure without presenting the refreshed count as saved", async () => {
    vi.mocked(fetchGithubStars).mockResolvedValue(100);
    const onSave = vi.fn().mockRejectedValue(new Error("conflict"));
    render(<PaperGithubDialog paper={paper} onSave={onSave} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("但保存失败"));
    expect(screen.getByRole("spinbutton")).toHaveValue(42);
    expect(screen.queryByText("Stars 已从 GitHub 刷新并保存。")).toBeNull();
  });
});
