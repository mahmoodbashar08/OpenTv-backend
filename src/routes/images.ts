import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import { imageExtension, MAX_COMMENT_IMAGE_BYTES, numberOrNull, stableImportId, validateCommentBody } from '@/pure';

/**
 * Rescuing the photographs people attached to their TV Time comments.
 *
 * WHY THIS IS URGENT AND CANNOT BE DONE LATER. The export does not contain the
 * images. It contains LINKS to them, on TV Time's CloudFront distribution,
 * which no longer resolves — the hostname does not exist in DNS. Nothing can be
 * fetched from TV Time any more, by us or by anyone.
 *
 * The only surviving copies are the ones OpenTV itself downloaded onto users'
 * phones at import time, while the CDN was still up (`downloadPendingCommentImages`
 * in mobile/src/importer.ts). Every reinstall, every lost phone, permanently
 * destroys some of them. So this route exists to take those copies while they
 * still exist. The window closes on its own and never reopens.
 *
 * STORED, NOT SERVED. Every row lands with `scan_status = 'pending'` and there
 * is deliberately no route in this file that reads an image back out. Serving
 * user-uploaded pictures to other people means owning what is in them, and that
 * needs image scanning wired up first — the constraint migration 0001 already
 * wrote down. Preserving a file and publishing it are separate decisions, and
 * only the first one is time-critical.
 *
 * IDENTITY IS DERIVED, NEVER SENT. The caller does not know the server's id for
 * its own comment and must not have to guess: `stableImportId` is a hash over
 * (author, target, season, episode, created_at, body), so the client sends the
 * SAME fields it sent to `/v1/comments/import` and the server arrives at the
 * same id by the same function. A second implementation of that hash on the
 * phone would be one refactor away from silently orphaning every image.
 */

export const images = new Hono<App>();

/** What R2 will be told, and the only types accepted. Anything else is a 415. */
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// ── POST /v1/comments/image ─────────────────────────────────────────────────

images.post('/comments/image', requireAuth, async (c) => {
  const bucket = c.env.COMMENT_IMAGES;
  // A missing binding is "this deployment has no image storage", not a crash.
  if (!bucket) return fail(c, 503, 'unavailable', 'Image storage is not configured.');

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be multipart/form-data.');
  }

  const file = form.get('image');
  if (!(file instanceof File)) return fail(c, 400, 'invalid_body', 'An image file is required.');
  if (!ALLOWED.has(file.type)) return fail(c, 415, 'unsupported_type', `Type ${file.type || 'unknown'} is not an image.`);
  if (file.size <= 0) return fail(c, 400, 'invalid_body', 'The image is empty.');
  if (file.size > MAX_COMMENT_IMAGE_BYTES) {
    return fail(c, 413, 'too_large', `An image is at most ${Math.floor(MAX_COMMENT_IMAGE_BYTES / 1_000_000)} MB.`);
  }

  // The same six fields `/v1/comments/import` was given, so the same id comes out.
  const targetSource = form.get('target_source');
  const targetKey = form.get('target_key');
  const createdAt = form.get('created_at');
  const body = form.get('body');
  if (typeof targetSource !== 'string' || typeof targetKey !== 'string' || targetKey.length === 0) {
    return fail(c, 400, 'target_invalid', 'target_source and target_key are required.');
  }
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    return fail(c, 400, 'invalid_body', 'created_at must be a timestamp.');
  }
  // Empty is legitimate HERE by definition: a request on this route is
  // carrying an image, which is exactly the condition under which the import
  // accepted an empty body. Refusing it would reject the picture-only comments
  // this route exists for.
  const text = validateCommentBody(typeof body === 'string' ? body : '', { allowEmpty: true });
  if (!text.ok) return fail(c, 400, 'invalid_body', `Comment body rejected (${text.reason}).`);

  const season = numberOrNull(form.get('season') === null ? null : Number(form.get('season')));
  if (season === undefined) return fail(c, 400, 'invalid_body', 'season must be a non-negative integer.');
  const episode = numberOrNull(form.get('episode') === null ? null : Number(form.get('episode')));
  if (episode === undefined) return fail(c, 400, 'invalid_body', 'episode must be a non-negative integer.');

  const db = c.env.DB;
  const me = c.get('profileId');
  const id = await stableImportId({
    authorId: me,
    targetSource,
    targetKey,
    season,
    episode,
    createdAt,
    body: text.body,
  });

  // The comment must already be here, and be this person's. Deriving the id
  // from the author means a mismatch cannot be someone else's comment — it is a
  // comment that was never imported — but the row is checked rather than
  // assumed, so an image can never outlive or precede the thing it belongs to.
  const owned = await db
    .prepare('SELECT 1 AS ok FROM comments WHERE id = ? AND author_id = ?')
    .bind(id, me)
    .first<{ ok: number }>();
  if (!owned) return fail(c, 404, 'not_found', 'No imported comment matches those details.');

  // Idempotent: re-running the seed must not spend an upload or duplicate a row.
  const already = await db
    .prepare('SELECT r2_key FROM comment_images WHERE comment_id = ?')
    .bind(id)
    .first<{ r2_key: string }>();
  if (already) return c.json({ ok: true, stored: false, comment_id: id });

  const key = `comments/${id}.${imageExtension(file.type)}`;
  await bucket.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });

  await db
    .prepare(
      `INSERT INTO comment_images (comment_id, r2_key, width, height, is_gif, scan_status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(
      id,
      key,
      numberOrNull(form.get('width') === null ? null : Number(form.get('width'))) ?? null,
      numberOrNull(form.get('height') === null ? null : Number(form.get('height'))) ?? null,
      file.type === 'image/gif' ? 1 : 0,
      new Date().toISOString(),
    )
    .run();

  return c.json({ ok: true, stored: true, comment_id: id });
});
