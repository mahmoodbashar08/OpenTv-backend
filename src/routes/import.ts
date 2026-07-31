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
  stableRatingId,
  validateCommentBody,
  validateVote,
  VOTE_IMPORT_MAX_ITEMS,
} from '@/pure';

/**
 * Opt-in seeding — the user's own TV Time archive, brought with them.
 * docs/IMPLEMENTATION.md Step 3, "Opt-in seeding".
 *
 * Fired by the app after the join prompt, which itself fires after a successful
 * import: *"you imported 47 comments — bring them with you?"*
 *
 * Two properties make these endpoints safe to call repeatedly, which they will
 * be:
 *
 *  1. The id is DERIVED (`stableImportId`, `stableRatingId`), so a re-import is
 *     a no-op with no read-before-write. This mirrors the app's own merge-safe
 *     import rule.
 *  2. `created_at` comes from the ITEM — these are comments from 2019 and must
 *     sort as such — while `imported_at` is now, which is how the UI knows to
 *     mark them as brought-from-TV-Time rather than freshly written.
 *
 * Imported anything never generates notifications. Nobody wants an inbox full
 * of replies they wrote themselves seven years ago.
 */

export const seeding = new Hono<App>();

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

seeding.post('/comments/import', requireAuth, async (c) => {
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

// ── POST /v1/ratings/import ─────────────────────────────────────────────────
//
// The endpoint this whole file existed only half of. A user could seed their
// comments and nothing else, so every rating and every emotion an archive
// carried stayed on the phone and every community percentage started at zero
// and stayed there. Seeding the votes without moving the rollups would have
// been the same bug wearing a success message: `ratings` full, `%` empty.
//
// DEDUPE BY CONSTRUCTION, twice over:
//
//  1. The id is derived from (author, target) alone — `stableRatingId` — so the
//     same export imported twice inserts the same primary key.
//  2. The row may ALSO already exist under a random `r_…` id from a live vote,
//     which the derived id cannot know about. `ON CONFLICT … DO NOTHING` names
//     `idx_one_vote_per_person` BY ITS EXPRESSION, COALESCE included: SQLite
//     matches expression indexes by expression, not by name, and a mistyped
//     target turns the upsert into a constraint error.
//
// An import never overwrites a live vote. Someone who rated an episode 9 in the
// app this morning and then seeds a 6 from a 2019 archive keeps the 9 — the
// newer, deliberate act wins over the older, bulk one.

type PreparedVote = {
  id: string;
  source: string;
  key: string;
  season: number | null;
  episode: number | null;
  score: number | null;
  emotion: string | null;
  createdAt: string;
};

seeding.post('/ratings/import', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return fail(c, 400, 'invalid_body', 'items must be an array.');
  if (items.length === 0) return c.json({ imported: 0, skipped: 0 });
  if (items.length > VOTE_IMPORT_MAX_ITEMS) {
    return fail(c, 400, 'too_large', `At most ${VOTE_IMPORT_MAX_ITEMS} items per call.`);
  }

  const db = c.env.DB;
  const me = c.get('profileId');
  const nowIso = new Date().toISOString();

  const alive = await db
    .prepare('SELECT 1 AS one FROM profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(me)
    .first();
  if (!alive) return fail(c, 401, 'unauthenticated', 'No such profile.');

  // Invalid items are SKIPPED and counted, never fatal: one malformed row in a
  // seven-year-old export must not be able to block the whole seeding forever.
  const prepared: PreparedVote[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const it = raw as Record<string, unknown>;

    if (!isTargetSource(it.target_source)) continue;
    if (typeof it.target_key !== 'string' || it.target_key.length === 0) continue;

    // The same gate the live vote passes, allow-listed emotion included — an
    // unvalidated emotion becomes a JSON path in the aggregate upsert below.
    const check = validateVote(it);
    if (!check.ok) continue;
    const v = check.vote;

    // Unlike a comment, a missing or unparseable timestamp is NOT fatal here.
    // Nothing sorts by a rating's `created_at`; it is provenance, and refusing
    // a whole vote over it would drop a percentage to protect a field nobody
    // reads.
    const createdAt =
      typeof it.created_at === 'string' && !Number.isNaN(Date.parse(it.created_at))
        ? it.created_at
        : nowIso;

    prepared.push({
      id: await stableRatingId({
        authorId: me,
        targetSource: it.target_source,
        targetKey: it.target_key,
        season: v.season,
        episode: v.episode,
      }),
      source: it.target_source,
      key: it.target_key,
      season: v.season,
      episode: v.episode,
      score: v.score,
      emotion: v.emotion,
      createdAt,
    });
  }

  let imported = 0;
  for (let i = 0; i < prepared.length; i += BATCH_CHUNK) {
    const statements: D1PreparedStatement[] = [];
    const chunk = prepared.slice(i, i + BATCH_CHUNK);

    for (const p of chunk) {
      // rating_aggregates' primary key cannot hold NULLs, so a show- or
      // film-level vote is -1/-1 there. `ratings` keeps the NULLs.
      const s = p.season ?? -1;
      const e = p.episode ?? -1;

      // THE ORDER OF THESE TWO STATEMENTS IS THE WHOLE MECHANISM.
      //
      // The rollup goes FIRST, guarded by `WHERE NOT EXISTS (the vote)`. A
      // `db.batch()` is one implicit transaction executed in order, so the
      // guard sees the world as it was before this item's insert — and, on a
      // re-import, sees the row that is already there and adds nothing. Two
      // copies of the same item inside one payload behave correctly for the
      // same reason: the second guard sees the first insert.
      //
      // Doing it the other way round — insert, then rollup — would need the
      // insert's `meta.changes` to decide, and a batch cannot branch on a
      // result. Doing it in two round trips would let the two diverge.
      statements.push(
        db
          .prepare(
            `INSERT INTO rating_aggregates
               (target_source, target_key, season, episode, vote_count, score_sum, emotion_counts,
                score_counts, updated_at)
             SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?
              WHERE NOT EXISTS (
                SELECT 1 FROM ratings r
                 WHERE r.author_id = ? AND r.target_source = ? AND r.target_key = ?
                   AND COALESCE(r.season, -1) = ? AND COALESCE(r.episode, -1) = ?)
             ON CONFLICT (target_source, target_key, season, episode) DO UPDATE SET
               vote_count = rating_aggregates.vote_count + 1,
               score_sum  = rating_aggregates.score_sum + excluded.score_sum,
               ${
                 p.emotion === null
                   ? ''
                   : `emotion_counts = json_set(
                        COALESCE(rating_aggregates.emotion_counts, '{}'), '$.' || ?,
                        COALESCE(json_extract(rating_aggregates.emotion_counts, '$.' || ?), 0) + 1),`
               }
               ${
                 // The distribution, seeded by the same statement that seeds the
                 // sum. Without this half, importing an archive would fill
                 // `score_counts` for nobody: every star bar would read 0% while
                 // `vote_count` climbed into the thousands — `ratings` full, `%`
                 // empty, the exact bug this endpoint was written to fix, one
                 // column over. The path is quoted; `p.score` came through
                 // `validateVote` and is an integer in 1..10.
                 p.score === null
                   ? ''
                   : `score_counts = json_set(
                        COALESCE(rating_aggregates.score_counts, '{}'), '$."' || ? || '"',
                        COALESCE(json_extract(rating_aggregates.score_counts, '$."' || ? || '"'), 0) + 1),`
               }
               updated_at = excluded.updated_at`,
          )
          .bind(
            p.source,
            p.key,
            s,
            e,
            p.score ?? 0,
            p.emotion === null ? '{}' : JSON.stringify({ [p.emotion]: 1 }),
            p.score === null ? '{}' : JSON.stringify({ [p.score]: 1 }),
            nowIso,
            me,
            p.source,
            p.key,
            s,
            e,
            ...(p.emotion === null ? [] : [p.emotion, p.emotion]),
            // As a STRING, for the reason spelled out in routes/ratings.ts: a
            // number bound into `'$."' || ? || '"'` can arrive as a float and
            // open a `$."10.0"` bucket nothing will ever read.
            ...(p.score === null ? [] : [String(p.score), String(p.score)]),
          ),
      );

      statements.push(
        db
          .prepare(
            `INSERT INTO ratings
               (id, author_id, target_source, target_key, season, episode, score, emotion, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (author_id, target_source, target_key,
                          COALESCE(season, -1), COALESCE(episode, -1)) DO NOTHING`,
          )
          .bind(p.id, me, p.source, p.key, p.season, p.episode, p.score, p.emotion, p.createdAt),
      );
    }

    const results = await db.batch(statements);
    // Every second result is an insert; the odd ones are the rollup and their
    // `changes` must not be counted as an imported vote.
    for (let n = 1; n < results.length; n += 2) imported += results[n]?.meta?.changes ?? 0;
  }

  return c.json({ imported, skipped: items.length - imported });
});
