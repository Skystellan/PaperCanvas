import type { Paper } from "../../library";
import {
  MIND_MAP_LIMITS,
  MIND_MAP_SCHEMA_VERSION,
  validateMindMapTree,
  type MindMapTree,
} from "../../mindmap";
import type { PdfTextSelection } from "../../reader";
import type { AiRepository } from "../data/aiRepository";
import type { AIProvider, AiTurnRequest } from "../model/ai";
import { measureContextBudget } from "../model/contextBudget";
import { ChatContextOverflowError } from "./chatTurnController";
import type { PaperTextService } from "./paperTextService";

const MIND_MAP_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    nodes: {
      type: "array",
      minItems: 1,
      maxItems: MIND_MAP_LIMITS.maxNodes,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: MIND_MAP_LIMITS.maxIdLength },
          title: { type: "string", minLength: 1, maxLength: MIND_MAP_LIMITS.maxTitleLength },
          details: { type: "string", maxLength: MIND_MAP_LIMITS.maxDetailsLength },
          parentId: {
            anyOf: [
              { type: "string", minLength: 1, maxLength: MIND_MAP_LIMITS.maxIdLength },
              { type: "null" },
            ],
          },
        },
        required: ["id", "title", "details", "parentId"],
      },
    },
  },
  required: ["nodes"],
} as const;

class CodexTurnStoppedError extends Error {
  constructor() {
    super("Codex generation was stopped.");
    this.name = "CodexTurnStoppedError";
  }
}

function runtimeUnavailableMessage(
  status: Awaited<ReturnType<AIProvider["getStatus"]>>,
): string {
  if (status.message?.trim()) return status.message;
  if (!status.available) return "The local Codex runtime is unavailable.";
  if (!status.compatible) return "The local Codex runtime is incompatible.";
  if (!status.authenticated || status.loginMethod === "none") {
    return "Sign in to the local Codex runtime with ChatGPT first.";
  }
  if (status.loginMethod !== "chatgpt") {
    return "Sign in to the local Codex runtime with ChatGPT; API-key login is disabled here.";
  }
  return "The local Codex runtime is unavailable.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMindMapResponse(
  response: string,
  prompt: string,
  timestamp: number,
): MindMapTree {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    throw new Error("Codex returned invalid mind-map JSON.");
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.nodes)) {
    throw new Error("Codex returned an invalid mind-map shape.");
  }
  const nodes = parsed.nodes.map((node) => {
    if (!isRecord(node)) throw new Error("Codex returned an invalid mind-map node.");
    const allowed = ["details", "id", "parentId", "title"];
    if (
      Object.keys(node).length !== allowed.length ||
      Object.keys(node).some((key) => !allowed.includes(key))
    ) {
      throw new Error("Codex returned an invalid mind-map node.");
    }
    return { ...node, x: 0, y: 0 };
  });
  return validateMindMapTree({
    schemaVersion: MIND_MAP_SCHEMA_VERSION,
    revision: 1,
    sourcePrompt: prompt,
    nodes,
    updatedAt: timestamp,
  });
}

export class CodexResearchService {
  constructor(
    private readonly repository: Pick<AiRepository, "getSettings">,
    private readonly provider: AIProvider,
    private readonly paperTextService: PaperTextService,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  async translateSelection(
    selection: PdfTextSelection,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.runTurn({
      prompt: `Translate the following PDF passage into clear Simplified Chinese. Preserve technical terminology and equations. Return only the translation.\n\nPDF page ${selection.pageNumber}:\n${selection.text}`,
      signal,
    });
  }

  async askSelection(
    selection: PdfTextSelection,
    question = "Explain this passage and why it matters.",
    signal?: AbortSignal,
  ): Promise<string> {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || trimmedQuestion.length > 8_000) {
      throw new Error("The selection question is empty or too long.");
    }
    return this.runTurn({
      prompt: `Answer the user's question about this selected PDF passage. Do not use tools or claim access to the rest of the paper.\n\nQuestion:\n${trimmedQuestion}\n\nSelected passage from page ${selection.pageNumber}:\n${selection.text}`,
      signal,
    });
  }

  async generateMindMap({
    paper,
    prompt,
    signal,
  }: {
    paper: Paper;
    prompt: string;
    signal: AbortSignal;
  }): Promise<MindMapTree> {
    const stored = await this.paperTextService.ensureReady(paper, signal);
    if (!stored.content) throw new Error("The complete paper text is unavailable.");
    const completePrompt = `Create a faithful analysis tree for the explicitly supplied paper. Use stable short IDs, exactly one root, and parentId links that form one connected acyclic tree. Do not invoke tools.\n\nUSER ANALYSIS PROMPT\n${prompt}\n\nBEGIN COMPLETE PAPER: ${paper.title}\n${stored.content}\nEND COMPLETE PAPER: ${paper.title}`;
    const budget = measureContextBudget({ messages: [], paperTexts: [], prompt: completePrompt });
    if (!budget.fits) throw new ChatContextOverflowError(budget);
    const response = await this.runTurn({
      prompt: completePrompt,
      outputSchema: MIND_MAP_OUTPUT_SCHEMA,
      signal,
    });
    return parseMindMapResponse(response, prompt, this.now());
  }

  private async runTurn({
    outputSchema,
    prompt,
    signal,
  }: {
    outputSchema?: Record<string, unknown>;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const budget = measureContextBudget({
      messages: [],
      paperTexts: [],
      prompt: outputSchema
        ? `${prompt}\n\nOUTPUT SCHEMA\n${JSON.stringify(outputSchema)}`
        : prompt,
    });
    if (!budget.fits) throw new ChatContextOverflowError(budget);

    const [settings, status] = await Promise.all([
      this.repository.getSettings(),
      this.provider.getStatus(),
    ]);
    if (
      !status.available ||
      !status.compatible ||
      !status.authenticated ||
      status.loginMethod !== "chatgpt"
    ) {
      throw new Error(runtimeUnavailableMessage(status));
    }
    if (signal?.aborted) throw new CodexTurnStoppedError();

    const requestId = this.createId();
    const request: AiTurnRequest = {
      requestId,
      prompt,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      outputSchema,
    };
    let response = "";
    let completed = false;
    let interrupted = false;
    let turnError: Error | null = null;
    const stop = () => {
      interrupted = true;
      void this.provider.cancel(requestId).catch(() => undefined);
    };
    signal?.addEventListener("abort", stop, { once: true });
    try {
      await this.provider.streamTurn(request, (event) => {
        if (event.type === "message") response = event.text;
        else if (event.type === "completed") completed = true;
        else if (event.type === "interrupted") interrupted = true;
        else if (event.type === "error") turnError = new Error(event.message);
      });
    } finally {
      signal?.removeEventListener("abort", stop);
    }
    if (signal?.aborted || interrupted) throw new CodexTurnStoppedError();
    if (turnError) throw turnError;
    if (!completed || !response.trim()) {
      throw new Error("Codex returned no completed answer.");
    }
    return response.trim();
  }
}
