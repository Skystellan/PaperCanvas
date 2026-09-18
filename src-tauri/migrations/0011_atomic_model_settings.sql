ALTER TABLE ai_runtime_settings
ADD COLUMN applied_session_id TEXT;

CREATE TRIGGER ai_runtime_settings_session_exists
BEFORE UPDATE OF model, applied_session_id ON ai_runtime_settings
WHEN NEW.applied_session_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM chat_sessions WHERE id = NEW.applied_session_id
  )
BEGIN
  SELECT RAISE(ABORT, 'AI settings target session does not exist');
END;

CREATE TRIGGER ai_runtime_settings_applied_to_session
AFTER UPDATE OF model, applied_session_id ON ai_runtime_settings
WHEN NEW.applied_session_id IS NOT NULL
BEGIN
  UPDATE chat_sessions
  SET model = NEW.model,
      updated_at = NEW.updated_at
  WHERE id = NEW.applied_session_id;
END;
