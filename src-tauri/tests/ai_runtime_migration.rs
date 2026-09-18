use paper_canvas_lib::runtime_settings_migration_sql;
use rusqlite::Connection;

#[test]
fn runtime_settings_migration_is_idempotent_and_has_safe_defaults() {
    let connection = Connection::open_in_memory().expect("in-memory sqlite opens");
    connection
        .execute_batch(runtime_settings_migration_sql())
        .expect("first migration succeeds");
    connection
        .execute_batch(runtime_settings_migration_sql())
        .expect("migration remains idempotent");

    let row = connection
        .query_row(
            "SELECT provider, model, reasoning_effort FROM ai_runtime_settings WHERE id = 'default'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .expect("singleton settings row exists");

    assert_eq!(row.0, "codex-local");
    assert_eq!(row.1, "gpt-5.6-luna");
    assert_eq!(row.2, "medium");
}
