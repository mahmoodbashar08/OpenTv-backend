-- WHAT 319947 IS CALLED.
--
-- This server holds no catalogue and is never going to: turning an id into a
-- title is the phone's job, and keeping a copy of TheTVDB here would be a
-- second database to go stale. But the admin dashboard has to PRINT something,
-- and it was printing "319947 S1E1".
--
-- Until now the only names it had were a side effect: `profile_titles` and the
-- two list tables carry one because a phone sent it while publishing a shelf
-- or adding a list row. Measured on the live database, that covers 6,325 of
-- the 8,710 titles anybody has rated. The other 2,385 are shows people rated
-- or commented on without ever shelving or listing them -- which is ordinary,
-- and for a library over 250 shows it is unavoidable, because a shelf is
-- truncated and a rating is not.
--
-- So the name rides along with the write that needs it. One row per title, not
-- per person: "319947 is Killision Course" is a fact about the catalogue.
--
-- FIRST WRITER WINS (INSERT OR IGNORE at the call site). The alternative is
-- last writer wins, which lets anybody rename a title for everybody with a
-- doctored request -- the same reasoning as the movie-uuid names in 0027.
-- Nothing here is shown to members; it labels rows in the dashboard.
CREATE TABLE IF NOT EXISTS title_names (
  target_source TEXT NOT NULL,
  target_key    TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (target_source, target_key)
);
