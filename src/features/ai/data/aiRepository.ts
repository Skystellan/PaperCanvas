import type {
  AiRuntimeSettings,
  ChatMessage,
  ChatMessageStatus,
  ChatSession,
  ChatSessionSnapshot,
  CodexModel,
  StoredPaperText,
} from "../model/ai";

export interface BeginTurnInput {
  assistantMessageId: string;
  nextPosition: number;
  sessionId: string;
  timestamp: number;
  userContent: string;
  userMessageId: string;
}

export interface BeginTurnResult {
  assistantMessage: ChatMessage;
  userMessage: ChatMessage;
}

export interface AiRepository {
  addContext(sessionId: string, paperId: string, timestamp: number): Promise<void>;
  beginTurn(input: BeginTurnInput): Promise<BeginTurnResult>;
  createSession(input: {
    id: string;
    model: CodexModel;
    timestamp: number;
    title: string;
  }): Promise<ChatSession>;
  deleteSession(sessionId: string): Promise<void>;
  getPaperText(paperId: string): Promise<StoredPaperText | null>;
  getSettings(): Promise<AiRuntimeSettings>;
  listSessions(): Promise<ChatSession[]>;
  loadSession(sessionId: string): Promise<ChatSessionSnapshot | null>;
  markStreamingMessagesInterrupted(timestamp: number): Promise<number>;
  removeContext(sessionId: string, paperId: string, timestamp: number): Promise<void>;
  renameSession(sessionId: string, title: string, timestamp: number): Promise<void>;
  savePaperText(text: StoredPaperText): Promise<void>;
  saveSettings(
    settings: AiRuntimeSettings,
    sessionId: string,
  ): Promise<void>;
  updateMessage(input: {
    content: string;
    id: string;
    status: ChatMessageStatus;
    timestamp: number;
  }): Promise<void>;
  updateRuntimeSync(input: {
    codexContextRevision: number | null;
    codexThreadId: string | null;
    sessionId: string;
    state: "desynced" | "new" | "synced";
    timestamp: number;
  }): Promise<void>;
}
