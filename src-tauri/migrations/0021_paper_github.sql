ALTER TABLE papers ADD COLUMN github_url TEXT;
ALTER TABLE papers ADD COLUMN github_stars INTEGER
    CHECK (github_stars IS NULL OR (github_url IS NOT NULL AND github_stars BETWEEN 0 AND 9007199254740991));

CREATE TRIGGER workspace_paper_github_updated
AFTER UPDATE OF github_url, github_stars ON papers
WHEN (OLD.github_url IS NOT NEW.github_url OR OLD.github_stars IS NOT NEW.github_stars)
 AND EXISTS (SELECT 1 FROM board_nodes WHERE board_id = 'board-default' AND paper_id = NEW.id)
BEGIN
    UPDATE workspace_revision SET revision = revision + 1 WHERE id = 1;
END;

-- Extend saved snapshots without replacing their original metadata/positions.
UPDATE research_batch_nodes SET snapshot = json_insert(snapshot, '$[#]', NULL, '$[#]', NULL);
