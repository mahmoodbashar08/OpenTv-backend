-- Push delivery. The notification ROWS already exist and are written by the
-- handler that causes them; this is only the address to deliver them to.
--
-- ONE ROW PER DEVICE, not per person: a phone and a tablet are two tokens for
-- one profile, and signing out on one must not silence the other. The token is
-- the primary key because Expo's token identifies the install, and the same
-- install re-registering must update rather than accumulate.
--
-- `disabled_at` rather than DELETE on failure: a token Expo reports as
-- DeviceNotRegistered is dead, but knowing it was there is worth more than the
-- row it costs, and a reinstall re-registers the same token.
CREATE TABLE IF NOT EXISTS push_tokens (
  token        TEXT PRIMARY KEY,
  profile_id   TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  platform     TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  disabled_at  TEXT
);

-- The send path's only query: every live token for one recipient.
CREATE INDEX IF NOT EXISTS idx_push_tokens_profile
  ON push_tokens (profile_id) WHERE disabled_at IS NULL;
