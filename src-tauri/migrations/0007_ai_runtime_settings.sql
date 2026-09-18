CREATE TABLE IF NOT EXISTS ai_runtime_settings (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'default'),
  provider TEXT NOT NULL DEFAULT 'codex-local' CHECK (provider = 'codex-local'),
  model TEXT NOT NULL DEFAULT 'gpt-5.6-luna' CHECK (model = 'gpt-5.6-luna'),
  reasoning_effort TEXT NOT NULL DEFAULT 'medium'
    CHECK (reasoning_effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  updated_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO ai_runtime_settings (
  id,
  provider,
  model,
  reasoning_effort,
  updated_at
) VALUES (
  'default',
  'codex-local',
  'gpt-5.6-luna',
  'medium',
  0
);
