-- WHY A MEMBER'S PHONE HAS NOT PUBLISHED (9 Oct 2026). Every exit in the
-- phone's publish is silent, so "imported, not sent yet" could not say which
-- one. A short code from the X-OpenTV-Publish header ('ok', 'empty', 'seed',
-- 'error:network'…), written on the same once-a-day stamp as app_version.
ALTER TABLE profiles ADD COLUMN publish_state TEXT;
