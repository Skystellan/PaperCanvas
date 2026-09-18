CREATE TRIGGER chat_message_inserted_touches_session
AFTER INSERT ON chat_messages
BEGIN
  UPDATE chat_sessions
  SET updated_at = MAX(updated_at, NEW.updated_at)
  WHERE id = NEW.session_id;
END;
