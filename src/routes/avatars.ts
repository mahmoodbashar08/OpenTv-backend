import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import { imageExtension, MAX_AVATAR_BYTES } from '@/pure';

/**
 * Profile pictures.
 *
 * WHY THIS IS DIFFERENT FROM A COVER. A cover is a URL to a catalogue backdrop
 * and needs no storage at all (see migration 0012). An avatar comes out of the
 * user's camera roll — it is a genuine upload of a genuinely arbitrary image,
 * and it is SERVED to everybody who looks at that person's profile, a comment
 * they wrote, or a follower list.
 *
 * ⚠️ SERVED WITHOUT SCANNING. `comment_images` deliberately has no read route
 * for exactly this reason: publishing user-uploaded pictures means owning what
 * is in them. This route does publish them, because a profile picture nobody
 * can see is not a profile picture. That makes avatars part of the same launch
 * blocker as comment images — scanning has to be wired up before this is in
 * front of the public, and the moderator's tools need a way to clear one.
 * `moderation_actions` already has the shape for it.
 *
 * WHAT LIMITS THE DAMAGE MEANWHILE:
 *  - one object per profile, overwritten in place, so a user cannot fill a
 *    bucket by uploading repeatedly,
 *  - 2 MB and an image allow-list,
 *  - the key is derived from the profile id and a timestamp, so nothing is
 *    guessable and a replaced avatar's URL stops resolving,
 *  - `POST /v1/reports` already covers a profile, and a moderator clearing an
 *    avatar is one UPDATE.
 *
 * THE COLUMN HOLDS A FULL URL. `avatar_key` is named for a bare R2 key, and
 * every reader — six routes, plus `avatarUri()` on the phone, which requires an
 * absolute address — already treats it as something to render. Storing the URL
 * keeps that one definition rather than adding a second, and if the images ever
 * move to a CDN, only this file changes.
 */

export const avatars = new Hono<App>();

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

// ── POST /v1/me/avatar ──────────────────────────────────────────────────────

avatars.post('/me/avatar', requireAuth, async (c) => {
  const bucket = c.env.AVATARS;
  if (!bucket) return fail(c, 503, 'unavailable', 'Avatar storage is not configured.');

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be multipart/form-data.');
  }

  const file = form.get('image');
  if (!(file instanceof File)) return fail(c, 400, 'invalid_body', 'An image file is required.');
  if (!ALLOWED.has(file.type)) {
    return fail(c, 415, 'unsupported_type', `Type ${file.type || 'unknown'} is not an image.`);
  }
  if (file.size <= 0) return fail(c, 400, 'invalid_body', 'The image is empty.');
  if (file.size > MAX_AVATAR_BYTES) {
    return fail(c, 413, 'too_large', `An avatar is at most ${Math.floor(MAX_AVATAR_BYTES / 1_000_000)} MB.`);
  }

  const me = c.get('profileId');
  // Timestamped so a replacement gets a NEW address: `expo-image` and every
  // HTTP cache in between key on the URL, and a stable one would leave the old
  // face on other people's screens for as long as it stayed cached.
  const key = `avatars/${me}-${Date.now()}.${imageExtension(file.type)}`;

  const previous = await c.env.DB.prepare('SELECT avatar_key FROM profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(me)
    .first<{ avatar_key: string | null }>();
  if (!previous) return fail(c, 401, 'unauthenticated', 'No such profile.');

  await bucket.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });

  const url = new URL(c.req.url);
  const publicUrl = `${url.origin}/v1/${key}`;
  await c.env.DB.prepare('UPDATE profiles SET avatar_key = ? WHERE id = ?').bind(publicUrl, me).run();

  // The old object, best-effort and AFTER the row points at the new one: an
  // orphan costs a few kilobytes, whereas deleting first and then failing the
  // update leaves a profile pointing at nothing.
  const old = objectKeyOf(previous.avatar_key);
  if (old && old !== key) {
    try {
      await bucket.delete(old);
    } catch {
      // Swept later; never worth failing an upload that already succeeded.
    }
  }

  return c.json({ ok: true, avatar_key: publicUrl });
});

// ── DELETE /v1/me/avatar ────────────────────────────────────────────────────

avatars.delete('/me/avatar', requireAuth, async (c) => {
  const me = c.get('profileId');
  const row = await c.env.DB.prepare('SELECT avatar_key FROM profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(me)
    .first<{ avatar_key: string | null }>();
  if (!row) return fail(c, 401, 'unauthenticated', 'No such profile.');

  await c.env.DB.prepare('UPDATE profiles SET avatar_key = NULL WHERE id = ?').bind(me).run();
  const key = objectKeyOf(row.avatar_key);
  if (key && c.env.AVATARS) {
    try {
      await c.env.AVATARS.delete(key);
    } catch {
      /* orphan, swept later */
    }
  }
  return c.body(null, 204);
});

// ── GET /v1/avatars/:name ───────────────────────────────────────────────────

/**
 * Serve one. Public and unauthenticated on purpose: this address ends up inside
 * an `<Image src>` on every screen that draws a person, and an image request
 * carries no session.
 *
 * Immutable caching is safe BECAUSE the key is timestamped — the bytes at a
 * given address never change, so the only way to see a new face is a new URL,
 * which is exactly what an upload produces.
 */
avatars.get('/avatars/:name', async (c) => {
  const bucket = c.env.AVATARS;
  if (!bucket) return fail(c, 503, 'unavailable', 'Avatar storage is not configured.');

  const name = c.req.param('name');
  // No slashes, no traversal — the route already prevents it, but the key is
  // rebuilt here rather than taken from the path so it cannot be anything else.
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return fail(c, 404, 'not_found', 'No such image.');

  const obj = await bucket.get(`avatars/${name}`);
  if (!obj) return fail(c, 404, 'not_found', 'No such image.');

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(obj.size),
    },
  });
});

/** The R2 key inside a stored avatar URL, or null if the column holds something else. */
function objectKeyOf(stored: string | null): string | null {
  if (!stored) return null;
  const m = /\/v1\/(avatars\/[A-Za-z0-9_.-]+)$/.exec(stored);
  return m?.[1] ?? null;
}
