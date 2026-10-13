-- The live room's door reads blocks in BOTH directions (2.0.0): who I blocked,
-- and who blocked me. The first rides the primary key; the second had no index
-- and scanned the whole table on every room entry.
CREATE INDEX IF NOT EXISTS blocks_blocked ON blocks (blocked_id);
