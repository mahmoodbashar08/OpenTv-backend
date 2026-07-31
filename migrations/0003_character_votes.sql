-- "Who was your favourite?" — the third thing a TV Time archive carries, after
-- comments and ratings, and the only one with no home on the server until now.
--
-- The app asks the question per EPISODE (`character_votes` in mobile/src/db.ts
-- is keyed `(showId, season, episode)` and holds a `name` and a TheTVDB
-- `charId`). The community answer is per SHOW: nobody wants a favourite
-- character percentage for S03E07, and a per-episode rollup would spread a few
-- thousand votes so thinly that every bar would read 100%. So the season and
-- episode a vote came from are KEPT as provenance and are deliberately NOT part
-- of the uniqueness rule — one person, one favourite, per show.
--
-- Where a local vote carries no name at all (a `charId` with no cached
-- metadata), the importer skips it: the rollup is keyed by the name, because
-- the name is the only half of the pair that can be rendered without a TheTVDB
-- licence.

CREATE TABLE IF NOT EXISTS character_votes (
  id             TEXT PRIMARY KEY,
  voter_id       TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  target_source  TEXT NOT NULL CHECK (target_source IN ('tvdb','tmdb','title')),
  target_key     TEXT NOT NULL,
  character_name TEXT NOT NULL,
  character_id   INTEGER,             -- TheTVDB's, as the app stores it; kept so
                                      -- a later licence can collapse spelling
                                      -- variants without re-asking anybody
  season         INTEGER,             -- provenance only: the episode the vote
  episode        INTEGER,             -- was cast on, never part of the key
  created_at     TEXT NOT NULL
);

-- One favourite per person per show. COALESCE for the same reason
-- `idx_one_vote_per_person` needs it: nothing nullable may take part in a
-- uniqueness rule here, or SQLite treats every NULL as distinct and the same
-- person votes twice. Neither column in this key is nullable, so no COALESCE is
-- required — recorded explicitly so the next reader does not assume it was
-- forgotten.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_character_vote_per_person
  ON character_votes (voter_id, target_source, target_key);

CREATE INDEX IF NOT EXISTS idx_character_votes_target
  ON character_votes (target_source, target_key);

-- The rollup, computed on WRITE and never on read. A Worker gets 10ms of CPU on
-- the free plan; counting votes per character on every show screen would spend
-- all of it scanning, and the answer would be identical for every reader. Same
-- philosophy as `rating_aggregates`, same accepted consequence: this table is
-- allowed to drift, and `src/jobs.ts` recounts it nightly.
--
-- `counts` is a JSON object of character name → votes, so a show gaining a
-- fourteenth character needs no migration. Names reach the write path through
-- `validateCharacterName`, which refuses a `"` or a backslash — the name is
-- interpolated into a JSON path (`'$."' || ? || '"'`), and a name that could
-- close that quote would be a path injection.
CREATE TABLE IF NOT EXISTS character_vote_aggregates (
  target_source TEXT NOT NULL,
  target_key    TEXT NOT NULL,
  counts        TEXT,                          -- JSON {"Michael Scott": 42}
  total         INTEGER NOT NULL DEFAULT 0,    -- people, not characters
  updated_at    TEXT,
  PRIMARY KEY (target_source, target_key)
);
