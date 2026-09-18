CREATE TABLE paper_domains (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL
        CHECK (name = trim(name) AND length(name) BETWEEN 1 AND 80),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX paper_domains_name_unique_index
ON paper_domains(name COLLATE NOCASE);

ALTER TABLE papers
ADD COLUMN domain_id TEXT REFERENCES paper_domains(id) ON DELETE SET NULL;

CREATE INDEX papers_domain_created_index
ON papers(domain_id, created_at DESC);
