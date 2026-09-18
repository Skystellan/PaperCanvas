CREATE TABLE notes (
    id TEXT PRIMARY KEY NOT NULL,
    paper_id TEXT NOT NULL UNIQUE REFERENCES papers(id) ON DELETE CASCADE,
    content TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
);

CREATE INDEX notes_paper_id_index ON notes(paper_id);
