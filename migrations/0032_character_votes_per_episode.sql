-- One favourite per EPISODE, not one per show.
--
-- 0003 keyed this table `(voter_id, target_source, target_key)` on the grounds
-- that "nobody wants a favourite character percentage for S03E07, and a
-- per-episode rollup would spread a few thousand votes so thinly that every bar
-- would read 100%". THAT ARGUMENT IS STILL RIGHT, and nothing here contradicts
-- it: the ROLLUP stays per show.
--
-- What it got wrong was applying the same rule to STORAGE. TV Time asked the
-- question per episode and every archive carries the answers that way, so
-- collapsing on import threw them away — `POST /v1/character-votes/import`
-- reported the extras as `skipped`, which was honest and still a loss. Measured
-- on one real archive: 17 votes, 5 shows with more than one, 8 rows dropped.
-- A ten-year library loses the same proportion of hundreds.
--
-- So: the row is per episode, the aggregate is per show and still counts each
-- voter once — their most recent favourite for that show.
--
-- COALESCE IN THE KEY, because season and episode are nullable and SQLite
-- treats every NULL as distinct in a uniqueness rule — without it one person
-- could vote twice on the same unnumbered episode. Same reason
-- `idx_one_vote_per_person` needs it; the ON CONFLICT clause in
-- `routes/characters.ts` repeats this expression exactly, and the two must move
-- together.

DROP INDEX IF EXISTS idx_one_character_vote_per_person;

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_character_vote_per_episode
  ON character_votes (
    voter_id,
    target_source,
    target_key,
    COALESCE(season, -1),
    COALESCE(episode, -1)
  );

-- Reading a show's votes newest-first is now a per-request operation (the
-- rollup delta needs the voter's latest favourite for the show), so it gets an
-- index rather than a scan.
CREATE INDEX IF NOT EXISTS idx_character_votes_voter_target_recent
  ON character_votes (voter_id, target_source, target_key, created_at DESC);
