CREATE TABLE paper_texts (
  paper_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'too_large', 'failed')),
  content TEXT,
  page_count INTEGER NOT NULL CHECK (page_count >= 0),
  char_count INTEGER NOT NULL CHECK (char_count >= 0),
  error_code TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE,
  CHECK (
    (status = 'ready' AND content IS NOT NULL AND error_code IS NULL)
    OR (status <> 'ready' AND content IS NULL)
  )
);
