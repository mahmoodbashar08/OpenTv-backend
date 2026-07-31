-- Feelings are a SET, not a single choice.
--
-- The app has always let a person tap several feelings on one episode — the
-- twelve of `EMOTIONS` are a multi-select, not a radio group — and the server
-- has always stored exactly one of them, in `ratings.emotion`, one column that
-- can hold one string. Everything after the first tap was discarded on arrival:
-- SHOCKED and THRILLED on the same film became SHOCKED, silently, with a 200
-- and an aggregate that agreed with itself. Nobody could see the loss, because
-- the number that came back was internally consistent.
--
-- A column cannot hold a set. A table can. `emotion_votes` holds one row per
-- (person, target, feeling), so a person's selections for one target are simply
-- the rows they have, and there is no cardinality left to lose.
--
-- WHAT `emotion_counts` NOW MEANS. Same table, same column, same JSON shape —
-- but it counts SELECTIONS (rows here), not people. One person who picks two
-- feelings puts 1 in each of two keys, and the app renders percentages over the
-- SUM of the object, so that person alone reads 50% / 50%. `vote_count` is
-- untouched and still counts PEOPLE: it is the number of `ratings` rows, which
-- is why a ratings row with a NULL score continues to exist for someone who
-- only ever tapped a feeling.
--
-- The two numbers therefore no longer agree, and are not meant to: for a
-- target, sum(emotion_counts) >= vote_count is the normal state.

CREATE TABLE IF NOT EXISTS emotion_votes (
  author_id     TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  target_source TEXT NOT NULL CHECK (target_source IN ('tvdb','tmdb','title')),
  target_key    TEXT NOT NULL,
  -- -1 rather than NULL, exactly as `rating_aggregates` does it and for exactly
  -- the same reason: these columns are part of a PRIMARY KEY, and SQLite treats
  -- every NULL in a key as distinct — a show-level feeling could otherwise be
  -- inserted over and over. `ratings` keeps its NULLs and COALESCEs on read;
  -- this table is keyed like the rollup it feeds, so the join needs no COALESCE
  -- on this side.
  season        INTEGER NOT NULL DEFAULT -1,
  episode       INTEGER NOT NULL DEFAULT -1,
  emotion       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  -- The uniqueness rule IS the set semantics: one person cannot hold the same
  -- feeling twice on the same target, and holds as many different ones as they
  -- tapped.
  PRIMARY KEY (author_id, target_source, target_key, season, episode, emotion)
);

-- The rollup rebuild's access path (`src/jobs.ts`): count by target, not by
-- person. The primary key leads with `author_id` and is useless for it.
CREATE INDEX IF NOT EXISTS idx_emotion_votes_target
  ON emotion_votes (target_source, target_key, season, episode);

-- ── the migration of real data ───────────────────────────────────────────────
--
-- Unlike 0004, this one CAN be backfilled and must be. Every existing
-- `ratings.emotion` is a feeling a real person really chose; it is simply the
-- only one of theirs that survived. Each becomes one row here, and the counts
-- come out identical to what they were — one person, one feeling, one tally —
-- so no percentage anybody has already seen moves because of this migration.
-- Only future multi-selections widen them.
--
-- COALESCE on the way in because `ratings` stores NULL for a show- or
-- film-level vote and this table stores -1.
INSERT OR IGNORE INTO emotion_votes
  (author_id, target_source, target_key, season, episode, emotion, created_at)
SELECT author_id, target_source, target_key,
       COALESCE(season, -1), COALESCE(episode, -1), emotion, created_at
  FROM ratings
 WHERE emotion IS NOT NULL;

-- And the column is emptied in the same migration, so the datum lives in
-- exactly one place. Leaving it populated would make the nightly reconciliation
-- a coin toss between two sources of truth, and double-count the day someone
-- decided to sum them.
UPDATE ratings SET emotion = NULL WHERE emotion IS NOT NULL;

-- ── why `ratings.emotion` is STRANDED and not dropped ────────────────────────
--
-- SQLite's DROP COLUMN is a table rebuild: a new table, a copy of every row,
-- every index and every expression-index recreated — including
-- `idx_one_vote_per_person`, whose COALESCE expression the two upsert paths
-- name literally — on a live database, to reclaim one always-NULL column. The
-- rebuild is the only step in this migration that could lose a vote.
--
-- So the column stays, permanently NULL, and NOTHING WRITES IT AGAIN. The write
-- paths (`src/routes/ratings.ts`, `src/routes/import.ts`) no longer name it in
-- an INSERT; the reconciliation reads `emotion_votes`. A future rebuild for
-- some other reason may drop it as a passenger.
