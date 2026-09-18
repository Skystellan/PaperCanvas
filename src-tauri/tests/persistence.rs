use paper_canvas_lib::initial_migration_sql;
use rusqlite::{params, Connection};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const UPDATE_TWO_NODE_POSITIONS: &str = r#"
    WITH positions(id, x, y) AS (
        VALUES (?1, ?2, ?3), (?4, ?5, ?6)
    )
    UPDATE board_nodes
    SET
        x = (SELECT positions.x FROM positions WHERE positions.id = board_nodes.id),
        y = (SELECT positions.y FROM positions WHERE positions.id = board_nodes.id)
    WHERE board_nodes.board_id = ?7
      AND board_nodes.id IN (SELECT positions.id FROM positions)
      AND (
        SELECT COUNT(*)
        FROM board_nodes AS persisted_nodes
        WHERE persisted_nodes.board_id = ?7
          AND persisted_nodes.id IN (SELECT positions.id FROM positions)
      ) = (SELECT COUNT(*) FROM positions)
"#;

struct TestDatabase {
    path: PathBuf,
}

impl TestDatabase {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("papercanvas-persistence-{}.db", Uuid::new_v4()));
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[test]
fn seeded_card_positions_survive_a_database_reopen() {
    let database = TestDatabase::new();
    let connection = Connection::open(database.path()).expect("test database should open");
    connection
        .execute_batch(initial_migration_sql())
        .expect("initial migration should apply");

    let seeded_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM board_nodes", [], |row| row.get(0))
        .expect("seeded cards should be queryable");
    assert_eq!(seeded_count, 3);

    connection
        .execute(
            "UPDATE board_nodes SET x = ?1, y = ?2 WHERE id = ?3",
            params![531.25, 287.75, "node-attention"],
        )
        .expect("card position should update");
    drop(connection);

    let reopened = Connection::open(database.path()).expect("test database should reopen");
    let restored_position: (f64, f64) = reopened
        .query_row(
            "SELECT x, y FROM board_nodes WHERE id = ?1",
            ["node-attention"],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("updated card should still exist after reopening");

    assert_eq!(restored_position, (531.25, 287.75));
}

#[test]
fn position_snapshot_updates_all_nodes_or_none() {
    let database = TestDatabase::new();
    let connection = Connection::open(database.path()).expect("test database should open");
    connection
        .execute_batch(initial_migration_sql())
        .expect("initial migration should apply");

    let updated = connection
        .execute(
            UPDATE_TWO_NODE_POSITIONS,
            params![
                "node-attention",
                410.0,
                220.0,
                "node-bert",
                730.0,
                415.0,
                "board-default"
            ],
        )
        .expect("complete position snapshot should update");
    assert_eq!(updated, 2);

    let attention_position: (f64, f64) = connection
        .query_row(
            "SELECT x, y FROM board_nodes WHERE id = ?1",
            ["node-attention"],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("updated node should remain queryable");
    assert_eq!(attention_position, (410.0, 220.0));

    let updated = connection
        .execute(
            UPDATE_TWO_NODE_POSITIONS,
            params![
                "node-attention",
                999.0,
                999.0,
                "node-missing",
                888.0,
                888.0,
                "board-default"
            ],
        )
        .expect("incomplete position snapshot should be rejected atomically");
    assert_eq!(updated, 0);

    let unchanged_position: (f64, f64) = connection
        .query_row(
            "SELECT x, y FROM board_nodes WHERE id = ?1",
            ["node-attention"],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("existing node should remain queryable");
    assert_eq!(unchanged_position, attention_position);
}
