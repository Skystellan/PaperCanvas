import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

describe("GitHub link editor", () => {
  it("only edits the link, without exposing review logs or manual Stars input", () => {
    render(<PaperGithubDialog paper={{ ...paper,
      codeReview: { status: "official", evidenceUrl: "https://example.org/paper", evidence: "Long investigation log", checkedAt: 1 } }}
      onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: "仓库链接" })).toHaveValue(paper.githubUrl);
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByText("Long investigation log")).toBeNull();
    expect(fetchGithubStars).not.toHaveBeenCalled();
  });

  it("preserves a changed link and keeps the editor open if saving fails", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("conflict"));
    const onClose = vi.fn();
    render(<PaperGithubDialog paper={paper} onSave={onSave} onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://github.com/example/new" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败，输入已保留");
    expect(onSave).toHaveBeenCalledExactlyOnceWith("https://github.com/example/new");
    expect(screen.getByRole("textbox")).toHaveValue("https://github.com/example/new");
    expect(onClose).not.toHaveBeenCalled();
  });
});
