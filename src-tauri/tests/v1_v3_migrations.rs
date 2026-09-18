use paper_canvas_lib::{
    edge_migration_sql, initial_migration_sql, library_migration_sql, note_migration_sql,
};
use rusqlite::{params, Connection};
use std::{fs, path::PathBuf};
use uuid::Uuid;

struct TestDatabase(PathBuf);

impl TestDatabase {
    fn new(label: &str) -> Self {
        Self(std::env::temp_dir().join(format!("papercanvas-{label}-{}.db", Uuid::new_v4())))
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn apply_all(connection: &Connection) {
    connection
        .execute_batch(initial_migration_sql())
        .expect("V0 migration should apply");
    connection
        .execute_batch(library_migration_sql())
        .expect("library migration should apply");
    connection
        .execute_batch(note_migration_sql())
        .expect("note migration should apply");
    connection
        .execute_batch(edge_migration_sql())
        .expect("edge migration should apply");
}

#[test]
fn v0_papers_nodes_and_positions_survive_all_upgrades() {
    let database = TestDatabase::new("migration-upgrade");
    let connection = Connection::open(&database.0).expect("database should open");
    connection
        .execute_batch(initial_migration_sql())
        .expect("V0 migration should apply");
    connection
        .execute(
            "UPDATE board_nodes SET x = ?1, y = ?2 WHERE id = ?3",
            params![831.5, 449.25, "node-attention"],
        )
        .expect("V0 position should update");

    connection
        .execute_batch(library_migration_sql())
        .expect("library migration should apply");
    connection
        .execute_batch(note_migration_sql())
        .expect("note migration should apply");
    connection
        .execute_batch(edge_migration_sql())
        .expect("edge migration should apply");

    let counts: (i64, i64) = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM papers), (SELECT COUNT(*) FROM board_nodes)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("upgraded records should be queryable");
    assert_eq!(counts, (3, 3));

    let restored: (f64, f64, Option<String>) = connection
        .query_row(
            "SELECT board_nodes.x, board_nodes.y, papers.file_path
             FROM board_nodes
             JOIN papers ON papers.id = board_nodes.paper_id
             WHERE board_nodes.id = ?1",
            ["node-attention"],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("upgraded node should remain queryable");
    assert_eq!(restored, (831.5, 449.25, None));

    let foreign_key_errors: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .expect("foreign key check should run");
    assert_eq!(foreign_key_errors, 0);
}

#[test]
fn notes_and_edges_survive_reopen_and_enforce_board_boundaries() {
    let database = TestDatabase::new("notes-edges");
    let connection = Connection::open(&database.0).expect("database should open");
    apply_all(&connection);

    connection
        .execute(
            "INSERT INTO notes (id, paper_id, content, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(paper_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
            params!["note-attention", "paper-attention", "first", 1_i64],
        )
        .expect("note should insert");
    connection
        .execute(
            "INSERT INTO notes (id, paper_id, content, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(paper_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
            params!["ignored-id", "paper-attention", "latest 🧪", 2_i64],
        )
        .expect("note should upsert");
    connection
        .execute(
            "INSERT INTO board_edges
             (id, board_id, source_node_id, target_node_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                "edge-attention-bert",
                "board-default",
                "node-attention",
                "node-bert",
                3_i64
            ],
        )
        .expect("edge should insert");
    drop(connection);

    let reopened = Connection::open(&database.0).expect("database should reopen");
    reopened
        .execute_batch("PRAGMA foreign_keys = ON")
        .expect("foreign keys should enable");
    let note: (String, i64) = reopened
        .query_row(
            "SELECT content, updated_at FROM notes WHERE paper_id = ?1",
            ["paper-attention"],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("note should restore");
    assert_eq!(note, ("latest 🧪".to_string(), 2));
    let edge_count: i64 = reopened
        .query_row("SELECT COUNT(*) FROM board_edges", [], |row| row.get(0))
        .expect("edge should restore");
    assert_eq!(edge_count, 1);

    reopened
        .execute(
            "INSERT INTO boards (id, title) VALUES (?1, ?2)",
            params!["board-other", "Other"],
        )
        .expect("second board should insert");
    let cross_board = reopened.execute(
        "INSERT INTO board_edges
         (id, board_id, source_node_id, target_node_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            "edge-invalid",
            "board-other",
            "node-attention",
            "node-bert",
            4_i64
        ],
    );
    assert!(cross_board.is_err(), "cross-board edges must be rejected");

    reopened
        .execute("DELETE FROM board_nodes WHERE id = ?1", ["node-attention"])
        .expect("node should delete");
    let remaining_edges: i64 = reopened
        .query_row("SELECT COUNT(*) FROM board_edges", [], |row| row.get(0))
        .expect("edges should remain queryable");
    assert_eq!(remaining_edges, 0, "connected edges should cascade");
}
