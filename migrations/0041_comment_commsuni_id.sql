-- Where a comment of ours lives on CommsUni once it is shared, so a thread can
-- tell OpenTV-only comments from shared ones and a delete can follow it there.
ALTER TABLE comments ADD COLUMN commsuni_id TEXT;
