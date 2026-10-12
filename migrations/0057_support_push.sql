-- WHETHER A REPLY RANG (13 Oct 2026). The dashboard showed the push result
-- once, in a popup, and then it was gone. Kept on the row so the chat can draw
-- WhatsApp-style ticks: 'delivered' (a phone accepted it), 'sent' (Expo took
-- it, no receipt yet), 'nophone' (no device allows notifications), or
-- 'failed:<code>'. Read is `seen_at`, which the app already stamps.
-- 0055/0056 are reserved for the 2.0.0 feed and together work.
ALTER TABLE support_messages ADD COLUMN push TEXT;
