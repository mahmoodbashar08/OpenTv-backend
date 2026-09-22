-- APPROVE THE GIF, NOT THE PERSON.
--
-- Moderating every user's picture does not scale: the work rises with the user
-- count, and somebody stares at a blank space until a human reaches them. But
-- GIPHY ids repeat heavily -- a reaction GIF is popular precisely because many
-- people pick it -- so a decision about the ASSET covers everyone who chooses
-- it afterwards. The first person to use a new GIF waits; everybody after them
-- gets it instantly, and the queue shrinks as the app grows rather than the
-- other way round.
--
-- NO NEW TABLE, deliberately. The queue already records every decision a human
-- has made, so it is already the list of approved and rejected assets; a
-- separate `asset_approvals` would be a second copy of that answer, able to
-- disagree with the first. What was missing was only the column that says
-- WHICH asset a row is a copy of.
--
-- Null for uploads that are not a known asset -- a photo from the camera roll
-- is nobody else's picture and has to be looked at on its own.
ALTER TABLE comment_images ADD COLUMN asset_id TEXT;

-- The lookup on every upload: "has a human already decided about this exact
-- GIF?" Partial, because the rows that matter are the ones with an asset.
CREATE INDEX IF NOT EXISTS idx_comment_images_asset
  ON comment_images (asset_id, scan_status)
  WHERE asset_id IS NOT NULL;
