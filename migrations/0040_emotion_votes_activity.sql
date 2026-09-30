-- The dashboard's "today" and activity windows filter emotion_votes by
-- imported_at and created_at like the other three vote tables, which each have
-- this index. Without it every dashboard open scanned the whole table.
CREATE INDEX IF NOT EXISTS idx_emotion_votes_activity ON emotion_votes (imported_at, created_at);
