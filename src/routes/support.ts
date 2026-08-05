/**
 * Support bundles — a user's preserved TV Time import, sent to the developer
 * to reproduce a bug they reported.
 *
 * WHY THIS EXISTS AT ALL, given the app's whole promise is that a user's own
 * data stays on their phone: reproducing an import bug needs the exact file
 * that went in, and asking a busy tester to zip-and-DM it costs days. This
 * makes that one action instead — but it is NOT a back door. Two properties
 * are load-bearing and enforced here and in the app:
 *
 *   1. NOTIFIED. The developer can *request* a bundle, but only the phone can
 *      send one, and the app shows a banner while it does. The request sets a
 *      flag; it does not pull anything.
 *   2. REFUSABLE. The banner carries a Cancel that aborts the upload and calls
 *      `decline` — the flag clears and nothing is stored. A request the user
 *      says no to leaves no trace.
 *
 * So this route can no more take a bundle without the user seeing it than the
 * avatar route can: the transfer is the phone's to make. What the developer
 * controls is only whether to ask.
 *
 * STORAGE. Reuses the AVATARS bucket under a `support/` prefix. The public
 * object route matches `avatars|covers` only, so a bundle is never web-served
 * — it leaves only through the admin download below, behind ADMIN_SECRET.
 */
import { Hono, type Context } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';

export const support = new Hono<App>();

/** A tester's export is CSVs — a megabyte or two, occasionally more. */
const MAX_BUNDLE_BYTES = 30_000_000;
/** A pending request expires; a bug goes stale and nobody wants a nag forever. */
const REQUEST_TTL_SECONDS = 30 * 24 * 60 * 60;

const reqKey = (profileId: string) => `support:req:${profileId}`;
const bundlePrefix = (profileId: string) => `support/${profileId}/`;

/** Length-safe constant-time compare, so ADMIN_SECRET can't be timed out. */
function secretMatches(given: string | undefined, expected: string): boolean {
  if (!given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * Gate for `/admin/*`. Absent secret = the whole surface is off (404, the same
 * answer as a route that does not exist — an admin API you can't see you can't
 * probe). Present-but-wrong = 404 too, never 401: a 401 confirms the endpoint
 * is real.
 */
function admin(c: Context<App>): boolean {
  const expected = c.env.ADMIN_SECRET;
  if (!expected) return false;
  return secretMatches(c.req.header('X-Admin-Secret'), expected);
}

async function idForHandle(c: Context<App>, handle: string): Promise<string | null> {
  const row = await c.env.DB.prepare('SELECT id FROM profiles WHERE handle = ? AND deleted_at IS NULL')
    .bind(handle)
    .first<{ id: string }>();
  return row?.id ?? null;
}

// ---- developer side, behind ADMIN_SECRET ------------------------------------

/** Ask a user's phone to send its import bundle next time the app is open. */
support.post('/admin/support/request', async (c) => {
  if (!admin(c)) return fail(c, 404, 'not_found', 'No such route.');
  let body: { handle?: string };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const handle = (body.handle ?? '').trim();
  if (!handle) return fail(c, 400, 'invalid_body', 'A handle is required.');

  const id = await idForHandle(c, handle);
  if (!id) return fail(c, 404, 'not_found', 'No such user.');

  await c.env.CACHE.put(reqKey(id), new Date().toISOString(), { expirationTtl: REQUEST_TTL_SECONDS });
  return c.json({ requested: true, handle });
});

/** Pull the newest bundle a user has sent. */
support.get('/admin/support/bundle/:handle', async (c) => {
  if (!admin(c)) return fail(c, 404, 'not_found', 'No such route.');
  const bucket = c.env.AVATARS;
  if (!bucket) return fail(c, 503, 'unavailable', 'Storage is not configured.');

  const id = await idForHandle(c, c.req.param('handle'));
  if (!id) return fail(c, 404, 'not_found', 'No such user.');

  const listed = await bucket.list({ prefix: bundlePrefix(id) });
  if (listed.objects.length === 0) return fail(c, 404, 'not_found', 'No bundle for that user.');
  // keys end in `<epoch>.zip`; newest wins
  const newest = listed.objects.reduce((a, b) => (a.key > b.key ? a : b));
  const obj = await bucket.get(newest.key);
  if (!obj) return fail(c, 404, 'not_found', 'No bundle for that user.');

  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${c.req.param('handle')}.zip"`,
    },
  });
});

// ---- user side: the phone's to give, and to take back -----------------------

/** Is the developer waiting on a bundle from me? Drives the banner. */
support.get('/me/support/pending', requireAuth, async (c) => {
  const requestedAt = await c.env.CACHE.get(reqKey(c.get('profileId')));
  return c.json({ pending: requestedAt != null, requested_at: requestedAt });
});

/** The phone sending its preserved import. Clears the request on success. */
support.post('/me/support/bundle', requireAuth, async (c) => {
  const bucket = c.env.AVATARS;
  if (!bucket) return fail(c, 503, 'unavailable', 'Storage is not configured.');

  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength <= 0) return fail(c, 400, 'invalid_body', 'The bundle is empty.');
  if (bytes.byteLength > MAX_BUNDLE_BYTES) {
    return fail(c, 413, 'too_large', `A bundle is at most ${Math.floor(MAX_BUNDLE_BYTES / 1_000_000)} MB.`);
  }

  const me = c.get('profileId');
  await bucket.put(`${bundlePrefix(me)}${Date.now()}.zip`, bytes, {
    httpMetadata: { contentType: 'application/zip' },
  });
  await c.env.CACHE.delete(reqKey(me));
  return c.json({ received: true });
});

/** Cancel: the user said no. Clear the flag so the banner does not return. */
support.post('/me/support/decline', requireAuth, async (c) => {
  await c.env.CACHE.delete(reqKey(c.get('profileId')));
  return c.json({ declined: true });
});
