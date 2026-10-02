-- Which part of the banner shows, and whether a GIF banner is tall (Plus):
-- "x,y,zoom,tall", validated by `validateCoverFrame`. Null = centred, normal.
ALTER TABLE profiles ADD COLUMN cover_frame TEXT;
