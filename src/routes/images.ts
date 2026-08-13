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

// ── GET /v1/comments/:id/image — open, cached, `clean` only ─────────────────

/**
 * SERVING A RESCUED PHOTOGRAPH, and the line it may not cross.
 *
 * This file spent its whole life storing images and refusing to hand any back,
 * for a reason that has not changed: publishing somebody's picture to strangers
 * means owning what is in it. What has changed is that the alternative turned
 * out to have a cost too — 136 photographs saved from a dead CDN, belonging to
 * four people, visible to nobody including the people who took them, on screens
 * whose whole point was that the comments came back.
 *
 * So it serves exactly one category: `scan_status = 'clean'`, which is set by a
 * person looking at the picture and saying so, through the admin review page.
 * There is no route, flag or default that turns `pending` into `clean` without
 * that. Anything not cleared answers 404 — the same answer as a comment with no
 * picture, because "there is an image here you may not see" is a question
 * nobody should have to field.
 *
 * NEW UPLOADS ARE STILL NOT POSSIBLE. The app has no attach button; the POST
 * above exists for the archive rescue alone. Serving the rescue does not open
 * that door, and it should not be opened without the automated scan the
 * constraint in migration 0001 was written for.
 *
 * IMMUTABLE ONCE PUBLIC. An image is bytes that never change, keyed by a
 * comment id that never changes, so a long cache is honest — and it keeps this
 * route off both D1 and R2 for everybody after the first reader. A picture
 * withdrawn later stops being served at the edge's next miss; the review page
 * exists to catch things before that matters.
 */
images.get('/comments/:id/image', async (c) => {
  const bucket = c.env.COMMENT_IMAGES;
  if (!bucket) return fail(c, 503, 'unavailable', 'Image storage is not configured.');

  const row = await c.env.DB.prepare(
    `SELECT ci.r2_key
       FROM comment_images ci
       JOIN comments cm ON cm.id = ci.comment_id
      WHERE ci.comment_id = ?
        AND ci.scan_status = 'clean'
        -- A deleted or hidden comment takes its picture with it. Moderating the
        -- text and leaving the image reachable by its own URL would make the
        -- hide cosmetic.
        AND cm.deleted_at IS NULL
        AND cm.hidden_at IS NULL`,
  )
    .bind(c.req.param('id'))
    .first<{ r2_key: string }>();
  if (!row) return fail(c, 404, 'not_found', 'No image.');

  const object = await bucket.get(row.r2_key);
  if (!object) return fail(c, 404, 'not_found', 'No image.');

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      // Nothing here is a document, and a browser that decides otherwise about
      // user-supplied bytes is the start of a different kind of problem.
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
