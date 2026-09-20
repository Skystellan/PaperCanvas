import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PersistenceCoordinator, usePersistenceCoordinator } from "../persistence";
import type { MindMapRepository } from "./data/mindMapRepository";
import { PaperMindMap } from "./PaperMindMap";
import { renderMarkmap, type MindMapNode } from "./model/markmap";

vi.mock("./model/markmap", () => ({ renderMarkmap: vi.fn() }));
vi.mock("./MarkmapPreview", () => ({ default: ({ root }: { root: MindMapNode }) => <svg role="img" aria-label="Paper mind map diagram" data-source={root.content} /> }));
const original = "# Paper\n## Method";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function repositoryWith(source: string | null = original) {
  return {
    load: vi.fn().mockResolvedValue(source),
    save: vi.fn().mockResolvedValue(undefined),
  } satisfies MindMapRepository;
}

function NavigationHarness({ repository }: { repository: MindMapRepository }) {
  const [paperId, setPaperId] = useState("paper-1");
  const [navigationError, setNavigationError] = useState(false);
  const { flushPending } = usePersistenceCoordinator();
  return <>
    <button type="button" onClick={() => {
      void flushPending().then(() => setPaperId("paper-2"), () => setNavigationError(true));
    }}>Next paper</button>
    {navigationError && <p>Navigation paused until source is saved</p>}
    <PaperMindMap paperId={paperId} repository={repository} />
  </>;
}

function open(repository = repositoryWith()) {
  render(<PersistenceCoordinator><NavigationHarness repository={repository} /></PersistenceCoordinator>);
  return repository;
}

function sourceEditor() {
  const edit = screen.queryByRole("button", { name: "Edit source" });
  if (edit) fireEvent.click(edit);
  return screen.getByRole("textbox", { name: "Markdown source" });
}

beforeEach(() => {
  vi.mocked(renderMarkmap).mockReset().mockImplementation(async (text) => ({ content: text, children: [] }));
});

describe("PaperMindMap", () => {
  it("loads the paper's source and previews it offline with an expandable source editor", async () => {
    const source = "```markdown\n# Paper\n```";
    const repository = open(repositoryWith(source));
    expect(await screen.findByLabelText("Markdown source")).toHaveValue(source);
    const image = await screen.findByRole("img", { name: "Paper mind map diagram" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit source" }));
    expect(screen.getByRole("textbox", { name: "Markdown source" })).toHaveValue(source);
    expect(image).toHaveAttribute("data-source", source);
    expect(repository.load).toHaveBeenCalledWith("paper-1");
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("keeps the last valid diagram and the full failed source, which can still be saved", async () => {
    const repository = open();
    const image = await screen.findByRole("img");
    vi.mocked(renderMarkmap).mockRejectedValueOnce(new Error("Parse error on line 2: expected ]"));
    const source = "unsupported old diagram source";
    fireEvent.change(sourceEditor(), { target: { value: source } });
    fireEvent.click(screen.getByRole("button", { name: "Render preview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Parse error on line 2");
    expect(screen.getByRole("alert")).toHaveTextContent("The last valid diagram is still shown");
    expect(image).toHaveAttribute("data-source", original);
    expect(screen.getByLabelText("Markdown source")).toHaveValue(source);
    fireEvent.click(screen.getByRole("button", { name: "Save source" }));
    await waitFor(() => expect(repository.save).toHaveBeenCalledWith("paper-1", source));
    expect(await screen.findByText("Source saved locally")).toBeInTheDocument();
  });

  it("flushes edits made during an in-flight save before allowing navigation", async () => {
    const firstSave = deferred<void>();
    const latestSave = deferred<void>();
    const repository = repositoryWith();
    repository.save.mockReturnValueOnce(firstSave.promise).mockReturnValueOnce(latestSave.promise);
    repository.load.mockResolvedValueOnce(original).mockResolvedValueOnce("# Other paper");
    open(repository);
    await screen.findByRole("img");
    const editor = sourceEditor();
    fireEvent.change(editor, { target: { value: "# Paper\n## C" } });
    fireEvent.click(screen.getByRole("button", { name: "Save source" }));
    await waitFor(() => expect(repository.save).toHaveBeenCalledTimes(1));
    fireEvent.change(editor, { target: { value: "# Paper\n## D" } });
    fireEvent.click(screen.getByRole("button", { name: "Next paper" }));
    expect(repository.load).toHaveBeenCalledTimes(1);
    await act(async () => firstSave.resolve());
    await waitFor(() => expect(repository.save).toHaveBeenNthCalledWith(2, "paper-1", "# Paper\n## D"));
    expect(repository.load).toHaveBeenCalledTimes(1);
    await act(async () => latestSave.resolve());
    await waitFor(() => expect(screen.getByLabelText("Markdown source")).toHaveValue("# Other paper"));
    expect(repository.load).toHaveBeenLastCalledWith("paper-2");
    expect(repository.save).toHaveBeenCalledTimes(2);
  });

  it("saves unrendered drafts on navigation and retains failed writes for retry", async () => {
    const repository = open();
    await screen.findByRole("img");
    const editor = sourceEditor();
    repository.save.mockRejectedValueOnce(new Error("disk full"));
    fireEvent.change(editor, { target: { value: "unfinished source[" } });
    fireEvent.click(screen.getByRole("button", { name: "Next paper" }));
    expect(await screen.findByText("Navigation paused until source is saved")).toBeInTheDocument();
    expect(screen.getByLabelText("Markdown source")).toHaveValue("unfinished source[");
    expect(screen.getByRole("alert")).toHaveTextContent("Your edits are still here");
    expect(repository.load).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry saving" }));
    await waitFor(() => expect(repository.save).toHaveBeenCalledTimes(2));
    expect(repository.save).toHaveBeenLastCalledWith("paper-1", "unfinished source[");
    expect(await screen.findByText("Source saved locally")).toBeInTheDocument();
  });

  it("does not mark an edit back to the old value clean while an intermediate save is pending", async () => {
    const pending = deferred<void>();
    const repository = open();
    await screen.findByRole("img");
    repository.save.mockReturnValueOnce(pending.promise);
    fireEvent.change(sourceEditor(), { target: { value: "intermediate" } });
    fireEvent.click(screen.getByRole("button", { name: "Save source" }));
    await waitFor(() => expect(repository.save).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Markdown source"), { target: { value: original } });
    fireEvent.click(screen.getByRole("button", { name: "Next paper" }));
    expect(repository.load).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve());
    await waitFor(() => expect(repository.save).toHaveBeenNthCalledWith(2, "paper-1", original));
    await waitFor(() => expect(repository.load).toHaveBeenCalledWith("paper-2"));
  });

  it("ignores a stale preview that finishes after the source changed", async () => {
    open();
    const image = await screen.findByRole("img");
    const pending = deferred<MindMapNode>();
    vi.mocked(renderMarkmap).mockReturnValueOnce(pending.promise);
    fireEvent.change(sourceEditor(), { target: { value: "older render" } });
    fireEvent.click(screen.getByRole("button", { name: "Render preview" }));
    fireEvent.change(screen.getByLabelText("Markdown source"), { target: { value: "newer draft" } });
    await act(async () => pending.resolve({ content: "older render", children: [] }));
    expect(image).toHaveAttribute("data-source", original);
    expect(screen.getByLabelText("Markdown source")).toHaveValue("newer draft");
    fireEvent.click(screen.getByRole("button", { name: "Render preview" }));
    await waitFor(() => expect(image).toHaveAttribute("data-source", "newer draft"));
  });

  it("does not let a late load or preview from another paper leak into the active editor", async () => {
    const pendingLoad = deferred<string>();
    const repository = repositoryWith();
    repository.load.mockReturnValueOnce(pendingLoad.promise).mockResolvedValueOnce("# Current paper");
    open(repository);
    fireEvent.click(screen.getByRole("button", { name: "Next paper" }));
    await waitFor(() => expect(screen.getByLabelText("Markdown source")).toHaveValue("# Current paper"));
    await act(async () => pendingLoad.resolve(original));
    expect(screen.getByLabelText("Markdown source")).toHaveValue("# Current paper");
    expect(screen.getByRole("img")).toHaveAttribute("data-source", "# Current paper");
  });

  it("keeps storage failures separate from empty source and allows a load retry", async () => {
    const repository = repositoryWith(null);
    repository.load.mockRejectedValueOnce(new Error("database unavailable"));
    open(repository);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
    expect(await screen.findByLabelText("Markdown source")).toHaveValue("");
    expect(repository.save).not.toHaveBeenCalled();
  });
});
