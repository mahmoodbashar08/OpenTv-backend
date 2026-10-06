import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';

/**
 * "Message the developer" — one private thread per person (1.6.7).
 *
 * Before this, nobody could reach the developer from inside the app: the
 * dashboard's Message was one-way, and the only other doors were Discord and
 * Reddit. A library that lost 1,106 episodes in a day (6 Oct) could not even
 * be asked about. The developer answers from the dashboard
 * (`/admin/support/*`), and the answer arrives as a push that opens /support.
 */
export const supportChat = new Hono<App>();

export const SUPPORT_MAX_CHARS = 2000;
/** Per person per day: plenty for a conversation, nothing for a flood. */
export const SUPPORT_PER_DAY = 30;

export type SupportRow = { id: number; from_dev: number; body: string; created_at: string };
export const supportOut = (r: SupportRow) => ({ id: r.id, fromDev: r.from_dev === 1, body: r.body, at: r.created_at });

/** The thread, oldest first. Reading it marks the developer's replies seen. */
supportChat.get('/support', requireAuth, async (c) => {
  const me = c.get('profileId');
  const rows = await c.env.DB.prepare(
    'SELECT id, from_dev, body, created_at FROM (SELECT * FROM support_messages WHERE profile_id = ? ORDER BY id DESC LIMIT 200) ORDER BY id',
  )
    .bind(me)
    .all<SupportRow>();
  await c.env.DB.prepare('UPDATE support_messages SET seen_at = ? WHERE profile_id = ? AND from_dev = 1 AND seen_at IS NULL')
    .bind(new Date().toISOString(), me)
    .run();
  return c.json({ messages: rows.results.map(supportOut) }, 200, { 'Cache-Control': 'no-store' });
});

supportChat.post('/support', requireAuth, async (c) => {
  const me = c.get('profileId');
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const body = typeof (raw as { body?: unknown })?.body === 'string' ? (raw as { body: string }).body.trim() : '';
  if (body.length < 1 || body.length > SUPPORT_MAX_CHARS) return fail(c, 400, 'invalid_body', `body must be 1–${SUPPORT_MAX_CHARS} characters.`);
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const today = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE profile_id = ? AND from_dev = 0 AND created_at > ?')
    .bind(me, since)
    .first<{ n: number }>();
  if ((today?.n ?? 0) >= SUPPORT_PER_DAY) return fail(c, 429, 'rate_limited', 'Too many messages today.');
  const at = new Date().toISOString();
  const res = await c.env.DB.prepare('INSERT INTO support_messages (profile_id, from_dev, body, created_at) VALUES (?, 0, ?, ?)')
    .bind(me, body, at)
    .run();
  return c.json({ message: { id: Number(res.meta.last_row_id), fromDev: false, body, at } }, 201);
});
