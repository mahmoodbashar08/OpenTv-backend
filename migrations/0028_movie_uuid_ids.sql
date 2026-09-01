-- The ids beside the titles, and a place to count who asked.
--
-- WHY IDS MATTER MORE THAN THEY LOOK. `movie_uuids` gave a phone a TITLE, and a
-- title alone means every screen that opens the film has to SEARCH for it: the
-- detail screen draws its first guess, then corrects itself when a better match
-- lands. On a film somebody just watched appear in their list, that reads as
-- the app malfunctioning. An id is exact and settles it before anything is
-- drawn.
--
-- They are sparse in the source catalogue -- 9% carry a TMDB id, 2% a TheTVDB
-- one -- but sparse in the right places: 13 of the 14 films missing from one
-- real watch-order list had one. The films people put in lists are the popular
-- ones, and the popular ones are the ones the catalogue knows.
--
-- NULLABLE, and no UNIQUE. A film with no id is still worth naming, and two
-- TV Time uuids can legitimately point at one TMDB film (a re-release, a
-- director's cut) -- a uniqueness rule here would reject the second one and
-- leave a list entry nameless to protect a constraint nothing reads.
ALTER TABLE movie_uuids ADD COLUMN tmdb_id INTEGER;
ALTER TABLE movie_uuids ADD COLUMN tvdb_id INTEGER;

-- Counts of things that have no row of their own.
--
-- The catalogue is served as one static blob to anybody who asks, with no
-- account and no body -- which is exactly what makes it safe, and also what
-- makes it invisible. Without this the only honest answer to "is anyone using
-- the list repair?" is "no idea".
--
-- A COUNT AND A DATE, NOTHING ELSE. No ip, no user agent, no profile id, no row
-- per request. This table cannot answer "who" or "which films" because it does
-- not hold the shape of a question that could be asked that way -- and the
-- moment it did, a public unauthenticated endpoint would have become a log of
-- who is repairing what.
CREATE TABLE IF NOT EXISTS counters (
  key        TEXT PRIMARY KEY,
  n          INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
