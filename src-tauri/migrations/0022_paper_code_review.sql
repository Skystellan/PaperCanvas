ALTER TABLE papers ADD COLUMN code_review TEXT CHECK (code_review IS NULL OR json_valid(code_review));

CREATE TRIGGER workspace_paper_code_review_updated
AFTER UPDATE OF code_review ON papers
WHEN OLD.code_review IS NOT NEW.code_review
 AND EXISTS (SELECT 1 FROM board_nodes WHERE board_id = 'board-default' AND paper_id = NEW.id)
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;

UPDATE research_batch_nodes SET snapshot = json_insert(snapshot, '$[#]', NULL);
