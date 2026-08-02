/**
 * Where to reach a person's phones.
 *
 * Registration only — the sending lives in `push.ts` and is called by the
 * handlers that already write the notification row.
 *
 * A DEVICE, NOT A PERSON. The token is the key, so the same install
 * re-registering updates its row instead of adding one, and a phone plus a
 * tablet are two rows for one profile. Signing out on one device removes that
 * one and leaves the other alone — the alternative silences a device the user
 * still holds.
 */
import { Hono } from 'hono';

import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';

export const push = new Hono<App>();

/** Expo's tokens look like `ExponentPushToken[xxxxxxxx]`. Checked so a typo or a
 *  raw APNs token is refused here rather than failing silently at send time. */
const TOKEN = /^ExponentPushToken\[[A-Za-z0-9_-]+\]$/;

// ── POST /v1/push/tokens ────────────────────────────────────────────────────

push.post('/push/tokens', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }

  const b = (body ?? {}) as { token?: unknown; platform?: unknown };
  const token = typeof b.token === 'string' ? b.token.trim() : '';
  const platform = b.platform === 'ios' || b.platform === 'android' ? b.platform : null;

  if (!TOKEN.test(token)) return fail(c, 400, 'invalid_body', 'token must be an Expo push token.');
  if (platform === null) return fail(c, 400, 'invalid_body', "platform must be 'ios' or 'android'.");

  const me = c.get('profileId');
  const nowIso = new Date().toISOString();

  // ON CONFLICT on the token: a phone that changed hands, or a user who signed
  // out and in as somebody else, must not leave the previous profile receiving
  // pushes on a device that is no longer theirs. `disabled_at` is cleared too —
  // a token that comes back is alive again by definition.
  await c.env.DB.prepare(
    `INSERT INTO push_tokens (token, profile_id, platform, created_at, last_seen_at, disabled_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(token) DO UPDATE SET
       profile_id   = excluded.profile_id,
       platform     = excluded.platform,
       last_seen_at = excluded.last_seen_at,
       disabled_at  = NULL`,
  )
    .bind(token, me, platform, nowIso, nowIso)
    .run();

  return c.json({ registered: true });
});

// ── DELETE /v1/push/tokens/:token ───────────────────────────────────────────

push.delete('/push/tokens/:token', requireAuth, async (c) => {
  // Scoped to the caller: a token is a device address, and being able to delete
  // somebody else's by guessing it would be a way to silence them.
  await c.env.DB.prepare('DELETE FROM push_tokens WHERE token = ? AND profile_id = ?')
    .bind(c.req.param('token'), c.get('profileId'))
    .run();
  return c.json({ deleted: true });
});
