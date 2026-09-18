import { describe, expect, it, vi } from "vitest";
import type { Paper } from "../../library";
import type { MindMapTree } from "../../mindmap";
import type { PdfTextSelection } from "../../reader";
import type { AiRepository } from "../data/aiRepository";
import {
  DEFAULT_CODEX_MODEL,
  LOCAL_CODEX_PROVIDER,
  type AIProvider,
} from "../model/ai";
import { MAX_ESTIMATED_INPUT_TOKENS } from "../model/contextBudget";
import type { PaperTextService } from "./paperTextService";
import { CodexResearchService } from "./codexResearchService";

const selection: PdfTextSelection = {
  anchor: { x: 1, y: 2 },
  pageNumber: 4,
  rects: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.04 }],
  text: "Attention is all you need.",
};

const paper: Paper = {
  id: "paper-1",
  title: "Attention Is All You Need",
  authors: "Vaswani et al.",
  year: 2017,
  filePath: "papers/attention.pdf",
  domainId: null,
  createdAt: 1,
};

function dependencies(response: string) {
  const provider: AIProvider = {
    cancel: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({
      available: true,
      authenticated: true,
      compatible: true,
      loginMethod: "chatgpt" as const,
      nodeVersion: "22",
      runtimeVersion: "0.149.0-alpha.4.1",
      message: null,
    })),
    streamTurn: vi.fn(async (_request, onEvent) => {
      onEvent({ type: "thread", threadId: "thread-1" });
      onEvent({ type: "message", itemId: "answer", text: response });
      onEvent({ type: "completed", usage: null });
    }),
  };
  const repository = {
    getSettings: vi.fn(async () => ({
      provider: LOCAL_CODEX_PROVIDER,
      model: DEFAULT_CODEX_MODEL,
      reasoningEffort: "low" as const,
      updatedAt: 1,
    })),
  } as unknown as AiRepository;
  const paperTextService = {
    ensureReady: vi.fn(async () => ({
      paperId: paper.id,
      status: "ready" as const,
      content: "COMPLETE PAPER TEXT",
      pageCount: 15,
      charCount: 19,
      errorCode: null,
      updatedAt: 1,
    })),
  } as unknown as PaperTextService;
  return { paperTextService, provider, repository };
}

describe("CodexResearchService", () => {
  it("translates only the selected passage with Luna through ChatGPT auth", async () => {
    const deps = dependencies("注意力就是你所需要的一切。");
    const service = new CodexResearchService(deps.repository, deps.provider, deps.paperTextService);

    await expect(service.translateSelection(selection)).resolves.toBe(
      "注意力就是你所需要的一切。",
    );
    expect(deps.provider.streamTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: DEFAULT_CODEX_MODEL,
        prompt: expect.stringContaining(selection.text),
      }),
      expect.any(Function),
    );
  });

  it("asks a custom question while preserving the selected quote", async () => {
    const deps = dependencies("It contrasts recurrence with global token interactions.");
    const service = new CodexResearchService(deps.repository, deps.provider, deps.paperTextService);

    await expect(
      service.askSelection(selection, "What is the contrast here?"),
    ).resolves.toContain("global token");
    const request = vi.mocked(deps.provider.streamTurn).mock.calls[0][0];
    expect(request.prompt).toContain("What is the contrast here?");
    expect(request.prompt).toContain(selection.text);
  });

  it("blocks an oversized multibyte selection before contacting Codex", async () => {
    const deps = dependencies("unused");
    const service = new CodexResearchService(
      deps.repository,
      deps.provider,
      deps.paperTextService,
    );

    await expect(
      service.translateSelection({
        ...selection,
        text: "论".repeat(Math.floor(MAX_ESTIMATED_INPUT_TOKENS / 3) + 1),
      }),
    ).rejects.toThrow(/safety limit/i);
    expect(deps.provider.streamTurn).not.toHaveBeenCalled();
  });

  it("reports a Codex version mismatch instead of telling an authenticated user to sign in", async () => {
    const deps = dependencies("unused");
    deps.provider.getStatus = vi.fn(async () => ({
      available: true,
      authenticated: true,
      compatible: false,
      loginMethod: "chatgpt" as const,
      message: "PaperCanvas requires Codex runtime 0.149.0-alpha.4.1.",
      nodeVersion: "22",
      runtimeVersion: "0.150.0-alpha.1",
    }));
    const service = new CodexResearchService(
      deps.repository,
      deps.provider,
      deps.paperTextService,
    );

    await expect(service.translateSelection(selection)).rejects.toThrow(
      "PaperCanvas requires Codex runtime 0.149.0-alpha.4.1.",
    );
    expect(deps.provider.streamTurn).not.toHaveBeenCalled();
  });

  it("sends the complete explicit paper and validates structured mind-map JSON", async () => {
    const response = JSON.stringify({
      nodes: [
        { id: "root", title: "Transformer", details: "Core argument", parentId: null },
        { id: "method", title: "Method", details: "Self-attention", parentId: "root" },
      ],
    });
    const deps = dependencies(response);
    const service = new CodexResearchService(deps.repository, deps.provider, deps.paperTextService, () => 50);

    const abort = new AbortController();
    const tree: MindMapTree = await service.generateMindMap({
      paper,
      prompt: "Map the argument",
      signal: abort.signal,
    });

    expect(deps.paperTextService.ensureReady).toHaveBeenCalledWith(
      paper,
      abort.signal,
    );
    const request = vi.mocked(deps.provider.streamTurn).mock.calls[0][0];
    expect(request.prompt).toContain("COMPLETE PAPER TEXT");
    expect(request.outputSchema).toMatchObject({ type: "object" });
    expect(tree).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      sourcePrompt: "Map the argument",
      updatedAt: 50,
    });
    expect(tree.nodes[1]).toMatchObject({ parentId: "root", x: 0, y: 0 });
  });

  it("cancels the exact Codex request when mind-map generation is stopped", async () => {
    const deps = dependencies("unused");
    let resolveTurn: (() => void) | undefined;
    vi.mocked(deps.provider.streamTurn).mockImplementation(
      () => new Promise<void>((resolve) => { resolveTurn = resolve; }),
    );
    const service = new CodexResearchService(deps.repository, deps.provider, deps.paperTextService);
    const abort = new AbortController();
    const operation = service.generateMindMap({
      paper,
      prompt: "Map it",
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(deps.provider.streamTurn).toHaveBeenCalled());
    abort.abort();
    await vi.waitFor(() => expect(deps.provider.cancel).toHaveBeenCalledOnce());
    resolveTurn?.();
    await expect(operation).rejects.toThrow(/stopped/i);
  });
});
