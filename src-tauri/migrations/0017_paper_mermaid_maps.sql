CREATE TABLE paper_mermaid_maps (
    paper_id TEXT PRIMARY KEY NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
