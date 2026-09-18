use paper_canvas_lib::{
    atomic_chat_turns_migration_sql, atomic_model_settings_migration_sql, chat_migration_sql,
    edge_migration_sql, highlight_migration_sql, initial_migration_sql, library_migration_sql,
    mind_map_migration_sql, model_settings_migration_sql, note_migration_sql,
    paper_text_migration_sql, runtime_settings_migration_sql,
};
use rusqlite::Connection;

fn apply_existing_schema(connection: &Connection) {
    connection
        .execute_batch("PRAGMA foreign_keys = ON")
        .expect("foreign keys enable");
    for migration in [
        initial_migration_sql(),
        library_migration_sql(),
        note_migration_sql(),
        edge_migration_sql(),
        highlight_migration_sql(),
        mind_map_migration_sql(),
        runtime_settings_migration_sql(),
        paper_text_migration_sql(),
        chat_migration_sql(),
    ] {
        connection
            .execute_batch(migration)
            .expect("existing migration applies");
    }
}

#[test]
fn atomic_chat_turn_migration_touches_sessions_without_partial_message_pairs() {
    let connection = Connection::open_in_memory().expect("database opens");
    apply_existing_schema(&connection);
    connection
        .execute_batch(model_settings_migration_sql())
        .expect("model settings migration applies");
    connection
        .execute_batch(atomic_chat_turns_migration_sql())
        .expect("atomic chat turn migration applies");
    connection
        .execute(
            "INSERT INTO chat_sessions
             (id, title, provider, model, created_at, updated_at)
             VALUES ('chat-atomic', 'Atomic turn', 'codex-local', 'gpt-5.6-luna', 1, 1)",
            [],
        )
        .expect("session inserts");

    connection
        .execute(
            "INSERT INTO chat_messages
             (id, session_id, role, content, status, position, created_at, updated_at)
             VALUES
               ('user-1', 'chat-atomic', 'user', 'Question', 'complete', 0, 9, 9),
               ('assistant-1', 'chat-atomic', 'assistant', '', 'streaming', 1, 9, 9)",
            [],
        )
        .expect("both turn messages insert in one statement");
    let state: (i64, i64) = connection
        .query_row(
            "SELECT
               (SELECT COUNT(*) FROM chat_messages WHERE session_id = 'chat-atomic'),
               updated_at
             FROM chat_sessions WHERE id = 'chat-atomic'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("turn state remains readable");
    assert_eq!(state, (2, 9));

    assert!(connection
        .execute(
            "INSERT INTO chat_messages
             (id, session_id, role, content, status, position, created_at, updated_at)
             VALUES
               ('user-2', 'chat-atomic', 'user', 'Follow-up', 'complete', 2, 10, 10),
               ('assistant-1', 'chat-atomic', 'assistant', '', 'streaming', 3, 10, 10)",
            [],
        )
        .is_err());
    let after_failure: (i64, i64) = connection
        .query_row(
            "SELECT
               (SELECT COUNT(*) FROM chat_messages WHERE session_id = 'chat-atomic'),
               updated_at
             FROM chat_sessions WHERE id = 'chat-atomic'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("failed pair remains atomic");
    assert_eq!(after_failure, (2, 9));
}

#[test]
fn model_settings_migration_preserves_chat_data_and_expands_only_allowlisted_values() {
    let connection = Connection::open_in_memory().expect("database opens");
    apply_existing_schema(&connection);
    connection
        .execute_batch(
            "INSERT INTO chat_sessions
             (id, title, provider, model, created_at, updated_at)
             VALUES ('chat-1', 'Model migration', 'codex-local', 'gpt-5.6-luna', 1, 1);
             INSERT INTO chat_contexts (session_id, paper_id, position, created_at)
             VALUES ('chat-1', 'paper-attention', 0, 2);
             INSERT INTO chat_messages
             (id, session_id, role, content, status, position, created_at, updated_at)
             VALUES ('message-1', 'chat-1', 'user', 'hello', 'complete', 0, 3, 3);",
        )
        .expect("legacy chat state inserts");

    connection
        .execute_batch(model_settings_migration_sql())
        .expect("model settings migration applies");
    connection
        .execute_batch(atomic_model_settings_migration_sql())
        .expect("atomic model settings migration applies");
    connection
        .execute(
            "UPDATE ai_runtime_settings
             SET model = 'gpt-5.6-sol', reasoning_effort = 'max',
                 applied_session_id = 'chat-1', updated_at = 99
             WHERE id = 'default'",
            [],
        )
        .expect("Sol settings are accepted");

    let preserved: (String, String, i64, i64) = connection
        .query_row(
            "SELECT
               (SELECT model FROM ai_runtime_settings WHERE id = 'default'),
               model,
               (SELECT COUNT(*) FROM chat_contexts WHERE session_id = 'chat-1'),
               (SELECT COUNT(*) FROM chat_messages WHERE session_id = 'chat-1')
             FROM chat_sessions WHERE id = 'chat-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("migrated state remains readable");
    assert_eq!(
        preserved,
        ("gpt-5.6-sol".into(), "gpt-5.6-sol".into(), 1, 1)
    );

    assert!(connection
        .execute(
            "UPDATE ai_runtime_settings
             SET model = 'gpt-5.6-terra', applied_session_id = 'missing-chat'
             WHERE id = 'default'",
            [],
        )
        .is_err());
    let after_rejected_target: (String, String) = connection
        .query_row(
            "SELECT
               (SELECT model FROM ai_runtime_settings WHERE id = 'default'),
               model
             FROM chat_sessions WHERE id = 'chat-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("failed atomic update leaves both model values readable");
    assert_eq!(
        after_rejected_target,
        ("gpt-5.6-sol".into(), "gpt-5.6-sol".into())
    );

    assert!(connection
        .execute(
            "UPDATE ai_runtime_settings SET model = 'gpt-5.6-unknown' WHERE id = 'default'",
            [],
        )
        .is_err());
    assert!(connection
        .execute(
            "UPDATE ai_runtime_settings SET reasoning_effort = 'minimal' WHERE id = 'default'",
            [],
        )
        .is_err());

    connection
        .execute("DELETE FROM papers WHERE id = 'paper-attention'", [])
        .expect("paper delete still cascades after table rebuild");
    let state: (i64, i64, String) = connection
        .query_row(
            "SELECT
               (SELECT COUNT(*) FROM chat_contexts WHERE session_id = 'chat-1'),
               (SELECT COUNT(*) FROM chat_messages WHERE session_id = 'chat-1'),
               runtime_sync_state
             FROM chat_sessions WHERE id = 'chat-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("session remains after paper cascade");
    assert_eq!(state, (0, 1, "desynced".into()));
}
