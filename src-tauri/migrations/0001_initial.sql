PRAGMA foreign_keys = ON;

CREATE TABLE papers (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    authors TEXT NOT NULL,
    year INTEGER NOT NULL
);

CREATE TABLE boards (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL
);

CREATE TABLE board_nodes (
    id TEXT PRIMARY KEY NOT NULL,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL CHECK (width > 0),
    height REAL NOT NULL CHECK (height > 0),
    UNIQUE (board_id, paper_id)
);

CREATE INDEX board_nodes_board_id_index ON board_nodes(board_id);

INSERT INTO boards (id, title)
VALUES ('board-default', 'Research canvas');

INSERT INTO papers (id, title, authors, year)
VALUES
    ('paper-attention', 'Attention Is All You Need', 'Vaswani et al.', 2017),
    ('paper-bert', 'BERT: Pre-training of Deep Bidirectional Transformers', 'Devlin et al.', 2019),
    ('paper-resnet', 'Deep Residual Learning for Image Recognition', 'He et al.', 2016);

INSERT INTO board_nodes (id, board_id, paper_id, x, y, width, height)
VALUES
    ('node-attention', 'board-default', 'paper-attention', 120, 110, 280, 128),
    ('node-bert', 'board-default', 'paper-bert', 520, 245, 280, 128),
    ('node-resnet', 'board-default', 'paper-resnet', 250, 430, 280, 128);
