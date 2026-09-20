use paper_canvas_lib::migrations;
use rusqlite::{params, Connection};

#[test]
fn workspace_upgrade_preserves_legacy_data_and_cascades_only_canvas_deletions() {
    let db = Connection::open_in_memory().unwrap();
    let migrations = migrations();
    for migration in migrations
        .iter()
        .filter(|migration| migration.version <= 15)
    {
        db.execute_batch(migration.sql).unwrap();
    }
    let legacy =
        r#"{"schemaVersion":1,"revision":1,"nodes":[],"sourcePrompt":"old","updatedAt":1}"#;
    db.execute(
        "INSERT INTO paper_mind_maps VALUES (?1, ?2, 1, 1, 1)",
        params!["paper-attention", legacy],
    )
    .unwrap();
    db.execute(
        "INSERT INTO board_edges (id, board_id, source_node_id, target_node_id, created_at)
         VALUES ('edge', 'board-default', 'node-attention', 'node-bert', 1)",
        [],
    )
    .unwrap();
    for migration in migrations.iter().filter(|migration| migration.version > 15) {
        db.execute_batch(migration.sql).unwrap();
    }
    let edge: (String, String) = db
        .query_row(
            "SELECT explanation, evidence FROM board_edges WHERE id = 'edge'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(edge, (String::new(), String::new()));
    assert_eq!(
        db.query_row(
            "SELECT tree_json FROM paper_mind_maps WHERE paper_id = 'paper-attention'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        legacy
    );
    db.execute(
        "UPDATE board_edges SET explanation = ?1, evidence = ?2 WHERE id = 'edge'",
        params!["Supports the result", "Paper A, page 3, Table 1"],
    )
    .unwrap();
    db.execute(
        "INSERT INTO paper_mermaid_maps VALUES ('paper-attention', 'mindmap\n  root((Paper))', 1)",
        [],
    )
    .unwrap();
    db.execute("DELETE FROM board_nodes WHERE id = 'node-attention'", [])
        .unwrap();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM board_edges WHERE id = 'edge'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM papers WHERE id = 'paper-attention'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM paper_mermaid_maps WHERE paper_id = 'paper-attention'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    db.execute("DELETE FROM papers WHERE id = 'paper-attention'", [])
        .unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM paper_mermaid_maps", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
