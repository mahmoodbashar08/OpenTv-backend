-- ── shared lists ────────────────────────────────────────────────────────────
--
-- THE FIRST THING ON THIS SERVER THAT THE SERVER ACTUALLY OWNS.
--
-- Every other table here mirrors something the phone already holds: published
-- shelves, published lists, comments seeded from a local database. The rule has
-- always been that the phone is the source of truth and the server keeps a copy
-- for other people to look at.
--
-- A shared list cannot work that way. Two people write to it, from two phones,
-- and neither copy can be authoritative without silently overwriting the other.
-- So this one lives here, and the phones read it.
--
-- That does not break the rule, it stays inside it: the rule is about A USER'S
-- OWN LIBRARY. What somebody watched, and when, is still theirs alone and still
-- never leaves their device. A list two friends build together was never one
-- person's private history to begin with.
--
-- WHAT IS DELIBERATELY NOT HERE:
--   * no watch history. `watched_at` below records that a MEMBER ticked an item
--     off THIS list -- one row, in one list, that they chose to share with the
--     people in it. It is not a watch record and nothing else reads it.
--   * no copy of anybody's library. Items are added one at a time, by hand.

CREATE TABLE IF NOT EXISTS shared_lists (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- The invite. A short code rather than a member's handle, so a link can be
  -- passed to somebody who has not joined yet -- which is the whole point of
  -- letting non-payers in. Rotatable: changing it kills every old link at once,
  -- which is the only defence a list has once a link has left the group.
  invite_code TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_shared_lists_owner ON shared_lists (owner_id);

-- Membership. The owner is a member too -- a row here, like everyone else --
-- so every query about "who is in this list" is one question, not two.
CREATE TABLE IF NOT EXISTS shared_list_members (
  list_id   TEXT NOT NULL REFERENCES shared_lists (id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  -- 'owner' may rename and delete the list and remove anybody; 'member' may add
  -- items, remove ITS OWN items, tick things off, and leave.
  role      TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL,
  PRIMARY KEY (list_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_shared_members_person ON shared_list_members (member_id);

CREATE TABLE IF NOT EXISTS shared_list_items (
  id            TEXT PRIMARY KEY,
  list_id       TEXT NOT NULL REFERENCES shared_lists (id) ON DELETE CASCADE,
  -- WHO ADDED IT, and it is not decoration. "Sarah added three things" is the
  -- reason somebody opens the app on a Tuesday, and without this column the
  -- list is a bag of titles that nobody feels responsible for.
  added_by      TEXT REFERENCES profiles (id) ON DELETE SET NULL,
  -- Same identity pair the published lists use: 'tvdb' + a numeric id for a
  -- show, 'movie' + a name for a film. Matching them means the app can reuse
  -- the code that already opens both.
  target_source TEXT NOT NULL,
  target_key    TEXT NOT NULL,
  title         TEXT,
  poster        TEXT,
  created_at    TEXT NOT NULL,
  -- One title cannot be in one list twice, whoever adds it second.
  UNIQUE (list_id, target_source, target_key)
);
CREATE INDEX IF NOT EXISTS idx_shared_items_list ON shared_list_items (list_id, created_at DESC);

-- Ticking something off, per person. A list of five where you have seen two and
-- your friend has seen four is the state that makes the list a conversation
-- instead of a bookmark folder.
CREATE TABLE IF NOT EXISTS shared_list_watched (
  item_id    TEXT NOT NULL REFERENCES shared_list_items (id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  watched_at TEXT NOT NULL,
  PRIMARY KEY (item_id, member_id)
);
