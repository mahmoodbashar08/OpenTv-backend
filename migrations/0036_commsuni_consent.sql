-- The consent record the CommsUni backfill guide requires to exist before a
-- single one of a user's comments may be sent.
--
-- AN APPEND-ONLY LEDGER, not a column on `profiles`. The guide asks for a
-- "versioned decision record" and for changes of mind to stop unsent rows from
-- going out -- and a single mutable flag cannot answer the question that
-- actually gets asked later, which is "what exactly did this person agree to,
-- and when". Overwriting the row would destroy the evidence that they ever
-- agreed at all, which is the one thing a consent record is for.
--
-- PENDING IS THE ABSENCE OF A ROW, deliberately. The guide is explicit that a
-- dismissed or unanswered prompt stays `pending` and is NOT `keep_private` --
-- inactivity is not a refusal any more than it is permission. Storing a
-- 'pending' row would make "never asked" and "asked and dismissed" look like
-- decisions, and the app has to be able to ask again without treating either
-- as an answer.
CREATE TABLE IF NOT EXISTS commsuni_consent (
  id              TEXT PRIMARY KEY,
  profile_id      TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,

  -- Only the two real answers. A dismissal writes nothing at all.
  decision        TEXT NOT NULL CHECK (decision IN ('share','keep_private')),

  -- Asked only after somebody agrees to share, so null on a refusal. It is
  -- actor-wide and resolved at read time by the archive, which means changing
  -- it later also changes the name on comments already shared.
  identity        TEXT CHECK (identity IN ('profile','persona')),

  -- Which wording they read. A rewritten prompt is a different question, so a
  -- decision is only ever consent to the words that were actually on screen.
  prompt_version  INTEGER NOT NULL,

  -- "The scope must record whether the consent copy covered existing comments
  -- and replies." Without this the record cannot answer whether backfill was
  -- authorised: the guide says consent to one new comment, given without that
  -- disclosure, does not authorise sending anybody's history.
  covers_existing INTEGER NOT NULL DEFAULT 0,

  decided_at      TEXT NOT NULL
);

-- Every read is "the latest decision for this person", so the index is the
-- shape of that question.
CREATE INDEX IF NOT EXISTS idx_commsuni_consent_latest
  ON commsuni_consent (profile_id, decided_at DESC);
