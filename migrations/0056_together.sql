-- WATCHING TOGETHER (2.0.0, design §2). A together is a shared list of exactly
-- one show, and the only new fact it holds is how far each member has got.
--
-- `kind` is what the screens and the Plus gate branch on; every other column
-- and rule — invite code, membership, visitor reads, leave and delete — is
-- inherited from 0025 rather than rebuilt.
ALTER TABLE shared_lists ADD COLUMN kind TEXT NOT NULL DEFAULT 'list'
  CHECK (kind IN ('list', 'together'));

-- Where each member is in the show: the furthest episode they have marked
-- watched (D10). The SAME shape as shared_list_watched — a tick says "I have
-- seen this title", a position says how far.
--
-- A CURSOR, NOT A HISTORY. One row per member per item, overwritten on every
-- change, gone with the item, the list's owner delete, the member's leaving or
-- the account. No date per episode and no list of episodes, ever (§0): this
-- server holds nobody's watch history, and one (season, episode) pair shared
-- with people you invited is the most it may learn.
CREATE TABLE IF NOT EXISTS shared_list_positions (
  item_id    TEXT NOT NULL REFERENCES shared_list_items (id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  season     INTEGER NOT NULL,
  episode    INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (item_id, member_id)
);
