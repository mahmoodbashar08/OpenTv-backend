-- The profile theme: one colour, chosen by the owner, rendered by every
-- visitor. The first Plus feature somebody else can SEE besides the badge —
-- a cosmetic tier sells on exactly this.
--
-- A hex string rather than a named accent, so the server never has to know
-- the app's palette: the app can add accents without a migration here, and
-- an old server renders a new accent fine because it never interprets the
-- value, only stores and returns it. Format is validated at the PATCH.
ALTER TABLE profiles ADD COLUMN theme_color TEXT;
