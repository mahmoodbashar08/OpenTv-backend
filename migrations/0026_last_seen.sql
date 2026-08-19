-- When a community member last opened the app.
--
-- ONLY MEMBERS, AND THAT IS A LIMIT NOT AN OVERSIGHT. Counting everybody who
-- opens OpenTV would mean every phone contacting this server on launch, and
-- somebody who declined the community never contacts it at all. The people
-- missing from this number are exactly the people the design promises not to
-- touch, so the number is named for what it is: active MEMBERS.
--
-- Written at most once a day per person, on a request the app was already
-- making. No new call, and one row per member per day at the very most.
ALTER TABLE profiles ADD COLUMN last_seen_at TEXT;
CREATE INDEX IF NOT EXISTS idx_profiles_last_seen ON profiles (last_seen_at);
