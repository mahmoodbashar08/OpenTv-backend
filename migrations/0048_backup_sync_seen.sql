-- When this account last backed up to OpenTV (and how big it was), and when its
-- phone last pushed a sync change: the dashboard's Backup / Sync column. Times
-- and a size only — nothing about what is in them.
ALTER TABLE profiles ADD COLUMN backup_at TEXT;
ALTER TABLE profiles ADD COLUMN backup_bytes INTEGER;
ALTER TABLE profiles ADD COLUMN sync_at TEXT;
UPDATE profiles SET sync_at = (
  SELECT replace(MAX(created_at), ' ', 'T') || '.000Z' FROM sync_ops WHERE sync_ops.profile_id = profiles.id
);
