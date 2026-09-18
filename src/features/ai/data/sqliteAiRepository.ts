import {
  getDatabase,
  type DatabaseProvider,
} from "../../../data/sqliteDatabase";
import type { Paper } from "../../library";
import type {
  AiRuntimeSettings,
  ChatContext,
  ChatMessage,
  ChatSession,
  ChatSessionSnapshot,
  CodexModel,
  StoredPaperText,
} from "../model/ai";
import {
  DEFAULT_CODEX_MODEL,
  isCodexModel,
  isReasoningEffort,
  LOCAL_CODEX_PROVIDER,
} from "../model/ai";
import type { AiRepository, BeginTurnInput } from "./aiRepository";

interface SettingsRow {
  provider: typeof LOCAL_CODEX_PROVIDER;
  model: string;
  reasoning_effort: string;
  updated_at: number;
}

interface SessionRow {
  id: string;
  title: string;
  provider: typeof LOCAL_CODEX_PROVIDER;
  model: string;
  codex_thread_id: string | null;
  context_revision: number;
  codex_context_revision: number | null;
  runtime_sync_state: ChatSession["runtimeSyncState"];
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: ChatMessage["role"];
  content: string;
  status: ChatMessage["status"];
  position: number;
  created_at: number;
  updated_at: number;
}

interface ContextPaperRow {
  session_id: string;
  paper_id: string;
  position: number;
  context_created_at: number;
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  file_path: string | null;
  domain_id: string | null;
  paper_created_at: number;
}

interface PaperTextRow {
  paper_id: string;
  status: StoredPaperText["status"];
  content: string | null;
  page_count: number;
  char_count: number;
  error_code: string | null;
  updated_at: number;
}

function toSettings(row: SettingsRow): AiRuntimeSettings {
  return {
    provider: row.provider,
    model: isCodexModel(row.model) ? row.model : DEFAULT_CODEX_MODEL,
    reasoningEffort: isReasoningEffort(row.reasoning_effort)
      ? row.reasoning_effort
      : "medium",
    updatedAt: row.updated_at,
  };
}

function toSession(row: SessionRow): ChatSession {
  return {
    id: row.id,
    title: row.title,
    provider: row.provider,
    model: isCodexModel(row.model) ? row.model : DEFAULT_CODEX_MODEL,
    codexThreadId: row.codex_thread_id,
    contextRevision: row.context_revision,
    codexContextRevision: row.codex_context_revision,
    runtimeSyncState: row.runtime_sync_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    status: row.status,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPaperText(row: PaperTextRow): StoredPaperText {
  return {
    paperId: row.paper_id,
    status: row.status,
    content: row.content,
    pageCount: row.page_count,
    charCount: row.char_count,
    errorCode: row.error_code,
    updatedAt: row.updated_at,
  };
}

const SESSION_COLUMNS = `
  id, title, provider, model, codex_thread_id, context_revision,
  codex_context_revision, runtime_sync_state, created_at, updated_at
`;

export class SqliteAiRepository implements AiRepository {
  constructor(private readonly databaseProvider: DatabaseProvider = getDatabase) {}

  async getSettings(): Promise<AiRuntimeSettings> {
    const database = await this.databaseProvider();
    const rows = await database.select<SettingsRow[]>(
      `
        SELECT provider, model, reasoning_effort, updated_at
        FROM ai_runtime_settings
        WHERE id = 'default'
        LIMIT 1
      `,
    );
    if (!rows[0]) throw new Error("Local Codex settings are unavailable.");
    return toSettings(rows[0]);
  }

  async saveSettings(
    settings: AiRuntimeSettings,
    sessionId: string,
  ): Promise<void> {
    const database = await this.databaseProvider();
    await database.execute(
      `
        UPDATE ai_runtime_settings
        SET model = ?1, reasoning_effort = ?2, updated_at = ?3,
            applied_session_id = ?4
        WHERE id = 'default'
      `,
      [
        settings.model,
        settings.reasoningEffort,
        settings.updatedAt,
        sessionId,
      ],
    );
  }

  async listSessions(): Promise<ChatSession[]> {
    const database = await this.databaseProvider();
    const rows = await database.select<SessionRow[]>(
      `SELECT ${SESSION_COLUMNS} FROM chat_sessions ORDER BY updated_at DESC`,
    );
    return rows.map(toSession);
  }

  async createSession({
    id,
    model,
    timestamp,
    title,
  }: {
    id: string;
    model: CodexModel;
    timestamp: number;
    title: string;
  }): Promise<ChatSession> {
    const database = await this.databaseProvider();
    await database.execute(
      `
        INSERT INTO chat_sessions (
          id, title, provider, model, codex_thread_id, context_revision,
          codex_context_revision, runtime_sync_state, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, NULL, 0, NULL, 'new', ?5, ?5)
      `,
      [id, title, LOCAL_CODEX_PROVIDER, model, timestamp],
    );
    return {
      id,
      title,
      provider: LOCAL_CODEX_PROVIDER,
      model,
      codexThreadId: null,
      contextRevision: 0,
      codexContextRevision: null,
      runtimeSyncState: "new",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  async renameSession(sessionId: string, title: string, timestamp: number): Promise<void> {
    const database = await this.databaseProvider();
    await database.execute(
      `UPDATE chat_sessions SET title = ?1, updated_at = ?2 WHERE id = ?3`,
      [title.trim(), timestamp, sessionId],
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    const database = await this.databaseProvider();
    await database.execute(`DELETE FROM chat_sessions WHERE id = ?1`, [sessionId]);
  }

  async loadSession(sessionId: string): Promise<ChatSessionSnapshot | null> {
    const database = await this.databaseProvider();
    const sessionRows = await database.select<SessionRow[]>(
      `SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE id = ?1 LIMIT 1`,
      [sessionId],
    );
    if (!sessionRows[0]) return null;

    const messageRows = await database.select<MessageRow[]>(
      `
        SELECT id, session_id, role, content, status, position, created_at, updated_at
        FROM chat_messages
        WHERE session_id = ?1
        ORDER BY position ASC
      `,
      [sessionId],
    );
    const contextRows = await database.select<ContextPaperRow[]>(
      `
        SELECT
          context.session_id,
          context.paper_id,
          context.position,
          context.created_at AS context_created_at,
          paper.id,
          paper.title,
          paper.authors,
          paper.year,
          paper.file_path,
          paper.domain_id,
          paper.created_at AS paper_created_at
        FROM chat_contexts context
        INNER JOIN papers paper ON paper.id = context.paper_id
        WHERE context.session_id = ?1
        ORDER BY context.position ASC
      `,
      [sessionId],
    );

    return {
      session: toSession(sessionRows[0]),
      messages: messageRows.map(toMessage),
      contexts: contextRows.map((row) => {
        const context: ChatContext = {
          sessionId: row.session_id,
          paperId: row.paper_id,
          position: row.position,
          createdAt: row.context_created_at,
        };
        const paper: Paper = {
          id: row.id,
          title: row.title,
          authors: row.authors,
          year: row.year,
          filePath: row.file_path,
          domainId: row.domain_id,
          createdAt: row.paper_created_at,
        };
        return { ...context, paper };
      }),
    };
  }

  async addContext(sessionId: string, paperId: string, timestamp: number): Promise<void> {
    const database = await this.databaseProvider();
    await database.execute(
      `
        INSERT INTO chat_contexts (session_id, paper_id, position, created_at)
        SELECT ?1, ?2, COALESCE(MAX(position) + 1, 0), ?3
        FROM chat_contexts
        WHERE session_id = ?1
        ON CONFLICT(session_id, paper_id) DO NOTHING
      `,
      [sessionId, paperId, timestamp],
    );
  }

  async removeContext(sessionId: string, paperId: string, timestamp: number): Promise<void> {
    const database = await this.databaseProvider();
    await database.execute(
      `DELETE FROM chat_contexts WHERE session_id = ?1 AND paper_id = ?2`,
      [sessionId, paperId],
    );
    await database.execute(
      `UPDATE chat_sessions SET updated_at = ?1 WHERE id = ?2`,
      [timestamp, sessionId],
    );
  }

  async beginTurn({
    assistantMessageId,
    nextPosition,
    sessionId,
    timestamp,
    userContent,
    userMessageId,
  }: BeginTurnInput) {
    const database = await this.databaseProvider();
    await database.execute(
      `
        INSERT INTO chat_messages (
          id, session_id, role, content, status, position, created_at, updated_at
        ) VALUES
          (?2, ?1, 'user', ?3, 'complete', ?5, ?6, ?6),
          (?4, ?1, 'assistant', '', 'streaming', ?5 + 1, ?6, ?6)
      `,
      [
        sessionId,
        userMessageId,
        userContent,
        assistantMessageId,
        nextPosition,
        timestamp,
      ],
    );
    return {
      userMessage: {
        id: userMessageId,
        sessionId,
        role: "user" as const,
        content: userContent,
        status: "complete" as const,
        position: nextPosition,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      assistantMessage: {
        id: assistantMessageId,
        sessionId,
        role: "assistant" as const,
        content: "",
        status: "streaming" as const,
        position: nextPosition + 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };
  }

  async updateMessage({
    content,
    id,
    status,
    timestamp,
  }: {
    content: string;
    id: string;
    status: ChatMessage["status"];
    timestamp: number;
  }): Promise<void> {
    const database = await this.databaseProvider();
    await database.execute(
      `
        UPDATE chat_messages
        SET content = ?1, status = ?2, updated_at = ?3
        WHERE id = ?4
      `,
      [content, status, timestamp, id],
    );
    if (status !== "streaming") {
      await database.execute(
        `
          UPDATE chat_sessions
          SET updated_at = ?1
          WHERE id = (SELECT session_id FROM chat_messages WHERE id = ?2)
        `,
        [timestamp, id],
      );
    }
  }

  async markStreamingMessagesInterrupted(timestamp: number): Promise<number> {
    const database = await this.databaseProvider();
    const result = await database.execute(
      `
        UPDATE chat_messages
        SET status = 'interrupted', updated_at = ?1
        WHERE status = 'streaming'
      `,
      [timestamp],
    );
    return result.rowsAffected;
  }

  async updateRuntimeSync({
    codexContextRevision,
    codexThreadId,
    sessionId,
    state,
    timestamp,
  }: {
    codexContextRevision: number | null;
    codexThreadId: string | null;
    sessionId: string;
    state: ChatSession["runtimeSyncState"];
    timestamp: number;
  }): Promise<void> {
    const database = await this.databaseProvider();
    await database.execute(
      `
        UPDATE chat_sessions
        SET codex_thread_id = ?1,
            codex_context_revision = ?2,
            runtime_sync_state = ?3,
            updated_at = ?4
        WHERE id = ?5
      `,
      [codexThreadId, codexContextRevision, state, timestamp, sessionId],
    );
  }

  async getPaperText(paperId: string): Promise<StoredPaperText | null> {
    const database = await this.databaseProvider();
    const rows = await database.select<PaperTextRow[]>(
      `
        SELECT paper_id, status, content, page_count, char_count, error_code, updated_at
        FROM paper_texts
        WHERE paper_id = ?1
        LIMIT 1
      `,
      [paperId],
    );
    return rows[0] ? toPaperText(rows[0]) : null;
  }

  async savePaperText(text: StoredPaperText): Promise<void> {
    const database = await this.databaseProvider();
    await database.execute(
      `
        INSERT INTO paper_texts (
          paper_id, status, content, page_count, char_count, error_code, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(paper_id) DO UPDATE SET
          status = excluded.status,
          content = excluded.content,
          page_count = excluded.page_count,
          char_count = excluded.char_count,
          error_code = excluded.error_code,
          updated_at = excluded.updated_at
        WHERE paper_texts.status <> 'ready' OR excluded.status = 'ready'
      `,
      [
        text.paperId,
        text.status,
        text.content,
        text.pageCount,
        text.charCount,
        text.errorCode,
        text.updatedAt,
      ],
    );
  }
}

export const sqliteAiRepository = new SqliteAiRepository();
