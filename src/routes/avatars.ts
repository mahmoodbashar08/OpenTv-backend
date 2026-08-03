import { Hono, type Context } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import { imageExtension, MAX_AVATAR_BYTES, MAX_COVER_BYTES } from '@/pure';

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

/**
 * One upload, for the two things a profile can carry a picture of.
 *
 * `column` is the profile column that ends up holding the served URL, and
 * `folder` is the R2 prefix. Both are chosen HERE from a closed set, never from
 * anything the caller sent — the SQL below interpolates the column name, which
 * is only safe because these two literals are the only values it can ever be.
 */
async function storeImage(c: Context<App>, kind: 'avatar' | 'cover'): Promise<Response> {
  const bucket = c.env.AVATARS;
  if (!bucket) return fail(c, 503, 'unavailable', 'Image storage is not configured.');

  const column = kind === 'avatar' ? 'avatar_key' : 'cover_url';
  const folder = kind === 'avatar' ? 'avatars' : 'covers';

  /**
   * TWO BODY SHAPES, because one of them cannot be trusted on a phone.
   *
   * Multipart is what a browser and `curl -F` send, and it stays supported. But
   * React Native's `FormData` takes a `{ uri, name, type }` shim rather than a
   * real File, and building that body is done by the platform, off the JS
   * thread, with failures surfacing as an opaque "Network request failed" that
   * never reaches the server — invisible in a Worker tail, because there is no
   * request. That is exactly how a cover upload failed silently three launches
   * running.
   *
   * So a raw body with an image Content-Type is also accepted. The phone reads
   * its own bytes and posts them, which involves no multipart encoder at all.
   */
  const contentType = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  let bytes: ArrayBuffer;
  let type: string;

  if (contentType === 'multipart/form-data') {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return fail(c, 400, 'invalid_body', 'Body must be multipart/form-data.');
    }
    const file = form.get('image');
    if (!(file instanceof File)) return fail(c, 400, 'invalid_body', 'An image file is required.');
    type = file.type;
    bytes = await file.arrayBuffer();
  } else {
    type = contentType;
    bytes = await c.req.arrayBuffer();
  }

  if (!ALLOWED.has(type)) {
    return fail(c, 415, 'unsupported_type', `Type ${type || 'unknown'} is not an image.`);
  }
  if (bytes.byteLength <= 0) return fail(c, 400, 'invalid_body', 'The image is empty.');
  const limit = kind === 'avatar' ? MAX_AVATAR_BYTES : MAX_COVER_BYTES;
  if (bytes.byteLength > limit) {
    return fail(c, 413, 'too_large', `That image is at most ${Math.floor(limit / 1_000_000)} MB.`);
  }

  const me = c.get('profileId');
  // Timestamped so a replacement gets a NEW address: `expo-image` and every
  // HTTP cache in between key on the URL, and a stable one would leave the old
  // picture on other people's screens for as long as it stayed cached.
  const key = `${folder}/${me}-${Date.now()}.${imageExtension(type)}`;

  const previous = await c.env.DB.prepare(
    `SELECT ${column} AS current FROM profiles WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(me)
    .first<{ current: string | null }>();
  if (!previous) return fail(c, 401, 'unauthenticated', 'No such profile.');

  await bucket.put(key, bytes, { httpMetadata: { contentType: type } });

  const publicUrl = `${new URL(c.req.url).origin}/v1/${key}`;
  await c.env.DB.prepare(`UPDATE profiles SET ${column} = ? WHERE id = ?`).bind(publicUrl, me).run();

  // The old object, best-effort and AFTER the row points at the new one: an
  // orphan costs a few kilobytes, whereas deleting first and then failing the
  // update leaves a profile pointing at nothing.
  const old = objectKeyOf(previous.current);
  if (old && old !== key) {
    try {
      await bucket.delete(old);
    } catch {
      // Swept later; never worth failing an upload that already succeeded.
    }
  }

  return c.json({ ok: true, url: publicUrl });
}

// ── POST /v1/me/avatar, POST /v1/me/cover ───────────────────────────────────

avatars.post('/me/avatar', requireAuth, (c) => storeImage(c, 'avatar'));

/**
 * The cover as an UPLOAD, alongside the URL form `PATCH /v1/me` takes.
 *
 * WHY BOTH. The picker's own choice is a catalogue address and stays one —
 * cheaper, and unforgeable. But a phone can hold a cover whose address it can no
 * longer publish: a TV Time import brings a `cloudfront.net` URL that no longer
 * resolves and the allow-list rightly refuses, and a reinstall can restore the
 * image file while losing the address entirely. In both cases the owner has a
 * banner, is looking at it, and there is nothing wrong with it — the only thing
 * missing is a way to say so. This is that way.
 *
 * Same bucket and the same scanning caveat as an avatar; the difference is only
 * that a cover reaches this route rarely.
 */
avatars.post('/me/cover', requireAuth, (c) => storeImage(c, 'cover'));

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
avatars.get('/:folder{avatars|covers}/:name', async (c) => {
  const bucket = c.env.AVATARS;
  if (!bucket) return fail(c, 503, 'unavailable', 'Image storage is not configured.');

  const name = c.req.param('name');
  // No slashes, no traversal — the route already prevents it, but the key is
  // rebuilt here rather than taken from the path so it cannot be anything else.
  // The folder is constrained by the route pattern to the two we write.
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return fail(c, 404, 'not_found', 'No such image.');

  const obj = await bucket.get(`${c.req.param('folder')}/${name}`);
  if (!obj) return fail(c, 404, 'not_found', 'No such image.');

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(obj.size),
    },
  });
});

/**
 * The R2 key inside a stored URL, or null if the column holds something else —
 * which for `cover_url` is the common case: a catalogue address owns no object
 * and must never be treated as one to delete.
 */
function objectKeyOf(stored: string | null): string | null {
  if (!stored) return null;
  const m = /\/v1\/((?:avatars|covers)\/[A-Za-z0-9_.-]+)$/.exec(stored);
  return m?.[1] ?? null;
}
