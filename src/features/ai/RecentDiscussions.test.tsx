import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AiRepository } from "./data/aiRepository";
import {
  DEFAULT_CODEX_MODEL,
  LOCAL_CODEX_PROVIDER,
  type ChatSession,
} from "./model/ai";
import { RecentDiscussions } from "./RecentDiscussions";

function session(index: number): ChatSession {
  return {
    id: `session-${index}`,
    title: `Discussion ${index}`,
    provider: LOCAL_CODEX_PROVIDER,
    model: DEFAULT_CODEX_MODEL,
    codexThreadId: null,
    contextRevision: 0,
    codexContextRevision: null,
    runtimeSyncState: "new",
    createdAt: index,
    updatedAt: index,
  };
}

describe("RecentDiscussions", () => {
  it("shows only recent saved discussions and has no chat composer", async () => {
    const repository = {
      listSessions: vi.fn(async () => Array.from({ length: 7 }, (_, index) => session(index))),
    } as unknown as AiRepository;

    render(<RecentDiscussions limit={5} repository={repository} />);

    expect(await screen.findByText("Discussion 0")).toBeVisible();
    expect(screen.getByText("Discussion 4")).toBeVisible();
    expect(screen.queryByText("Discussion 5")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("renders an empty state without creating a discussion", async () => {
    const repository = {
      listSessions: vi.fn(async () => []),
    } as unknown as AiRepository;

    render(<RecentDiscussions repository={repository} />);

    expect(await screen.findByText(/No discussions yet/i)).toBeVisible();
    expect(repository.listSessions).toHaveBeenCalledOnce();
  });

  it("keeps a local-storage failure recoverable", async () => {
    const repository = {
      listSessions: vi.fn(async () => {
        throw new Error("database busy");
      }),
    } as unknown as AiRepository;

    render(<RecentDiscussions repository={repository} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not be loaded/i,
    );
  });
});
