-- Four numbers, because the profile shows four.
--
-- `profile_stats` published two: episodes watched, and one combined minutes
-- figure covering shows and films together. The Profile tab — the screen a
-- public profile is supposed to be identical to — shows FOUR cards: TV time,
-- episodes watched, MOVIE time and MOVIES watched. Two of them could not be
-- drawn from what was stored, so the community profile had a different Stats
-- section from the owner's, which is the whole thing this was meant to avoid.
--
-- `minutes_watched` now means SHOW minutes alone and `movie_minutes` is its
-- pair. That is a change of meaning for an existing column, not just an
-- addition, so every client re-publishes: `PUBLISH_REVISION` in
-- mobile/src/community-publish.ts is bumped in the same commit. Until a phone
-- syncs again its profile shows the old combined figure as TV time — high
-- rather than wrong, and corrected on that phone's next launch.

ALTER TABLE profile_stats ADD COLUMN movie_minutes INTEGER NOT NULL DEFAULT 0;
