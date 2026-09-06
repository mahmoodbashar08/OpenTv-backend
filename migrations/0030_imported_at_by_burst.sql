-- 0029 stamped EVERY existing row as imported, and that was too blunt.
--
-- It was right about the population and wrong about the individuals: the bulk
-- uploads really are almost all of the volume, but a hundred person-days of
-- somebody rating two or three episodes after watching them were swept up with
-- them, and those are the only real activity this database has ever recorded.
-- Zeroing the dashboard is not more honest than over-counting it; it is the
-- same error pointing the other way.
--
-- THE DATA SEPARATES ITSELF. Ratings grouped by (person, day):
--
--     500+ per day     23 person-days     69,395 rows
--     100–499           9 person-days      2,089 rows
--     50–99             5 person-days        340 rows
--     20–49             7 person-days        233 rows
--     5–19              9 person-days         87 rows
--     1–4              96 person-days        153 rows
--
-- Two populations with a canyon between them. Nobody rates five hundred
-- episodes in an evening; nobody uploads an archive of three. Fifty is drawn
-- in the empty middle, and it is a threshold rather than a fact — a person on
-- a long marathon could in principle cross it, and being counted as an import
-- costs them nothing but a line on a dashboard nobody else sees.
--
-- FROM NOW ON NOTHING IS INFERRED: routes/import.ts stamps imported_at as it
-- writes, so this heuristic applies only to rows that predate the column.

UPDATE ratings SET imported_at = NULL;
UPDATE character_votes SET imported_at = NULL;
UPDATE emotion_votes SET imported_at = NULL;

UPDATE ratings SET imported_at = created_at
 WHERE author_id || '|' || substr(created_at, 1, 10) IN (
   SELECT author_id || '|' || substr(created_at, 1, 10)
     FROM ratings GROUP BY 1 HAVING COUNT(*) >= 50);

UPDATE character_votes SET imported_at = created_at
 WHERE voter_id || '|' || substr(created_at, 1, 10) IN (
   SELECT voter_id || '|' || substr(created_at, 1, 10)
     FROM character_votes GROUP BY 1 HAVING COUNT(*) >= 50);

UPDATE emotion_votes SET imported_at = created_at
 WHERE author_id || '|' || substr(created_at, 1, 10) IN (
   SELECT author_id || '|' || substr(created_at, 1, 10)
     FROM emotion_votes GROUP BY 1 HAVING COUNT(*) >= 50);
