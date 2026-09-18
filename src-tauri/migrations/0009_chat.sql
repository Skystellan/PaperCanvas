CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  provider TEXT NOT NULL CHECK (provider = 'codex-local'),
  model TEXT NOT NULL CHECK (model = 'gpt-5.6-luna'),
  codex_thread_id TEXT,
  context_revision INTEGER NOT NULL DEFAULT 0 CHECK (context_revision >= 0),
  codex_context_revision INTEGER,
  runtime_sync_state TEXT NOT NULL DEFAULT 'new'
    CHECK (runtime_sync_state IN ('new', 'synced', 'desynced')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE chat_contexts (
  session_id TEXT NOT NULL,
  paper_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, paper_id),
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_chat_context_position
  ON chat_contexts(session_id, position);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('streaming', 'complete', 'interrupted', 'error')),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

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
