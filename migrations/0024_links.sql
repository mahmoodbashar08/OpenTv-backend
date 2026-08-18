-- Where to find us: Discord, Reddit, Instagram, TikTok, X.
--
-- THE POINT IS NOT THE ROWS, IT IS THAT A LINK IN A SHIPPED BUILD CANNOT BE
-- FIXED. A Discord invite expires after seven days by default, so an invite
-- compiled into an app is dead in every copy already on a phone, and the only
-- cure is a store release that takes days to reach anybody.
--
-- KEYED, NOT POSITIONAL, so the app can choose an icon per service and a
-- deleted row simply disappears instead of shifting the rest.
--
-- THE APP SHIPS DEFAULTS AND THIS ONLY OVERRIDES THEM. Somebody who declined
-- the community never contacts this server at all — that is the rule the whole
-- design rests on — so the list is refreshed only when the app is ALREADY
-- talking to us. A decliner keeps the bundled list and reaches nothing.
CREATE TABLE IF NOT EXISTS links (
  key      TEXT PRIMARY KEY,
  label    TEXT NOT NULL,
  url      TEXT NOT NULL,
  sort     INTEGER NOT NULL DEFAULT 0,
  enabled  INTEGER NOT NULL DEFAULT 1
);
