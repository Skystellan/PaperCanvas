use paper_canvas_lib::{
    chat_migration_sql, edge_migration_sql, highlight_migration_sql, initial_migration_sql,
    library_migration_sql, mind_map_migration_sql, note_migration_sql, paper_text_migration_sql,
    runtime_settings_migration_sql,
};
use rusqlite::{params, Connection};
use std::{fs, path::PathBuf};
use uuid::Uuid;

struct TestDatabase(PathBuf);

impl TestDatabase {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("papercanvas-v4-v6-{}.db", Uuid::new_v4())))
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn apply_all(connection: &Connection) {
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
            .expect("V4–V6 migration applies");
    }
}

#[test]
fn reader_artifacts_full_text_and_chat_restore_after_reopen() {
    let database = TestDatabase::new();
    let connection = Connection::open(&database.0).expect("database opens");
    apply_all(&connection);
    connection
        .execute(
            "INSERT INTO papers (id, title, authors, year, file_path, created_at)
             VALUES (?1, ?2, NULL, NULL, ?3, ?4)",
            params!["paper-local", "Local paper", "papers/local.pdf", 10_i64],
        )
        .expect("paper inserts");
    connection
        .execute(
            "INSERT INTO pdf_highlights
             (id, paper_id, page_number, selected_text, comment, rects_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                "highlight-1",
                "paper-local",
                2_i64,
                "selected claim",
                "important",
                r#"[{"left":0.1,"top":0.2,"width":0.3,"height":0.04}]"#,
                11_i64
            ],
        )
        .expect("highlight inserts");
    connection
        .execute(
            "INSERT INTO paper_mind_maps
             (paper_id, tree_json, schema_version, revision, updated_at)
             VALUES (?1, ?2, 1, 1, ?3)",
            params![
                "paper-local",
                r#"{"schemaVersion":1,"revision":1,"sourcePrompt":"Map it","updatedAt":12,"nodes":[]}"#,
                12_i64
            ],
        )
        .expect("mind map inserts");
    connection
        .execute(
            "INSERT INTO paper_texts
             (paper_id, status, content, page_count, char_count, error_code, updated_at)
             VALUES (?1, 'ready', ?2, 3, ?3, NULL, ?4)",
            params!["paper-local", "complete paper text", 19_i64, 13_i64],
        )
        .expect("paper text inserts");
    connection
        .execute(
            "INSERT INTO chat_sessions
             (id, title, provider, model, created_at, updated_at)
             VALUES (?1, ?2, 'codex-local', 'gpt-5.6-luna', ?3, ?3)",
            params!["chat-1", "Persistent discussion", 14_i64],
        )
        .expect("chat session inserts");
    connection
        .execute(
            "INSERT INTO chat_contexts (session_id, paper_id, position, created_at)
             VALUES (?1, ?2, 0, ?3)",
            params!["chat-1", "paper-local", 15_i64],
        )
        .expect("explicit context inserts");
    connection
        .execute(
            "INSERT INTO chat_messages
             (id, session_id, role, content, status, position, created_at, updated_at)
             VALUES (?1, ?2, 'user', ?3, 'complete', 0, ?4, ?4),
                    (?5, ?2, 'assistant', ?6, 'complete', 1, ?4, ?4)",
            params![
                "message-user",
                "chat-1",
                "What is the claim?",
                16_i64,
                "message-assistant",
                "The complete paper says…"
            ],
        )
        .expect("messages insert");
    drop(connection);

    let reopened = Connection::open(&database.0).expect("database reopens");
    reopened
        .execute_batch("PRAGMA foreign_keys = ON")
        .expect("foreign keys re-enable");
    let restored: (i64, i64, i64, i64, String, i64, String) = reopened
        .query_row(
            "SELECT
               (SELECT COUNT(*) FROM pdf_highlights WHERE paper_id = 'paper-local'),
               (SELECT COUNT(*) FROM paper_mind_maps WHERE paper_id = 'paper-local'),
               (SELECT COUNT(*) FROM paper_texts WHERE paper_id = 'paper-local'),
               (SELECT COUNT(*) FROM chat_messages WHERE session_id = 'chat-1'),
               runtime_sync_state,
               context_revision,
               (SELECT content FROM paper_texts WHERE paper_id = 'paper-local')
             FROM chat_sessions WHERE id = 'chat-1'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .expect("V4–V6 state restores");
    assert_eq!(
        restored,
        (
            1,
            1,
            1,
            2,
            "desynced".into(),
            1,
            "complete paper text".into()
        )
    );

    let settings: (String, String, String) = reopened
        .query_row(
            "SELECT provider, model, reasoning_effort
             FROM ai_runtime_settings WHERE id = 'default'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("safe local runtime defaults restore");
    assert_eq!(
        settings,
        ("codex-local".into(), "gpt-5.6-luna".into(), "medium".into())
    );
}

#[test]
fn removing_explicit_context_or_its_paper_desynchronizes_the_codex_thread() {
    let connection = Connection::open_in_memory().expect("database opens");
    apply_all(&connection);
    connection
        .execute(
            "INSERT INTO chat_sessions
             (id, title, provider, model, codex_thread_id, context_revision,
              codex_context_revision, runtime_sync_state, created_at, updated_at)
             VALUES ('chat-1', 'Context test', 'codex-local', 'gpt-5.6-luna',
                     NULL, 0, NULL, 'new', 1, 1)",
            [],
        )
        .expect("session inserts");
    connection
        .execute(
            "INSERT INTO chat_contexts (session_id, paper_id, position, created_at)
             VALUES ('chat-1', 'paper-attention', 0, 2)",
            [],
        )
        .expect("context inserts");
    connection
        .execute(
            "UPDATE chat_sessions SET codex_thread_id = 'thread-1',
             codex_context_revision = context_revision, runtime_sync_state = 'synced'
             WHERE id = 'chat-1'",
            [],
        )
        .expect("runtime marks synced");
    connection
        .execute("DELETE FROM papers WHERE id = 'paper-attention'", [])
        .expect("paper deletes with context cascade");

    let state: (i64, String, i64) = connection
        .query_row(
            "SELECT context_revision, runtime_sync_state,
                    (SELECT COUNT(*) FROM chat_contexts WHERE session_id = 'chat-1')
             FROM chat_sessions WHERE id = 'chat-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("session remains queryable");
    assert_eq!(state, (2, "desynced".into(), 0));
}
