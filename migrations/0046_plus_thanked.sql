-- When the thank-you email for a first subscription went out. Set once; the
-- email is never sent twice to the same profile.
ALTER TABLE profiles ADD COLUMN plus_thanked_at TEXT;
