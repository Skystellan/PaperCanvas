CREATE TABLE paper_web_chats (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    url TEXT,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL
);
CREATE INDEX paper_web_chats_by_paper ON paper_web_chats(paper_id, last_opened_at DESC);
