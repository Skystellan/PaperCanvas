CREATE TABLE ai_runtime_settings_v10 (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'default'),
  provider TEXT NOT NULL DEFAULT 'codex-local' CHECK (provider = 'codex-local'),
  model TEXT NOT NULL DEFAULT 'gpt-5.6-luna'
    CHECK (model IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')),
  reasoning_effort TEXT NOT NULL DEFAULT 'medium'
    CHECK (reasoning_effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  updated_at INTEGER NOT NULL DEFAULT 0
);

INSERT INTO ai_runtime_settings_v10 (
  id, provider, model, reasoning_effort, updated_at
)
SELECT id, provider, model, reasoning_effort, updated_at
FROM ai_runtime_settings;

DROP TABLE ai_runtime_settings;
ALTER TABLE ai_runtime_settings_v10 RENAME TO ai_runtime_settings;

CREATE TABLE chat_sessions_v10 (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  provider TEXT NOT NULL CHECK (provider = 'codex-local'),
  model TEXT NOT NULL
    CHECK (model IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')),
  codex_thread_id TEXT,
  context_revision INTEGER NOT NULL DEFAULT 0 CHECK (context_revision >= 0),
  codex_context_revision INTEGER,
  runtime_sync_state TEXT NOT NULL DEFAULT 'new'
    CHECK (runtime_sync_state IN ('new', 'synced', 'desynced')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE chat_contexts_v10 (
  session_id TEXT NOT NULL,
  paper_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, paper_id),
  FOREIGN KEY (session_id) REFERENCES chat_sessions_v10(id) ON DELETE CASCADE,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);

CREATE TABLE chat_messages_v10 (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('streaming', 'complete', 'interrupted', 'error')),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions_v10(id) ON DELETE CASCADE
);

INSERT INTO chat_sessions_v10 (
  id, title, provider, model, codex_thread_id, context_revision,
  codex_context_revision, runtime_sync_state, created_at, updated_at
)
SELECT
  id, title, provider, model, codex_thread_id, context_revision,
  codex_context_revision, runtime_sync_state, created_at, updated_at
FROM chat_sessions;

INSERT INTO chat_contexts_v10 (session_id, paper_id, position, created_at)
SELECT session_id, paper_id, position, created_at
FROM chat_contexts;

INSERT INTO chat_messages_v10 (
  id, session_id, role, content, status, position, created_at, updated_at
)
SELECT id, session_id, role, content, status, position, created_at, updated_at
FROM chat_messages;

DROP TRIGGER chat_context_added;
DROP TRIGGER chat_context_removed;
DROP INDEX idx_chat_context_position;
DROP INDEX idx_chat_message_position;
DROP TABLE chat_contexts;
DROP TABLE chat_messages;
DROP TABLE chat_sessions;

ALTER TABLE chat_sessions_v10 RENAME TO chat_sessions;
ALTER TABLE chat_contexts_v10 RENAME TO chat_contexts;
ALTER TABLE chat_messages_v10 RENAME TO chat_messages;

CREATE UNIQUE INDEX idx_chat_context_position
  ON chat_contexts(session_id, position);

CREATE UNIQUE INDEX idx_chat_message_position
  ON chat_messages(session_id, position);

CREATE TRIGGER chat_context_added
AFTER INSERT ON chat_contexts
BEGIN
  UPDATE chat_sessions
  SET context_revision = context_revision + 1,
      runtime_sync_state = 'desynced',
      updated_at = NEW.created_at
  WHERE id = NEW.session_id;
END;

CREATE TRIGGER chat_context_removed
AFTER DELETE ON chat_contexts
BEGIN
  UPDATE chat_sessions
  SET context_revision = context_revision + 1,
      runtime_sync_state = 'desynced',
      updated_at = MAX(updated_at, OLD.created_at)
  WHERE id = OLD.session_id;
END;
