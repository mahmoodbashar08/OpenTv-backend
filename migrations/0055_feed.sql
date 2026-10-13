-- The friends feed (2.0.0, 13 Oct 2026) — `GET /v1/me/feed`, routes/feed.ts.
--
-- No new table. The feed is read straight from the three tables that already
-- hold what people do in the app, one statement each, for the people the
-- reader follows. What those tables lacked is an index that answers "this
-- person's LIVE events after a time" without walking every row they ever
-- wrote — the shape of the 0016 bug, where one unindexed subquery read 174M
-- rows in a day.
--
-- PARTIAL ON `imported_at IS NULL`. The archive (seven years of TV Time,
-- seeded) is the bulk of every one of these tables and never appears in a
-- feed — "archive, not activity" (0029). Leaving it out keeps the indexes the
-- size of real activity, and the feed's WHERE repeats the predicate so SQLite
-- can use them.
--
-- `emotion_votes` needs nothing: the feelings on a rating card are probed from
-- the ratings row by the table's own primary key.
CREATE INDEX IF NOT EXISTS idx_comments_author_live
  ON comments (author_id, created_at) WHERE imported_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ratings_author_live
  ON ratings (author_id, created_at) WHERE imported_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_character_votes_voter_live
  ON character_votes (voter_id, created_at) WHERE imported_at IS NULL;
