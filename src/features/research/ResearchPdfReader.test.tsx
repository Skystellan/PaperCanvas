import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResearchPdfReader } from "./ResearchPdfReader";
import { invoke } from "../../platform/core";
import { usePersistenceCoordinator, usePersistenceWriter } from "../persistence";
import type { Paper } from "../library/model/paper";
import { saveReaderState } from "../reader/model/readerState";

const harness = vi.hoisted(() => ({
  flush: vi.fn(async () => {}),
  viewer: vi.fn(),
}));
vi.mock("../../platform/core", () => ({ invoke: vi.fn() }));
vi.mock("../persistence", () => ({ usePersistenceCoordinator: vi.fn(), usePersistenceWriter: vi.fn() }));
vi.mock("../reader/PdfViewer", () => ({ PdfViewer: (props: unknown) => { harness.viewer(props); return <div>Rendered PDF</div>; } }));

const paper: Paper = { id: "online", title: "Research candidate", filePath: null, authors: null, year: 2025, domainId: null, createdAt: 1,
  research: { url: "https://arxiv.org/abs/2501.12345v2", arxivId: "2501.12345", doi: null, abstract: "Source abstract", reason: "Candidate", group: "Methods", batchId: "batch" } };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  harness.flush.mockResolvedValue(undefined);
  window.paperCanvas = { invoke: vi.fn(), on: vi.fn(), getPathForFile: vi.fn() };
  vi.mocked(usePersistenceCoordinator).mockReturnValue({ flushPending: harness.flush, trackOperation: operation => operation, registerWriter: vi.fn() });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "open_online_pdf") return { requestId: args!.requestId, bytes: new Uint8Array([37, 80, 68, 70]), sourceUrl: paper.research!.url, documentKey: "hash" };
    if (command === "save_online_pdf") return { ...paper, filePath: "papers/online.pdf" };
  });
});
afterEach(() => { delete window.paperCanvas; });

it("loads only on reader mount, never saves implicitly, and releases the request on close", async () => {
  const view = render(<ResearchPdfReader paper={paper} viewerProps={{}} />);
  expect(await screen.findByText("Rendered PDF")).toBeVisible();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("open_online_pdf", { paperId: "online", requestId: expect.any(String) });
  const id = vi.mocked(invoke).mock.calls[0][1]!.requestId;
  view.unmount();
  expect(invoke).toHaveBeenLastCalledWith("release_online_pdf", { requestId: id });
});

it("leaves non-arXiv metadata and already local papers free of network requests", () => {
  const view = render(<ResearchPdfReader paper={{ ...paper, research: { ...paper.research!, arxivId: null } }} viewerProps={{}} />);
  expect(screen.getByLabelText("论文初筛信息")).toBeVisible();
  expect(invoke).not.toHaveBeenCalled();
  view.unmount();
  render(<ResearchPdfReader paper={{ ...paper, filePath: "papers/online.pdf" }} viewerProps={{}} />);
  expect(screen.getByText("Rendered PDF")).toBeVisible();
  expect(invoke).not.toHaveBeenCalled();
});

it("saves the same paper only after flushing drafts and keeps the active PDF stable", async () => {
  const onPaperUpdated = vi.fn();
  render(<ResearchPdfReader paper={paper} viewerProps={{}} onPaperUpdated={onPaperUpdated} />);
  await screen.findByText("Rendered PDF");
  const before = harness.viewer.mock.lastCall![0];
  fireEvent.click(screen.getByRole("button", { name: "保存离线" }));
  await screen.findByText("已保存离线");
  const calls = vi.mocked(invoke).mock.calls;
  expect(calls.map(([command]) => command)).toEqual(["open_online_pdf", "save_online_pdf"]);
  expect(harness.flush.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(invoke).mock.invocationCallOrder[1]);
  expect(onPaperUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: paper.id, filePath: "papers/online.pdf" }));
  expect(harness.viewer.mock.lastCall![0].memoryDocument).toBe(before.memoryDocument);
});

it("keeps preview available on save failure and includes active writes in the save barrier", async () => {
  let rejectSave!: (error: Error) => void;
  render(<ResearchPdfReader paper={paper} viewerProps={{}} />);
  await screen.findByText("Rendered PDF");
  vi.mocked(invoke).mockImplementation(command => command === "save_online_pdf" ? new Promise((_, reject) => { rejectSave = reject; }) : Promise.resolve(undefined));
  fireEvent.click(screen.getByRole("button", { name: "保存离线" }));
  await waitFor(() => expect(rejectSave).toBeTypeOf("function"));
  const writer = vi.mocked(usePersistenceWriter).mock.calls[0][1];
  expect(writer.isDirty()).toBe(true);
  await act(async () => rejectSave(new Error("Disk unavailable")));
  expect(await screen.findByRole("alert")).toHaveTextContent("Disk unavailable");
  expect(screen.getByText("Rendered PDF")).toBeVisible();
  expect(writer.isDirty()).toBe(false);
});

it("does not save if drafts cannot be flushed and allows an explicit preview retry", async () => {
  vi.mocked(invoke).mockRejectedValueOnce("ONLINE_PDF_CHANGED: the source changed");
  render(<ResearchPdfReader paper={paper} viewerProps={{}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("ONLINE_PDF_CHANGED");
  fireEvent.click(screen.getByRole("button", { name: "重试在线阅读" }));
  await screen.findByText("Rendered PDF");
  harness.flush.mockRejectedValue(new Error("Draft could not be saved"));
  fireEvent.click(screen.getByRole("button", { name: "保存离线" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Draft could not be saved");
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "save_online_pdf")).toBe(false);
});

it("restores the latest reading position when returning from metadata without fetching again", async () => {
  render(<ResearchPdfReader paper={paper} viewerProps={{}} />);
  await screen.findByText("Rendered PDF");
  const location = { pageNumber: 3, offset: .4, zoom: 1.25 };
  saveReaderState(paper.id, { location });
  fireEvent.click(screen.getByRole("button", { name: "初筛信息" }));
  expect(screen.getByLabelText("论文初筛信息")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "PDF" }));
  expect(harness.viewer.mock.lastCall![0].initialLocation).toEqual(location);
  expect(invoke).toHaveBeenCalledOnce();
});
