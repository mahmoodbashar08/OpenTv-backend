-- Sync between one person's own devices.
--
-- NOT A WATCH-HISTORY TABLE, which this server still refuses to hold. These
-- are OPAQUE, SHORT-LIVED RELAY MESSAGES: a phone says what it just did, the
-- tablet collects it and does the same, and the row is prunable the moment
-- every device has seen it. The library itself still lives on the phones; if
-- this table were dropped whole, every device would keep its complete history
-- and lose only the few minutes of changes in flight.
--
-- `seq` IS THE CURSOR and must be server-assigned: a device clock cannot order
-- two devices against each other, and a client-chosen cursor could be made to
-- skip. AUTOINCREMENT rather than plain rowid, so a pruned row's number is
-- never handed out again — reusing it would make a cursor point at the wrong
-- place and silently skip everything between.
--
-- `ts` is the DEVICE clock and is only ever used to order ops as the user made
-- them. It is not trusted for anything else.
CREATE TABLE IF NOT EXISTS sync_ops (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL,
  op_id      TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The whole idempotency story. A push that times out after the server wrote it
-- is retried by the phone with the same op ids, and must not apply twice —
-- INSERT OR IGNORE plus this index is the entire mechanism.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_ops_op ON sync_ops(profile_id, op_id);

-- Every pull is "this profile, after this cursor, in order".
CREATE INDEX IF NOT EXISTS idx_sync_ops_pull ON sync_ops(profile_id, seq);

-- Pruning reads by age across all profiles.
CREATE INDEX IF NOT EXISTS idx_sync_ops_age ON sync_ops(created_at);
