CREATE TABLE pdf_highlights (
    id TEXT PRIMARY KEY NOT NULL,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL CHECK (page_number > 0),
    selected_text TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    rects_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX pdf_highlights_paper_page_index
ON pdf_highlights(paper_id, page_number, created_at);
