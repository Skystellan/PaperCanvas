ALTER TABLE board_edges
ADD COLUMN relation_type TEXT
CHECK (relation_type IN ('support', 'challenge'));
