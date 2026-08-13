-- How the owner's profile body is drawn, for everybody who opens it. A theme
-- is a colour AND a shape; publishing only the colour meant a visitor saw the
-- owner's palette in somebody else's layout.
--
-- NULL means the layout this app shipped with, so every existing profile keeps
-- rendering exactly as it does today without a backfill.
ALTER TABLE profiles ADD COLUMN theme_layout TEXT;
