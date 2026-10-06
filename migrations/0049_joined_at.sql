-- WHO JOINED THE COMMUNITY. Joining was a flag on the phone only, so the server
-- treated an account made for backup and sync exactly like a member: it came up
-- in user search with an empty public profile, and the dashboard could not say
-- "account only" (6 Oct). NULL = an account only.
ALTER TABLE profiles ADD COLUMN joined_at TEXT;

-- Everyone already here who has done anything only a member can do: published
-- a library, written, rated, voted, followed, made a list, or claimed a handle.
UPDATE profiles SET joined_at = created_at
 WHERE joined_at IS NULL AND (
       EXISTS (SELECT 1 FROM profile_stats s WHERE s.profile_id = profiles.id)
    OR EXISTS (SELECT 1 FROM comments c WHERE c.author_id = profiles.id)
    OR EXISTS (SELECT 1 FROM ratings r WHERE r.author_id = profiles.id)
    OR EXISTS (SELECT 1 FROM emotion_votes e WHERE e.author_id = profiles.id)
    OR EXISTS (SELECT 1 FROM character_votes v WHERE v.voter_id = profiles.id)
    OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = profiles.id OR f.followee_id = profiles.id)
    OR EXISTS (SELECT 1 FROM lists l WHERE l.owner_id = profiles.id)
    OR handle NOT LIKE 'user\_p\_%' ESCAPE '\'
 );
