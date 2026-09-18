use paper_canvas_lib::{
    atomic_model_settings_migration_sql, chat_migration_sql, edge_migration_sql,
    highlight_migration_sql, initial_migration_sql, library_migration_sql, mind_map_migration_sql,
    model_settings_migration_sql, note_migration_sql, paper_domains_migration_sql,
    paper_text_migration_sql, runtime_settings_migration_sql,
};
use rusqlite::{params, Connection};

fn apply_schema_through_v11(connection: &Connection) {
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
        model_settings_migration_sql(),
        atomic_model_settings_migration_sql(),
    ] {
        connection
            .execute_batch(migration)
            .expect("existing migration applies");
    }
}

#[test]
fn paper_domains_preserve_existing_papers_and_delete_to_unclassified() {
    let connection = Connection::open_in_memory().expect("database opens");
    apply_schema_through_v11(&connection);
    let existing_papers: i64 = connection
        .query_row("SELECT COUNT(*) FROM papers", [], |row| row.get(0))
        .expect("seeded papers are queryable");

    connection
        .execute_batch(paper_domains_migration_sql())
        .expect("paper domains migration applies");
    let unclassified: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM papers WHERE domain_id IS NULL",
            [],
            |row| row.get(0),
        )
        .expect("migrated papers remain queryable");
    assert_eq!(unclassified, existing_papers);

    connection
        .execute(
            "INSERT INTO paper_domains (id, name, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3)",
            params!["domain-ai", "AI", 10_i64],
        )
        .expect("valid domain inserts");
    connection
        .execute(
            "UPDATE papers SET domain_id = ?1 WHERE id = ?2",
            params!["domain-ai", "paper-attention"],
        )
        .expect("paper assigns to a domain");

    connection
        .execute("DELETE FROM paper_domains WHERE id = ?1", ["domain-ai"])
        .expect("domain deletes without deleting papers");
    let preserved: (i64, Option<String>) = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM papers), domain_id
             FROM papers WHERE id = 'paper-attention'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("paper remains after its domain is deleted");
    assert_eq!(preserved, (existing_papers, None));

    let foreign_key_errors: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .expect("foreign key check runs");
    assert_eq!(foreign_key_errors, 0);
}

#[test]
fn paper_domains_enforce_names_and_references_at_the_database_boundary() {
    let connection = Connection::open_in_memory().expect("database opens");
    apply_schema_through_v11(&connection);
    connection
        .execute_batch(paper_domains_migration_sql())
        .expect("paper domains migration applies");
    connection
        .execute(
            "INSERT INTO paper_domains (id, name, created_at, updated_at)
             VALUES ('domain-ai', 'AI', 1, 1)",
            [],
        )
        .expect("valid domain inserts");

    for (id, name) in [
        ("blank", "".to_string()),
        ("untrimmed", " AI ".to_string()),
        ("too-long", "a".repeat(81)),
    ] {
        assert!(
            connection
                .execute(
                    "INSERT INTO paper_domains (id, name, created_at, updated_at)
                     VALUES (?1, ?2, 1, 1)",
                    params![id, name],
                )
                .is_err(),
            "invalid names must be rejected"
        );
    }
    assert!(connection
        .execute(
            "INSERT INTO paper_domains (id, name, created_at, updated_at)
             VALUES ('duplicate-case', 'ai', 1, 1)",
            [],
        )
        .is_err());
    assert!(connection
        .execute(
            "UPDATE papers SET domain_id = 'missing-domain'
             WHERE id = 'paper-attention'",
            [],
        )
        .is_err());
}
