-- Additive migration: no existing papers, cards, annotations or layouts change.
CREATE TABLE research_batches (
    id TEXT PRIMARY KEY NOT NULL,
    request_id TEXT UNIQUE NOT NULL,
    request_json TEXT NOT NULL,
    title TEXT NOT NULL,
    intent TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    undone INTEGER NOT NULL DEFAULT 0 CHECK (undone IN (0, 1))
);

CREATE TABLE research_papers (
    paper_id TEXT PRIMARY KEY NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    metadata TEXT NOT NULL CHECK (json_valid(metadata))
);
CREATE TABLE research_identities (
    kind TEXT NOT NULL CHECK (kind IN ('doi', 'arxiv', 'url')),
    identity TEXT NOT NULL,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    PRIMARY KEY (kind, identity)
);
CREATE UNIQUE INDEX research_stable_identity_per_paper
ON research_identities(paper_id, kind) WHERE kind IN ('doi', 'arxiv');
CREATE INDEX research_identity_paper ON research_identities(paper_id);

CREATE TABLE research_edges (
    edge_id TEXT PRIMARY KEY NOT NULL REFERENCES board_edges(id) ON DELETE CASCADE,
    metadata TEXT NOT NULL CHECK (json_valid(metadata))
);

-- Deliberately retain these snapshots when a user deletes a card or edge.
-- A missing/changed record must conflict rather than make undo delete new work.
CREATE TABLE research_batch_nodes (
    batch_id TEXT NOT NULL REFERENCES research_batches(id),
    node_id TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    PRIMARY KEY (batch_id, node_id)
);
CREATE TABLE research_batch_edges (
    batch_id TEXT NOT NULL REFERENCES research_batches(id),
    edge_id TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    PRIMARY KEY (batch_id, edge_id)
);

CREATE TRIGGER workspace_research_papers_inserted AFTER INSERT ON research_papers
WHEN EXISTS (SELECT 1 FROM board_nodes WHERE board_id = 'board-default' AND paper_id = NEW.paper_id)
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER workspace_research_papers_updated AFTER UPDATE ON research_papers
WHEN (OLD.paper_id IS NOT NEW.paper_id OR OLD.metadata IS NOT NEW.metadata)
 AND EXISTS (SELECT 1 FROM board_nodes WHERE board_id = 'board-default' AND paper_id IN (OLD.paper_id, NEW.paper_id))
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER workspace_research_papers_deleted AFTER DELETE ON research_papers
WHEN EXISTS (SELECT 1 FROM board_nodes WHERE board_id = 'board-default' AND paper_id = OLD.paper_id)
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER workspace_research_edges_inserted AFTER INSERT ON research_edges
WHEN EXISTS (SELECT 1 FROM board_edges WHERE board_id = 'board-default' AND id = NEW.edge_id)
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER workspace_research_edges_updated AFTER UPDATE ON research_edges
WHEN (OLD.edge_id IS NOT NEW.edge_id OR OLD.metadata IS NOT NEW.metadata)
 AND EXISTS (SELECT 1 FROM board_edges WHERE board_id = 'board-default' AND id IN (OLD.edge_id, NEW.edge_id))
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER workspace_research_edges_deleted AFTER DELETE ON research_edges
WHEN EXISTS (SELECT 1 FROM board_edges WHERE board_id = 'board-default' AND id = OLD.edge_id)
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;
