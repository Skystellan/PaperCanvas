CREATE UNIQUE INDEX board_nodes_board_id_id_unique
ON board_nodes(board_id, id);

CREATE TABLE board_edges (
    id TEXT PRIMARY KEY NOT NULL,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (source_node_id <> target_node_id),
    UNIQUE (board_id, source_node_id, target_node_id),
    FOREIGN KEY (board_id, source_node_id)
        REFERENCES board_nodes(board_id, id) ON DELETE CASCADE,
    FOREIGN KEY (board_id, target_node_id)
        REFERENCES board_nodes(board_id, id) ON DELETE CASCADE
);

CREATE INDEX board_edges_board_id_index ON board_edges(board_id);
