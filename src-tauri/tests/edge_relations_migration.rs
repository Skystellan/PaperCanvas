use paper_canvas_lib::{
    edge_migration_sql, edge_relations_migration_sql, initial_migration_sql, library_migration_sql,
    note_migration_sql,
};
use rusqlite::{params, Connection};

#[test]
fn existing_edges_start_neutral_and_only_accept_supported_relations() {
    let connection = Connection::open_in_memory().expect("database opens");
    for migration in [
        initial_migration_sql(),
        library_migration_sql(),
        note_migration_sql(),
        edge_migration_sql(),
    ] {
        connection
            .execute_batch(migration)
            .expect("existing migration applies");
    }
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
                1_i64
            ],
        )
        .expect("legacy edge inserts");

    connection
        .execute_batch(edge_relations_migration_sql())
        .expect("edge relation migration applies");
    let relation: Option<String> = connection
        .query_row(
            "SELECT relation_type FROM board_edges WHERE id = ?1",
            ["edge-attention-bert"],
            |row| row.get(0),
        )
        .expect("edge remains queryable");
    assert_eq!(relation, None);

    connection
        .execute(
            "UPDATE board_edges SET relation_type = 'support' WHERE id = ?1",
            ["edge-attention-bert"],
        )
        .expect("support is valid");
    assert!(
        connection
            .execute(
                "UPDATE board_edges SET relation_type = 'other' WHERE id = ?1",
                ["edge-attention-bert"],
            )
            .is_err(),
        "unknown relation must be rejected"
    );
}
