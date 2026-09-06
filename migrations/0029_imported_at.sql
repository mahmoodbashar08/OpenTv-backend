-- An import is not activity, and until now only comments could say so.
--
-- A comment carries two dates: `created_at` is when it was WRITTEN — the
-- original TV Time date, kept by routes/import.ts — and `imported_at` is when
-- it arrived here. A rating, a character vote and a feeling carried one, and
-- it was set to the moment of upload, because TV Time's export gives a rating
-- no timestamp at all and the phone's own `episode_ratings` table has no
-- column for one (see `datedEpisodeRatings` in the app: it borrows the
-- episode's first watch date, which is a proxy, not a record).
--
-- So there is no original date to recover, and inventing one from the watch
-- date would be a guess wearing the clothes of a fact. What CAN be recorded is
-- which rows arrived in bulk, and that is enough: six members seeding their
-- archives put 8,335 of one week's 8,393 ratings on the dashboard, each in a
-- single day, and the number read as a community that had come alive.
--
-- EVERY EXISTING ROW IS STAMPED. Rows written before this migration cannot be
-- told apart — the distinction did not exist when they were made — and the
-- population is overwhelmingly imported. Counting them as activity is the
-- error that prompted this; counting them as unknown-and-therefore-imported is
-- the conservative direction, and it costs only that "rated this week" starts
-- from today rather than from a number nobody could trust.

ALTER TABLE ratings ADD COLUMN imported_at TEXT;
ALTER TABLE character_votes ADD COLUMN imported_at TEXT;
ALTER TABLE emotion_votes ADD COLUMN imported_at TEXT;

UPDATE ratings SET imported_at = created_at WHERE imported_at IS NULL;
UPDATE character_votes SET imported_at = created_at WHERE imported_at IS NULL;
UPDATE emotion_votes SET imported_at = created_at WHERE imported_at IS NULL;

-- The windows on the dashboard read `imported_at IS NULL AND created_at >= …`,
-- so the index that serves them is the pair rather than the date alone.
CREATE INDEX IF NOT EXISTS idx_ratings_activity ON ratings (imported_at, created_at);
CREATE INDEX IF NOT EXISTS idx_character_votes_activity ON character_votes (imported_at, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_activity ON comments (imported_at, created_at);
