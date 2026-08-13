-- The reply count was reading the whole comments table, per comment, per page.
--
-- Every listing carries a `reply_count` for each top-level comment it returns,
-- and that subquery filters on `parent_id` — the one column with no index on
-- it. So SQLite answered each one with a full scan: a page of 20 comments cost
-- 20 × every comment in the database. At 8,719 comments that is ~174,000 rows
-- read to draw one screen, and it grows with the whole community rather than
-- with the thread being read. It was the reason a 17 MB database read 174
-- million rows in a day, 35× the free plan's allowance, with nobody noticing
-- because nothing failed.
--
-- PARTIAL, because only replies have a parent. Top-level comments are the
-- overwhelming majority and indexing their NULLs would store a row per comment
-- to answer a question never asked of them.
CREATE INDEX IF NOT EXISTS idx_comments_parent
  ON comments (parent_id)
  WHERE parent_id IS NOT NULL;
