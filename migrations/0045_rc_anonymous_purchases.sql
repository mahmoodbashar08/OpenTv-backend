-- A purchase RevenueCat books against an ANONYMOUS id (bought before the app
-- told it who the buyer is) used to be dropped on the floor, because there was
-- no profile to attach it to. It is kept here instead, until the phone that
-- made it signs in and names that id (POST /v1/me/plus-check).
CREATE TABLE IF NOT EXISTS rc_anon_purchases (
  rc_id      TEXT PRIMARY KEY,
  active     INTEGER NOT NULL,
  expires_at TEXT,
  claimed_by TEXT,
  updated_at TEXT NOT NULL
);

-- What the PHONE says about Plus (Apple / Google, through RevenueCat), for the
-- dashboard to flag a disagreement with the server. Display only: the server
-- never grants Plus because a phone said so.
ALTER TABLE profiles ADD COLUMN device_plus INTEGER;
ALTER TABLE profiles ADD COLUMN device_plus_at TEXT;
