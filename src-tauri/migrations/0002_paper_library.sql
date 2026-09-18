CREATE TABLE papers_v2 (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    authors TEXT,
    year INTEGER,
    file_path TEXT UNIQUE,
    created_at INTEGER NOT NULL
);

CREATE TABLE board_nodes_v2 (
    id TEXT PRIMARY KEY NOT NULL,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    paper_id TEXT NOT NULL REFERENCES papers_v2(id) ON DELETE CASCADE,
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL CHECK (width > 0),
    height REAL NOT NULL CHECK (height > 0),
    UNIQUE (board_id, paper_id)
);

INSERT INTO papers_v2 (id, title, authors, year, file_path, created_at)
SELECT
    id,
    title,
    NULLIF(authors, ''),
    CASE WHEN year > 0 THEN year ELSE NULL END,
    NULL,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM papers;

INSERT INTO board_nodes_v2 (id, board_id, paper_id, x, y, width, height)
SELECT id, board_id, paper_id, x, y, width, height
FROM board_nodes;

DROP TABLE board_nodes;
DROP TABLE papers;

ALTER TABLE papers_v2 RENAME TO papers;
ALTER TABLE board_nodes_v2 RENAME TO board_nodes;

CREATE INDEX board_nodes_board_id_index ON board_nodes(board_id);
