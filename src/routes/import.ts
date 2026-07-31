import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import {
  IMPORT_MAX_ITEMS,
  isTargetSource,
  isValidBcp47,
  numberOrNull,
  stableImportId,
  validateCommentBody,
} from '@/pure';

/**
 * Opt-in seeding — the user's own TV Time comments, brought with them.
 * docs/IMPLEMENTATION.md Step 3, "Opt-in seeding".
 *
 * Fired by the app after the join prompt, which itself fires after a successful
 * import: *"you imported 47 comments — bring them with you?"*
 *
 * Two properties make this endpoint safe to call repeatedly, which it will be:
 *
 *  1. The id is DERIVED from the content (`stableImportId`), so `INSERT OR
 *     IGNORE` makes a re-import a no-op with no read-before-write and no unique
 *     index to add. This mirrors the app's own merge-safe import rule.
 *  2. `created_at` comes from the ITEM — these are comments from 2019 and must
 *     sort as such — while `imported_at` is now, which is how the UI knows to
 *     mark them as brought-from-TV-Time rather than freshly written.
 *
 * Imported comments never generate notifications. Nobody wants an inbox full of
 * replies they wrote themselves seven years ago.
 */

export const commentImport = new Hono<App>();

/** D1 takes large batches, but 50 statements a round trip keeps each one well inside every limit. */
const BATCH_CHUNK = 50;

type Prepared = {
  id: string;
  source: string;
  key: string;
  season: number | null;
  episode: number | null;
  body: string;
  isSpoiler: number;
  lang: string | null;
  createdAt: string;
};

commentImport.post('/comments/import', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return fail(c, 400, 'invalid_body', 'items must be an array.');
  if (items.length === 0) return c.json({ imported: 0, skipped: 0 });
  if (items.length > IMPORT_MAX_ITEMS) {
    // 400 with `too_large`, not 413: the error table in the conventions section
    // lists `too_large` as a code and does not list 413 as a status. The app
    // chunks at 200; a client that does not is asking a question the code
    // string answers precisely.
    return fail(c, 400, 'too_large', `At most ${IMPORT_MAX_ITEMS} items per call.`);
  }

  const db = c.env.DB;
  const me = c.get('profileId');
  const nowIso = new Date().toISOString();

  const alive = await db
    .prepare('SELECT 1 AS one FROM profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(me)
    .first();
  if (!alive) return fail(c, 401, 'unauthenticated', 'No such profile.');

  // An item that fails validation is SKIPPED, not fatal. A single malformed row
  // in a seven-year-old export must not be able to block the whole seeding
  // forever, and `skipped` is exactly where the user's count of "not brought
  // over" belongs. `skipped` therefore covers both duplicates and rejects.
  const prepared: Prepared[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const it = raw as Record<string, unknown>;

    if (!isTargetSource(it.target_source)) continue;
    if (typeof it.target_key !== 'string' || it.target_key.length === 0) continue;

    const text = validateCommentBody(it.body);
    if (!text.ok) continue;

    const season = numberOrNull(it.season);
    if (season === undefined) continue;
    const episode = numberOrNull(it.episode);
    if (episode === undefined) continue;

    // The historical timestamp is the whole point; a missing or unparseable one
    // cannot be silently replaced with now, because that would put a 2019
    // comment at the top of today's thread.
    if (typeof it.created_at !== 'string' || Number.isNaN(Date.parse(it.created_at))) continue;
    const createdAt = it.created_at;

    prepared.push({
      id: await stableImportId({
        authorId: me,
        targetSource: it.target_source,
        targetKey: it.target_key,
        season,
        episode,
        createdAt,
        body: text.body,
      }),
      source: it.target_source,
      key: it.target_key,
      season,
      episode,
      body: text.body,
      isSpoiler: it.is_spoiler === true || it.is_spoiler === 1 ? 1 : 0,
      lang: isValidBcp47(it.lang) ? it.lang : null,
      createdAt,
    });
  }

  let imported = 0;
  for (let i = 0; i < prepared.length; i += BATCH_CHUNK) {
    const chunk = prepared.slice(i, i + BATCH_CHUNK);
    const results = await db.batch(
      chunk.map((p) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO comments
               (id, author_id, target_source, target_key, season, episode, body, is_spoiler, lang,
                parent_id, imported_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .bind(
            p.id,
            me,
            p.source,
            p.key,
            p.season,
            p.episode,
            p.body,
            p.isSpoiler,
            p.lang,
            nowIso,
            p.createdAt,
          ),
      ),
    );
    imported += results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  }

  return c.json({ imported, skipped: items.length - imported });
});
