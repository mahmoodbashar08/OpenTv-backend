-- OpenTV social layer — initial schema
-- Generated from docs/schema.dbml. Read docs/PLAN.md before changing anything.
--
-- The phone's SQLite database is the source of truth for a user's own library.
-- Nothing here duplicates it. There is no watch-history table by design.

PRAGMA foreign_keys = ON;

-- ── identity ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS profiles (
  id             TEXT PRIMARY KEY,
  handle         TEXT NOT NULL UNIQUE,
  handle_lower   TEXT NOT NULL UNIQUE,   -- case-insensitive uniqueness; SQLite
                                         -- UNIQUE is case-SENSITIVE, so "Mahmood"
                                         -- and "mahmood" would otherwise coexist
  display_name   TEXT,
  avatar_key     TEXT,
  bio            TEXT,
  is_private     INTEGER NOT NULL DEFAULT 0,
  tvtime_user_id INTEGER,
  tvtime_handle  TEXT,
  links          TEXT,                   -- [plus] JSON array
  plus_until     TEXT,                   -- [plus] RevenueCat webhook only
  created_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_profiles_tvtime ON profiles (tvtime_user_id)
  WHERE tvtime_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS identities (
  provider    TEXT NOT NULL,
  external_id TEXT NOT NULL,
  profile_id  TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  email       TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (provider, external_id)
);
CREATE INDEX IF NOT EXISTS idx_identities_profile ON identities (profile_id);

-- ── social graph ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_reverse ON follows (followee_id);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

-- ── discussion ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS comments (
  id            TEXT PRIMARY KEY,
  author_id     TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  target_source TEXT NOT NULL CHECK (target_source IN ('tvdb','tmdb','title')),
  target_key    TEXT NOT NULL,
  season        INTEGER,
  episode       INTEGER,
  body          TEXT NOT NULL,
  is_spoiler    INTEGER NOT NULL DEFAULT 0,
  lang          TEXT,
  parent_id     TEXT REFERENCES comments (id) ON DELETE CASCADE,
  imported_at   TEXT,
  like_count    INTEGER NOT NULL DEFAULT 0,
  report_count  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  edited_at     TEXT,
  deleted_at    TEXT
);
-- The thread read: one lookup per comment section. deleted_at is in the index
-- so hidden comments are skipped without touching the table.
CREATE INDEX IF NOT EXISTS idx_comments_thread
  ON comments (target_source, target_key, season, episode, deleted_at);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments (author_id);

CREATE TABLE IF NOT EXISTS comment_likes (
  comment_id TEXT NOT NULL REFERENCES comments (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);

-- [plus] Nothing writes here until CSAM scanning is live.
CREATE TABLE IF NOT EXISTS comment_images (
  comment_id  TEXT PRIMARY KEY REFERENCES comments (id) ON DELETE CASCADE,
  r2_key      TEXT NOT NULL,
  width       INTEGER,
  height      INTEGER,
  is_gif      INTEGER NOT NULL DEFAULT 0,
  scan_status TEXT NOT NULL DEFAULT 'pending'
              CHECK (scan_status IN ('pending','clean','blocked')),
  scanned_at  TEXT,
  created_at  TEXT NOT NULL
);

-- ── ratings ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ratings (
  id            TEXT PRIMARY KEY,
  author_id     TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  target_source TEXT NOT NULL CHECK (target_source IN ('tvdb','tmdb','title')),
  target_key    TEXT NOT NULL,
  season        INTEGER,
  episode       INTEGER,
  score         INTEGER CHECK (score IS NULL OR (score BETWEEN 1 AND 10)),
  emotion       TEXT,
  created_at    TEXT NOT NULL
);
-- One vote per person per title. COALESCE because SQLite treats NULLs as
-- distinct in a UNIQUE index, so a show-level vote (season/episode NULL) could
-- otherwise be cast repeatedly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_vote_per_person
  ON ratings (author_id, target_source, target_key,
              COALESCE(season, -1), COALESCE(episode, -1));

CREATE TABLE IF NOT EXISTS rating_aggregates (
  target_source  TEXT NOT NULL,
  target_key     TEXT NOT NULL,
  season         INTEGER NOT NULL DEFAULT -1,  -- -1 rather than NULL: this is a
  episode        INTEGER NOT NULL DEFAULT -1,  -- PRIMARY KEY and NULLs break it
  vote_count     INTEGER NOT NULL DEFAULT 0,
  score_sum      INTEGER NOT NULL DEFAULT 0,
  emotion_counts TEXT,
  updated_at     TEXT,
  PRIMARY KEY (target_source, target_key, season, episode)
);

-- ── lists ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lists (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  is_public   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lists_owner ON lists (owner_id, is_public);

CREATE TABLE IF NOT EXISTS list_items (
  list_id       TEXT NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  target_source TEXT NOT NULL,
  target_key    TEXT NOT NULL,
  title         TEXT,
  PRIMARY KEY (list_id, position)
);

-- ── notifications ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id           TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  actor_id     TEXT REFERENCES profiles (id) ON DELETE SET NULL,
  kind         TEXT NOT NULL,
  subject_type TEXT,
  subject_id   TEXT,
  read_at      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_inbox
  ON notifications (recipient_id, created_at DESC);

-- ── moderation ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reports (
  id            TEXT PRIMARY KEY,
  reporter_id   TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','actioned','dismissed')),
  created_at    TEXT NOT NULL,
  first_seen_at TEXT,   -- the 24-hour clock Apple guideline 1.2 cares about
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_queue ON reports (status, created_at);

-- Append-only. Rows are never updated or deleted.
CREATE TABLE IF NOT EXISTS moderation_actions (
  id           TEXT PRIMARY KEY,
  report_id    TEXT REFERENCES reports (id) ON DELETE SET NULL,
  moderator_id TEXT NOT NULL REFERENCES profiles (id),
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL
);

-- ── maintenance ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS counter_repair (
  table_name     TEXT PRIMARY KEY,
  last_run_at    TEXT,
  rows_checked   INTEGER,
  rows_corrected INTEGER
);
