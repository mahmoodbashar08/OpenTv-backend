-- When each title FIRST appeared on somebody's public shelf. The shelf itself
-- is replaced on every sync, so it cannot say what is new; this can. Only
-- titles the owner chose to show on their public profile — never what they
-- watched. Everything already on a shelf counts as old.
CREATE TABLE IF NOT EXISTS shelf_seen (
  profile_id    TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  target_key    TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, kind, target_key)
);
CREATE INDEX IF NOT EXISTS idx_shelf_seen_day ON shelf_seen (first_seen_at);
INSERT OR IGNORE INTO shelf_seen (profile_id, kind, target_key, first_seen_at)
  SELECT profile_id, kind, target_key, '2000-01-01T00:00:00.000Z' FROM profile_titles;
