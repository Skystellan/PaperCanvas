import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PdfSearch } from "./PdfSearch";
import { PdfOutline } from "./PdfOutline";
import { loadPdfOutline } from "./model/pdfOutline";
import type { PdfViewerRuntime } from "./pdfViewerRuntime";

const makeRuntime = (): PdfViewerRuntime => ({
  currentPage: 1, currentZoom: 1, pagesCount: 3,
  destroy: vi.fn(), setPage: vi.fn(), stepZoom: vi.fn(), zoomTo: vi.fn(),
  find: vi.fn(), closeFind: vi.fn(), getOutline: vi.fn().mockResolvedValue([]),
  goToDestination: vi.fn().mockResolvedValue(undefined),
});

beforeEach(() => localStorage.clear());

describe("PDF navigation", () => {
  it("opens on Cmd/Ctrl+F, searches, steps both ways and closes with Escape", async () => {
    const runtime = makeRuntime();
    render(<PdfSearch runtime={runtime} result={{ current: 1, total: 3, pending: false }} />);
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const input = screen.getByRole("searchbox");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "attention" } });
    expect(runtime.find).toHaveBeenLastCalledWith("attention");
    fireEvent.click(screen.getByRole("button", { name: "下一个匹配" }));
    expect(runtime.find).toHaveBeenLastCalledWith("attention", false, true);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(runtime.find).toHaveBeenLastCalledWith("attention", true, true);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(runtime.closeFind).toHaveBeenCalledOnce();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.getByRole("searchbox")).toHaveValue("attention");
  });

  it("does not intercept a note editor's shortcut and reports no matches", () => {
    render(<><textarea aria-label="Note" /><PdfSearch runtime={makeRuntime()} result={{ current: 0, total: 0, pending: false }} /></>);
    fireEvent.keyDown(screen.getByLabelText("Note"), { key: "f", metaKey: true });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "搜索 PDF" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
    expect(screen.getByRole("status")).toHaveTextContent("无匹配");
    expect(screen.getByRole("button", { name: "下一个匹配" })).toBeDisabled();
  });

  it("loads nested named destinations while preserving entries with broken targets", async () => {
    const pdf = {
      numPages: 4,
      getOutline: async () => [{ title: "Intro", dest: "intro", items: [{ title: "Method", dest: [2, { name: "Fit" }], items: [] }] }, { title: "Broken", dest: "missing", items: [] }],
      getDestination: vi.fn(async (name) => name === "intro" ? [{ num: 8, gen: 0 }, { name: "Fit" }] : null),
      getPageIndex: vi.fn().mockResolvedValue(0),
    } as unknown as PDFDocumentProxy;
    expect(await loadPdfOutline(pdf)).toEqual([
      { title: "Intro", depth: 0, pageNumber: 1, destination: "intro" },
      { title: "Method", depth: 1, pageNumber: 3, destination: [2, { name: "Fit" }] },
      { title: "Broken", depth: 0, pageNumber: null, destination: "missing" },
    ]);
  });

  it("shows outline on hover and navigates to its PDF destination", async () => {
    const runtime = makeRuntime();
    vi.mocked(runtime.getOutline).mockResolvedValue([{ title: "Method", depth: 0, pageNumber: 3, destination: "method" }]);
    render(<PdfOutline runtime={runtime} currentPage={3} filePath="papers/one.pdf" pageCount={3} />);
    await screen.findByRole("button", { name: "跳转：Method" });
    fireEvent.mouseEnter(screen.getByRole("navigation"));
    expect(screen.getByText("目录与书签")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "跳转：Method" }));
    expect(runtime.goToDestination).toHaveBeenCalledWith("method");
    expect(screen.getByRole("button", { name: "跳转：Method" })).toHaveAttribute("aria-current", "location");
  });

  it("falls back to pages and persists/removes bookmarks across reopen", async () => {
    const runtime = makeRuntime();
    const props = { runtime, currentPage: 2, filePath: "papers/one.pdf", pageCount: 3 };
    const view = render(<PdfOutline {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "固定 PDF 目录" }));
    await screen.findByText(/没有内置目录/);
    fireEvent.click(screen.getByRole("button", { name: "跳转：第 3 页" }));
    expect(runtime.setPage).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole("button", { name: "收藏本页" }));
    view.unmount();
    render(<PdfOutline {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "固定 PDF 目录" }));
    fireEvent.click(await screen.findByRole("button", { name: "★ 第 2 页" }));
    expect(runtime.setPage).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole("button", { name: "移除本页书签" }));
    expect(localStorage.getItem("paper-pdf-bookmarks:v1:papers/one.pdf")).toBe("[]");
  });

  it("ignores late outline loads after switching documents", async () => {
    const old = makeRuntime();
    let resolve!: (entries: Awaited<ReturnType<PdfViewerRuntime["getOutline"]>>) => void;
    vi.mocked(old.getOutline).mockReturnValue(new Promise((done) => { resolve = done; }));
    const view = render(<PdfOutline key="one" runtime={old} currentPage={1} filePath="one" pageCount={3} />);
    view.rerender(<PdfOutline key="two" runtime={makeRuntime()} currentPage={1} filePath="two" pageCount={1} />);
    await act(async () => resolve([{ title: "Old", depth: 0, pageNumber: 2, destination: "old" }]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "跳转：Old" })).not.toBeInTheDocument());
  });
});
