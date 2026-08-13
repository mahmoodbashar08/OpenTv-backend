-- Asking to follow a private profile — the half of `is_private` that was
-- missing.
--
-- A private profile has always withheld its counts, bio and links from anybody
-- who is not an accepted follower, and there has never been a way to BECOME
-- one: `POST /v1/follows/:id` wrote an accepted edge for everybody, so a
-- private account was either wide open to whoever tapped Follow or, if the app
-- hid the button, a wall with no door. Neither is what the switch promises.
--
-- The state rides on the edge itself rather than in a second `follow_requests`
-- table, because a request and a follow are the same relationship at two
-- moments: one row means the primary key still enforces "one edge per pair",
-- accepting is an UPDATE rather than a delete-and-insert across two tables, and
-- cancelling a request is the DELETE that unfollowing already was.
--
-- EXISTING ROWS ARE 'accepted' — nobody loses a follower to this migration.
-- Everything that COUNTS or LISTS follows must now say `state = 'accepted'`
-- explicitly; a read that forgets it counts people who have merely asked.
ALTER TABLE follows ADD COLUMN state TEXT NOT NULL DEFAULT 'accepted'
  CHECK (state IN ('pending','accepted'));
