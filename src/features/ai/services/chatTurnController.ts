import type { Paper } from "../../library";
import type { AiRepository } from "../data/aiRepository";
import type {
  AIProvider,
  AiRuntimeSettings,
  ChatMessage,
  ChatSessionSnapshot,
} from "../model/ai";
import { measureContextBudget, type ContextBudget } from "../model/contextBudget";

export class ChatContextOverflowError extends Error {
  constructor(public readonly budget: ContextBudget) {
    super(
      `The complete selected context is approximately ${budget.estimatedTokens.toLocaleString()} tokens, above the ${budget.limit.toLocaleString()} token safety limit. No content was sent.`,
    );
    this.name = "ChatContextOverflowError";
  }
}

export class ChatPaperContextUnavailableError extends Error {
  constructor(public readonly paperTitle: string) {
    super(`The complete text for “${paperTitle}” is not ready.`);
    this.name = "ChatPaperContextUnavailableError";
  }
}

const PAPER_ASSISTANT_INSTRUCTIONS = `You are PaperCanvas, a careful research discussion assistant.
Use only the explicitly supplied paper context and the conversation when answering claims about papers.
Clearly distinguish what is stated in a paper from your own analysis. Do not invoke tools, edit files, or run commands.`;
const STREAM_CHECKPOINT_INTERVAL_MS = 750;

export function buildCodexPrompt({
  messages,
  paperTexts,
  userPrompt,
}: {
  messages: readonly Pick<ChatMessage, "content" | "role">[];
  paperTexts: ReadonlyArray<{ paper: Paper; content: string }>;
  userPrompt: string;
}): string {
  const sections = [PAPER_ASSISTANT_INSTRUCTIONS];
  if (paperTexts.length > 0) {
    sections.push(
      paperTexts
        .map(
          ({ content, paper }) =>
            `BEGIN EXPLICIT PAPER CONTEXT: ${paper.title} [${paper.id}]\n${content}\nEND EXPLICIT PAPER CONTEXT: ${paper.title}`,
        )
        .join("\n\n"),
    );
  }
  if (messages.length > 0) {
    sections.push(
      `LOCAL CONVERSATION HISTORY\n${messages
        .filter((message) => message.content.trim())
        .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
        .join("\n\n")}`,
    );
  }
  sections.push(`CURRENT USER REQUEST\n${userPrompt.trim()}`);
  return sections.join("\n\n");
}

export interface ChatTurnResult {
  assistantMessage: ChatMessage;
  requestId: string;
  userMessage: ChatMessage;
}

type IdFactory = () => string;

export class ChatTurnController {
  constructor(
    private readonly repository: Pick<
      AiRepository,
      | "beginTurn"
      | "getPaperText"
      | "updateMessage"
      | "updateRuntimeSync"
    >,
    private readonly provider: AIProvider,
    private readonly now: () => number = Date.now,
    private readonly createId: IdFactory = () => crypto.randomUUID(),
  ) {}

  cancel(requestId: string): Promise<void> {
    return this.provider.cancel(requestId);
  }

  async send({
    onRequestStarted,
    onSnapshot,
    settings,
    snapshot,
    userPrompt,
  }: {
    onRequestStarted?: (requestId: string) => void;
    onSnapshot?: (text: string) => void;
    settings: AiRuntimeSettings;
    snapshot: ChatSessionSnapshot;
    userPrompt: string;
  }): Promise<ChatTurnResult> {
    const promptText = userPrompt.trim();
    if (!promptText) throw new Error("Write a question before sending.");

    const storedPaperTexts = await Promise.all(
      snapshot.contexts.map(async ({ paper }) => {
        const stored = await this.repository.getPaperText(paper.id);
        if (!stored || stored.status !== "ready" || stored.content === null) {
          throw new ChatPaperContextUnavailableError(paper.title);
        }
        return { paper, stored };
      }),
    );
    const prompt = buildCodexPrompt({
      messages: snapshot.messages.filter((message) => message.status !== "streaming"),
      paperTexts: storedPaperTexts.map(({ paper, stored }) => ({
        paper,
        content: stored.content as string,
      })),
      userPrompt: promptText,
    });
    const budget = measureContextBudget({ messages: [], paperTexts: [], prompt });
    if (!budget.fits) throw new ChatContextOverflowError(budget);

    const timestamp = this.now();
    const nextPosition = snapshot.messages.reduce(
      (next, message) => Math.max(next, message.position + 1),
      0,
    );
    const userMessageId = this.createId();
    const assistantMessageId = this.createId();
    const { assistantMessage: initialAssistantMessage, userMessage } =
      await this.repository.beginTurn({
        assistantMessageId,
        nextPosition,
        sessionId: snapshot.session.id,
        timestamp,
        userContent: promptText,
        userMessageId,
      });
    let assistantMessage = initialAssistantMessage;
    const requestId = this.createId();
    onRequestStarted?.(requestId);
    let assistantSnapshot = "";
    let completed = false;
    let interrupted = false;
    let streamError: Error | null = null;
    let persistenceQueue = Promise.resolve();
    let lastCheckpointAt = Number.NEGATIVE_INFINITY;

    try {
      await this.provider.streamTurn(
        {
          requestId,
          prompt,
          model: settings.model,
          reasoningEffort: settings.reasoningEffort,
        },
        (event) => {
          if (event.type === "message") {
            assistantSnapshot = event.text;
            onSnapshot?.(assistantSnapshot);
            const checkpointAt = this.now();
            if (
              checkpointAt - lastCheckpointAt >=
              STREAM_CHECKPOINT_INTERVAL_MS
            ) {
              lastCheckpointAt = checkpointAt;
              const checkpointSnapshot = assistantSnapshot;
              persistenceQueue = persistenceQueue.then(() =>
                this.repository.updateMessage({
                  id: assistantMessage.id,
                  content: checkpointSnapshot,
                  status: "streaming",
                  timestamp: checkpointAt,
                }),
              );
            }
          } else if (event.type === "completed") {
            completed = true;
          } else if (event.type === "interrupted") {
            interrupted = true;
          } else if (event.type === "error") {
            streamError = new Error(event.message);
          }
        },
      );
      await persistenceQueue;
      if (streamError) throw streamError;
      if (!completed && !interrupted) {
        throw new Error("Codex ended without a completion event.");
      }

      const finalStatus = interrupted ? "interrupted" : "complete";
      await this.repository.updateMessage({
        id: assistantMessage.id,
        content: assistantSnapshot,
        status: finalStatus,
        timestamp: this.now(),
      });
      assistantMessage = {
        ...assistantMessage,
        content: assistantSnapshot,
        status: finalStatus,
        updatedAt: this.now(),
      };

      if (!interrupted) {
        await this.repository.updateRuntimeSync({
          sessionId: snapshot.session.id,
          codexThreadId: null,
          codexContextRevision: null,
          state: "new",
          timestamp: this.now(),
        });
      } else {
        await this.repository.updateRuntimeSync({
          sessionId: snapshot.session.id,
          codexThreadId: null,
          codexContextRevision: null,
          state: "desynced",
          timestamp: this.now(),
        });
      }
      return { assistantMessage, requestId, userMessage };
    } catch (error) {
      await persistenceQueue.catch(() => undefined);
      await this.repository
        .updateMessage({
          id: assistantMessage.id,
          content: assistantSnapshot,
          status: "error",
          timestamp: this.now(),
        })
        .catch(() => undefined);
      await this.repository
        .updateRuntimeSync({
          sessionId: snapshot.session.id,
          codexThreadId: null,
          codexContextRevision: null,
          state: "desynced",
          timestamp: this.now(),
        })
        .catch(() => undefined);
      throw error;
    }
  }
}
