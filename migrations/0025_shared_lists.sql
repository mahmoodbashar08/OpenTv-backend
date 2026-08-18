-- Lists two people build together.
--
-- THE FIRST TABLE THIS SERVER TRULY OWNS. Every other one mirrors something a
-- phone already holds: delete the lot and every user still has their complete
-- library and loses only other people's comments and ratings. Not this one.
-- Two people write to one list from two devices, so neither copy can be
-- authoritative without silently eating the other's edits.
--
-- That stays INSIDE the rule rather than breaking it. The rule is about a
-- user's own library — a list two friends build together was never one
-- person's private history, and no screen showing somebody's own shows, films
-- or watch history gains a dependency on any of this.
CREATE TABLE IF NOT EXISTS shared_lists (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- The invite. Rotatable, because a code that has been forwarded is a code
  -- that cannot be taken back any other way.
  invite_code TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  deleted_at  TEXT
);

-- Who is in it. The owner is a member too, with role 'owner', so membership is
-- one question with one answer rather than "a member, or the owner?" asked at
-- every read.
CREATE TABLE IF NOT EXISTS shared_list_members (
  list_id   TEXT NOT NULL REFERENCES shared_lists (id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (list_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_shared_members_member ON shared_list_members (member_id);

-- What is on it. `added_by` is the whole point rather than provenance: a bag of
-- titles nobody is attached to is a bookmark folder, and "Sara added this" is
-- why somebody opens the app on a Tuesday.
--
-- ON DELETE SET NULL, not CASCADE: a member who leaves or deletes their account
-- must not take everybody's list with them. The row stays and simply stops
-- naming anyone.
CREATE TABLE IF NOT EXISTS shared_list_items (
  id            TEXT PRIMARY KEY,
  list_id       TEXT NOT NULL REFERENCES shared_lists (id) ON DELETE CASCADE,
  added_by      TEXT REFERENCES profiles (id) ON DELETE SET NULL,
  target_source TEXT NOT NULL CHECK (target_source IN ('tvdb', 'tmdb', 'title', 'movie')),
  target_key    TEXT NOT NULL,
  -- Sent by the phone that added it: the server has no catalogue and cannot
  -- resolve an id to a name or a picture. Same reason list rows carry a poster.
  title         TEXT,
  poster        TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (list_id, target_source, target_key)
);
CREATE INDEX IF NOT EXISTS idx_shared_items_list ON shared_list_items (list_id, created_at);

-- Ticking something off. PER MEMBER, not per item: "we have both seen this" and
-- "one of us has" are different facts, and the second is the one that decides
-- what to watch tonight.
CREATE TABLE IF NOT EXISTS shared_list_watched (
  item_id   TEXT NOT NULL REFERENCES shared_list_items (id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (item_id, member_id)
);
