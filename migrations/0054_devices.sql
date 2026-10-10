-- The devices that sync with one account (10 Oct 2026).
--
-- Sync had no registry: a device was a random id on each op, so there was no
-- list to look at, no way to drop a lost phone, and nothing stopping one Plus
-- being shared around a group chat. This is the list. It holds what a phone
-- says about itself and nothing about what is watched on it — the README's
-- promise is unchanged, and dropping this table whole would cost nobody a row
-- of their library.
--
-- `device` is the same random id the phone already sends with every sync op
-- and every backup; `name` is what the phone calls itself ("Mahmood's iPhone",
-- or just the model where iOS 16+ withholds the name), kept so two iPhones
-- can be told apart on the screen that lists them.
--
-- `removed_at` is a TOMBSTONE, not a delete: a removed phone that comes back
-- must be told "you were removed" (403 device_removed), which is a different
-- answer from "there is no room" — and a row that was simply gone could not
-- tell the two apart. A removed row does not count against the cap.
--
-- `last_seen` is written at most once a day per device (see routes/sync.ts),
-- because D1 writes are the budget and a phone polls every minute.
CREATE TABLE IF NOT EXISTS devices (
  profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  device     TEXT NOT NULL,
  name       TEXT,
  platform   TEXT,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY (profile_id, device)
);
