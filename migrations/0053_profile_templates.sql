-- PROFILE TEMPLATES FROM THE SERVER (2.0.0, asked 9 Oct). The twelve built in
-- to the app stay there — they work offline and without an account, which is
-- the rule. These are the ones the dashboard makes on top of them: a banner
-- (in COMMENT_IMAGES under templates/), two colours, a layout, the blocks and
-- a persona, so a Ramadan or New Year template ships on the day with no app
-- update. They ride GET /v1/links, the one read every member's phone already
-- makes; `event` ties a row to the seasonal switch (EVENT_KEY) so it is sent
-- only while that event is on, and NULL means always. Nothing here is about a
-- person: a template is the owner's artwork and a shape, never a library.
CREATE TABLE IF NOT EXISTS profile_templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  layout     TEXT NOT NULL,            -- classic | cards | poster
  colours    TEXT NOT NULL,            -- JSON ["#primary", "#secondary"]
  blocks     TEXT NOT NULL,            -- JSON, in the app's own block grammar (profile-templates.ts)
  persona    TEXT NOT NULL,            -- one of the app's twelve persona ids; the phone names it in its language
  banner_key TEXT NOT NULL,            -- R2 key, templates/<id>.<ext>
  event      TEXT,                     -- NULL = always; one of EVENTS = only while it is switched on
  hidden     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
