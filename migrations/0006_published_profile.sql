-- A profile you can actually look at.
--
-- Until now the server held a person's comments, ratings and lists and nothing
-- else, because the product promise was that watch history never leaves the
-- phone. That makes another user's profile almost empty: a name, a follower
-- count, and a shelf of lists. design/referance/51-user-profile-sarah.png is
-- the target and it is mostly history — TV time, episodes watched, the shows
-- and films they follow, and their favourites.
--
-- THIS CHANGES THE PROMISE, and the app's copy changes with it in the same
-- release: the join screen, the About page and the published privacy policy all
-- currently say the history stays on the device. Shipping these tables without
-- rewriting those three is shipping a lie, and the policy is the one the stores
-- review.
--
-- WHAT IS STORED IS A PUBLISHED SUMMARY, NOT THE HISTORY ITSELF. There is
-- still no table here that records that a particular episode was watched on a
-- particular date — the thing that would let anyone reconstruct a viewing
-- timeline. What a profile publishes is: how much has been watched in total,
-- and WHICH titles are followed or favourited. That is what the design shows
-- and it is the least that can satisfy it.
--
-- IT IS DERIVED, SO IT IS DISPOSABLE. Every row here is recomputed from the
-- phone's own database and re-uploaded; nothing is authoritative and losing all
-- of it costs one sync. That is why there is no history table and no
-- reconciliation job: the device is still the source of truth.

CREATE TABLE IF NOT EXISTS profile_stats (
  profile_id       TEXT PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
  -- The two numbers the design prints as "23,560" and "19 months 6 days".
  episodes_watched INTEGER NOT NULL DEFAULT 0,
  minutes_watched  INTEGER NOT NULL DEFAULT 0,
  -- Shelf counts, so a profile can say "42 shows" without paging the titles.
  shows_count      INTEGER NOT NULL DEFAULT 0,
  movies_count     INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL
);

-- One row per title a profile publishes.
--
-- `target_source` + `target_key` are the SAME identity the comments and ratings
-- use (`targetKey` in pure.ts), so a profile's shelf and a title's thread agree
-- about what they are pointing at. `name` and `poster` are denormalised on
-- purpose: a shelf must render without the reader's device knowing anything
-- about a show it has never tracked, and the alternative is a metadata lookup
-- per tile.
CREATE TABLE IF NOT EXISTS profile_titles (
  profile_id    TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('show', 'movie')),
  target_source TEXT NOT NULL CHECK (target_source IN ('tvdb', 'tmdb', 'title')),
  target_key    TEXT NOT NULL,
  name          TEXT,
  poster        TEXT,
  -- The heart. A favourite is also on the ordinary shelf, so a reader who
  -- opens "Shows" sees everything and "Favourite shows" is a filter of it.
  favourite     INTEGER NOT NULL DEFAULT 0 CHECK (favourite IN (0, 1)),
  -- The order the owner arranged them in, favourites especially. NULL sorts
  -- last so an unranked shelf still has a stable order by name.
  rank          INTEGER,
  PRIMARY KEY (profile_id, kind, target_key)
);

-- The shelf query: one profile, one kind, favourites first.
CREATE INDEX IF NOT EXISTS idx_profile_titles_shelf
  ON profile_titles (profile_id, kind, favourite, rank);
