-- WHICH DAYS A MEMBER OPENED THE APP, so the dashboard can look back.
--
-- `profiles.last_seen_at` only holds the latest open, so "who opened
-- yesterday" had no answer once they opened again today. One row per member
-- per day they opened -- a date, nothing else: not what they did, not when in
-- the day, not how often. Written on the same once-a-day guard as
-- last_seen_at and kept 90 days (pruned per member on write).
CREATE TABLE IF NOT EXISTS profile_days (
  profile_id TEXT NOT NULL,
  day        TEXT NOT NULL,  -- YYYY-MM-DD, UTC
  PRIMARY KEY (profile_id, day)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_profile_days_day ON profile_days (day);

-- The one day already known for everybody: their last open.
INSERT OR IGNORE INTO profile_days (profile_id, day)
  SELECT id, substr(last_seen_at, 1, 10) FROM profiles WHERE last_seen_at IS NOT NULL;
