-- A six-digit confirmation code, alongside the link.
--
-- WHY BOTH. The link is a deep link into the app, so it only works on the
-- device that received the email. Read the message on a phone while signing in
-- on another device — a simulator, a tablet, a second handset — and there is
-- nothing to tap: iOS hands the URL to whichever app claims the scheme, and on
-- that machine no app does. A code can be carried across the room.
--
-- WHY IT IS NOT JUST A SHORTER TOKEN. `/auth/email/verify` finds an account BY
-- the token hash, so a six-digit value used the same way would be a search over
-- every account at once — a million guesses against the whole table, not
-- against one row. The code is therefore only ever accepted together with the
-- address it was sent to, and only a handful of times.
ALTER TABLE email_credentials ADD COLUMN verify_code_hash TEXT;

-- Guesses spent against the current code. Reset when a new code is issued,
-- and once it runs out the code is dead until another is requested — the same
-- shape as `failed_count` above it, and for the same reason: an IP limit does
-- not stop a botnet spread across a thousand addresses working one inbox.
ALTER TABLE email_credentials ADD COLUMN verify_code_tries INTEGER NOT NULL DEFAULT 0;
