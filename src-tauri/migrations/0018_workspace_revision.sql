-- This is the board-default snapshot revision, not a catalog event counter.
-- Off-board imports/metadata edits do not invalidate an unsaved canvas layout.
-- Domain changes do invalidate it; deleting papers is covered by node cascades.
CREATE TABLE workspace_revision (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0)
);
INSERT INTO workspace_revision (id, revision) VALUES (1, 0);

CREATE TRIGGER workspace_papers_updated
AFTER UPDATE ON papers
WHEN (OLD.id IS NOT NEW.id OR OLD.title IS NOT NEW.title
   OR OLD.authors IS NOT NEW.authors OR OLD.year IS NOT NEW.year
   OR OLD.file_path IS NOT NEW.file_path OR OLD.created_at IS NOT NEW.created_at
   OR OLD.domain_id IS NOT NEW.domain_id)
 AND EXISTS (SELECT 1 FROM board_nodes
             WHERE board_id = 'board-default' AND paper_id IN (OLD.id, NEW.id))
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER workspace_domains_inserted AFTER INSERT ON paper_domains
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER workspace_domains_updated AFTER UPDATE ON paper_domains
WHEN OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name
  OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER workspace_domains_deleted AFTER DELETE ON paper_domains
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER workspace_nodes_inserted AFTER INSERT ON board_nodes
WHEN NEW.board_id = 'board-default'
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER workspace_nodes_updated AFTER UPDATE ON board_nodes
WHEN (OLD.board_id = 'board-default' OR NEW.board_id = 'board-default')
 AND (OLD.id IS NOT NEW.id OR OLD.board_id IS NOT NEW.board_id
   OR OLD.paper_id IS NOT NEW.paper_id OR OLD.x IS NOT NEW.x OR OLD.y IS NOT NEW.y
   OR OLD.width IS NOT NEW.width OR OLD.height IS NOT NEW.height)
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER workspace_nodes_deleted AFTER DELETE ON board_nodes
WHEN OLD.board_id = 'board-default'
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER workspace_edges_inserted AFTER INSERT ON board_edges
WHEN NEW.board_id = 'board-default'
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER workspace_edges_updated AFTER UPDATE ON board_edges
WHEN (OLD.board_id = 'board-default' OR NEW.board_id = 'board-default')
 AND (OLD.id IS NOT NEW.id OR OLD.board_id IS NOT NEW.board_id
   OR OLD.source_node_id IS NOT NEW.source_node_id OR OLD.target_node_id IS NOT NEW.target_node_id
   OR OLD.created_at IS NOT NEW.created_at OR OLD.relation_type IS NOT NEW.relation_type
   OR OLD.explanation IS NOT NEW.explanation OR OLD.evidence IS NOT NEW.evidence)
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER workspace_edges_deleted AFTER DELETE ON board_edges
WHEN OLD.board_id = 'board-default'
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;
