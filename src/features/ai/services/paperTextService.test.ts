import { describe, expect, it, vi } from "vitest";
import type { Paper } from "../../library";
import type { AiRepository } from "../data/aiRepository";
import type { StoredPaperText } from "../model/ai";
import {
  PaperTextExtractionCancelledError,
  PaperTextExtractionError,
} from "./paperTextExtractor";
import { PaperTextService } from "./paperTextService";

const paper: Paper = {
  id: "paper-1",
  title: "Paper",
  authors: null,
  year: null,
  filePath: "papers/paper-1.pdf",
  domainId: null,
  createdAt: 1,
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function repositoryWith(
  existing: StoredPaperText | null,
): Pick<AiRepository, "getPaperText" | "savePaperText"> {
  return {
    getPaperText: vi.fn().mockResolvedValue(existing),
    savePaperText: vi.fn().mockResolvedValue(undefined),
  };
}

describe("PaperTextService", () => {
  it("reuses a complete local extraction", async () => {
    const cached: StoredPaperText = {
      paperId: paper.id,
      status: "ready",
      content: "full text",
      pageCount: 1,
      charCount: 9,
      errorCode: null,
      updatedAt: 1,
    };
    const repository = repositoryWith(cached);
    const extract = vi.fn();
    const service = new PaperTextService(repository, extract, () => 10);

    await expect(service.ensureReady(paper)).resolves.toEqual(cached);
    expect(extract).not.toHaveBeenCalled();
  });

  it("extracts every page, caches it, and returns a ready context", async () => {
    const repository = repositoryWith(null);
    const service = new PaperTextService(
      repository,
      vi.fn().mockResolvedValue({ content: "all pages", pageCount: 3 }),
      () => 20,
    );

    const result = await service.ensureReady(paper);

    expect(result).toMatchObject({
      status: "ready",
      content: "all pages",
      pageCount: 3,
      charCount: 9,
    });
    expect(repository.savePaperText).toHaveBeenCalledWith(result);
  });

  it("retries a prior transient extraction failure after the adapter is fixed", async () => {
    const repository = repositoryWith({
      paperId: paper.id,
      status: "failed",
      content: null,
      pageCount: 0,
      charCount: 0,
      errorCode: "open_failed",
      updatedAt: 1,
    });
    const extract = vi.fn().mockResolvedValue({ content: "recovered text", pageCount: 2 });
    const service = new PaperTextService(repository, extract, () => 25);

    await expect(service.ensureReady(paper)).resolves.toMatchObject({
      status: "ready",
      content: "recovered text",
    });
    expect(extract).toHaveBeenCalledOnce();
    expect(repository.savePaperText).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ready", content: "recovered text" }),
    );
  });

  it("records an explicit too-large state without saving partial content", async () => {
    const repository = repositoryWith(null);
    const service = new PaperTextService(
      repository,
      vi.fn().mockRejectedValue(
        new PaperTextExtractionError("too_large", "too large", 8, 500_000),
      ),
      () => 30,
    );

    await expect(service.ensureReady(paper)).rejects.toMatchObject({ code: "too_large" });
    expect(repository.savePaperText).toHaveBeenCalledWith({
      paperId: paper.id,
      status: "too_large",
      content: null,
      pageCount: 8,
      charCount: 500_000,
      errorCode: "too_large",
      updatedAt: 30,
    });
  });

  it("does not cache cancellation as a permanent extraction failure", async () => {
    const repository = repositoryWith(null);
    const abort = new AbortController();
    const cancelled = new PaperTextExtractionCancelledError();
    const extract = vi.fn().mockImplementation(async () => {
      abort.abort();
      throw cancelled;
    });
    const service = new PaperTextService(repository, extract, () => 40);

    await expect(service.ensureReady(paper, abort.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(extract).toHaveBeenCalledWith(
      paper,
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(repository.savePaperText).not.toHaveBeenCalled();
  });

  it("shares one extraction across service instances for the same paper store", async () => {
    const repository = repositoryWith(null);
    const extraction = createDeferred<{ content: string; pageCount: number }>();
    const extract = vi.fn(() => extraction.promise);
    const firstService = new PaperTextService(repository, extract, () => 50);
    const secondService = new PaperTextService(repository, extract, () => 50);

    const first = firstService.ensureReady(paper);
    const second = secondService.ensureReady(paper);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce());
    extraction.resolve({ content: "shared full text", pageCount: 4 });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ content: "shared full text", status: "ready" }),
      expect.objectContaining({ content: "shared full text", status: "ready" }),
    ]);
    expect(repository.savePaperText).toHaveBeenCalledOnce();
  });

  it("lets one shared waiter cancel without aborting another reader", async () => {
    const repository = repositoryWith(null);
    const extraction = createDeferred<{ content: string; pageCount: number }>();
    let extractionSignal: AbortSignal | undefined;
    const extract = vi.fn(
      (_paper: Paper, dependencies?: { signal?: AbortSignal }) => {
        extractionSignal = dependencies?.signal;
        return extraction.promise;
      },
    );
    const firstService = new PaperTextService(repository, extract, () => 60);
    const secondService = new PaperTextService(repository, extract, () => 60);
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();

    const first = firstService.ensureReady(paper, firstAbort.signal);
    const second = secondService.ensureReady(paper, secondAbort.signal);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce());
    firstAbort.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(extractionSignal?.aborted).toBe(false);
    extraction.resolve({ content: "still shared", pageCount: 2 });
    await expect(second).resolves.toMatchObject({ content: "still shared" });
    expect(repository.savePaperText).toHaveBeenCalledOnce();
  });

  it("starts a fresh flight while an all-cancelled extraction is still cleaning up", async () => {
    const repository = repositoryWith(null);
    const cleanup = createDeferred<void>();
    let firstExtractionSignal: AbortSignal | undefined;
    const extract = vi
      .fn()
      .mockImplementationOnce(
        (_paper: Paper, dependencies?: { signal?: AbortSignal }) =>
          new Promise<{ content: string; pageCount: number }>((_resolve, reject) => {
            firstExtractionSignal = dependencies?.signal;
            dependencies?.signal?.addEventListener(
              "abort",
              () => {
                void cleanup.promise.then(() =>
                  reject(new PaperTextExtractionCancelledError()),
                );
              },
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce({ content: "fresh extraction", pageCount: 3 });
    const service = new PaperTextService(repository, extract, () => 70);
    const firstAbort = new AbortController();

    const first = service.ensureReady(paper, firstAbort.signal);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce());
    firstAbort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(firstExtractionSignal?.aborted).toBe(true);

    const fresh = service.ensureReady(paper);
    await expect(fresh).resolves.toMatchObject({ content: "fresh extraction" });
    expect(extract).toHaveBeenCalledTimes(2);
    cleanup.resolve(undefined);
  });
});
