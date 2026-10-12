-- WHEN THE STORE SUBSCRIPTION ENDS (13 Oct 2026). Copied from RevenueCat — the
-- webhook's `expiration_at_ms` and the daily check's `expires_date` — so a
-- thank-you month can be given as `plus_until = plus_expires_at + 1 month`
-- and start the day the paid one stops. Informational: Plus is still
-- `is_plus OR plus_until > now`; this never grants anything.
ALTER TABLE profiles ADD COLUMN plus_expires_at TEXT;
