import type { Paper } from "../../library";

export const LOCAL_CODEX_PROVIDER = "codex-local" as const;
export const DEFAULT_CODEX_MODEL = "gpt-5.6-luna";
export const SUPPORTED_CODEX_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

export type CodexModel = (typeof SUPPORTED_CODEX_MODELS)[number];
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export function isCodexModel(value: string): value is CodexModel {
  return (SUPPORTED_CODEX_MODELS as readonly string[]).includes(value);
}

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return ["low", "medium", "high", "xhigh", "max"].includes(value);
}

export interface AiRuntimeSettings {
  provider: typeof LOCAL_CODEX_PROVIDER;
  model: CodexModel;
  reasoningEffort: ReasoningEffort;
  updatedAt: number;
}

export interface CodexRuntimeStatus {
  available: boolean;
  authenticated: boolean;
  compatible: boolean;
  loginMethod: "chatgpt" | "api" | "none" | "unknown";
  nodeVersion: string | null;
  runtimeVersion: string | null;
  message: string | null;
}

export type ChatMessageRole = "assistant" | "user";
export type ChatMessageStatus =
  | "complete"
  | "error"
  | "interrupted"
  | "streaming";
export type ChatRuntimeSyncState = "desynced" | "new" | "synced";

export interface ChatSession {
  id: string;
  title: string;
  provider: typeof LOCAL_CODEX_PROVIDER;
  model: CodexModel;
  codexThreadId: string | null;
  contextRevision: number;
  codexContextRevision: number | null;
  runtimeSyncState: ChatRuntimeSyncState;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  status: ChatMessageStatus;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChatContext {
  sessionId: string;
  paperId: string;
  position: number;
  createdAt: number;
}

export type PaperTextStatus = "failed" | "ready" | "too_large";

export interface StoredPaperText {
  paperId: string;
  status: PaperTextStatus;
  content: string | null;
  pageCount: number;
  charCount: number;
  errorCode: string | null;
  updatedAt: number;
}

export interface ChatSessionSnapshot {
  session: ChatSession;
  messages: ChatMessage[];
  contexts: Array<ChatContext & { paper: Paper }>;
}

export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export type AiStreamEvent =
  | { type: "thread"; threadId: string }
  | { type: "message"; itemId: string; text: string }
  | { type: "completed"; usage: CodexUsage | null }
  | { type: "interrupted" }
  | { type: "error"; message: string };

export interface AiTurnRequest {
  requestId: string;
  prompt: string;
  model: CodexModel;
  reasoningEffort: ReasoningEffort;
  outputSchema?: Record<string, unknown>;
}

export interface AIProvider {
  cancel(requestId: string): Promise<void>;
  getStatus(): Promise<CodexRuntimeStatus>;
  streamTurn(
    request: AiTurnRequest,
    onEvent: (event: AiStreamEvent) => void,
  ): Promise<void>;
}
