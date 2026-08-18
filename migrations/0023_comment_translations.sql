-- Live translation of comments, cached so each one is translated once per
-- language ever.
--
-- THE CACHE IS THE FEATURE, not an optimisation. Six languages shipped and no
-- way to read across them is the gap somebody was always going to point at, but
-- a translation per READ would bill for every scroll of a busy thread. Keyed by
-- (comment, language), a comment read a thousand times costs one call.
--
-- ON THIS SERVER AND NOT AT GOOGLE. The comment is already sitting here, so
-- translating it here sends it nowhere new — which would not be true of
-- Translate or DeepL, where every comment in the archive would leave for a
-- third party. That is the whole reason this is affordable AND allowed.
--
-- ON DELETE CASCADE: a deleted comment must not leave its words behind in
-- another language. Deletion has to mean deletion in every table that copied
-- the text, and this is the only one that does.
CREATE TABLE IF NOT EXISTS comment_translations (
  comment_id  TEXT NOT NULL,
  lang        TEXT NOT NULL,
  text        TEXT NOT NULL,
  source_lang TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (comment_id, lang),
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE
);
