-- One private thread between each person and the developer (1.6.7).
--
-- Their own words, written to us on purpose — not library data. Deleted with
-- the account. `seen_at` is when the OTHER side read it: a person's row is
-- seen by the dashboard, a developer's row by the phone.
CREATE TABLE IF NOT EXISTS support_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL,
  from_dev   INTEGER NOT NULL DEFAULT 0,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  seen_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_support_thread ON support_messages(profile_id, id);
CREATE INDEX IF NOT EXISTS idx_support_unseen ON support_messages(from_dev, seen_at);
