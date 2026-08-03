-- Signing in with an email address and a password.
--
-- WHY A SEPARATE TABLE. `identities` says which external account owns a
-- profile, and every row in it is a claim some other party has already
-- verified — Apple and Google do the checking, and we store the result. An
-- email identity is different in kind: WE are the verifier, and that means
-- holding a password hash, a verification token and a reset token. None of
-- that belongs in a table whose other rows are answers from somebody else.
--
-- The identity row still exists (`provider = 'email'`, `external_id` = the
-- lowercased address) so that everything downstream — account deletion,
-- `resolveProfile`, the "one profile, many sign-ins" shape — keeps working
-- without knowing this table is here.
--
-- WHAT IS STORED, AND WHAT IS NOT. `password_hash` is PBKDF2-SHA256 with a
-- per-row salt, written as `pbkdf2$<iterations>$<salt>$<hash>` so the cost can
-- be raised later without invalidating anybody: the parameters travel with the
-- hash. The password itself is never stored, never logged, and never returned.
--
-- Tokens are stored HASHED for the same reason a password is. A verification
-- link or a reset code sits in somebody's inbox and in our database; if the
-- database leaks, the plain tokens would be live keys to every account that
-- has an unexpired one.
CREATE TABLE IF NOT EXISTS email_credentials (
  profile_id      TEXT PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,

  -- As typed, for display and for the To: line.
  email           TEXT NOT NULL,
  -- Lowercased and trimmed. UNIQUE here is what stops two accounts on one
  -- address, and it is a database constraint rather than a check in a route
  -- because two concurrent registrations would both pass the check.
  email_lower     TEXT NOT NULL UNIQUE,

  password_hash   TEXT NOT NULL,

  -- NULL until they click the link. An unverified account can still sign in —
  -- locking somebody out of an account they just made because an email was
  -- slow is worse than the thing it prevents — but it cannot post, which is
  -- enforced in the routes, not here.
  verified_at     TEXT,

  verify_hash     TEXT,
  verify_expires  TEXT,
  reset_hash      TEXT,
  reset_expires   TEXT,

  -- Rate limiting a guessing attack against ONE account, which an IP limit
  -- does not cover: a botnet spread over a thousand addresses stays under
  -- every per-IP window while hammering a single inbox.
  failed_count    INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_credentials_verify ON email_credentials (verify_hash);
CREATE INDEX IF NOT EXISTS idx_email_credentials_reset ON email_credentials (reset_hash);
