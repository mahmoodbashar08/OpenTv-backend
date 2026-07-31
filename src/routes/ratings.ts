import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import {
  AGGREGATE_TARGETS_PER_QUERY,
  aggregateDelta,
  chunk,
  emotionSetDelta,
  isTargetSource,
  MAX_TARGETS,
  parseTargets,
  validateVote,
  type ParsedTarget,
  type Vote,
} from '@/pure';

/**
 * Votes in, percentages out. docs/IMPLEMENTATION.md Step 2.
 *
 * The write path keeps `rating_aggregates` up to date by *delta*, inside one
 * `db.batch()` so the vote and its rollup move together or not at all. D1's
 * batch is an implicit transaction; there is no BEGIN/COMMIT to write by hand.
 *
 * FEELINGS ARE A SET (migrations/0005_emotion_votes.sql). `emotions` is the
 * person's WHOLE selection for this target and REPLACES whatever they had: the
 * handler diffs stored against sent, decrements what they dropped, increments
 * what they added, and does both in the same batch as the vote itself. Every
 * selection counts once, so `emotion_counts` counts SELECTIONS while
 * `vote_count` still counts PEOPLE, and the app renders each feeling as a share
 * of the total selections.
 *
 * DRIFT IS EXPECTED AND ACCOUNTED FOR. Two simultaneous votes by the same
 * person, or `DELETE /v1/me` removing ratings without touching rollups, will
 * nudge a counter off. That is precisely what the Step 5 `counter_repair` job
 * exists for. Do not add locking: the correction is nightly and the numbers
 * are percentages.
 */

export const ratings = new Hono<App>();

/** Five minutes stale on a vote count is invisible; the D1 budget it protects is not. */
const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=3600';

type AggregateRow = {
  /** Selected by the list form only — a mixed screen must be able to match rows back. */
  target_source?: string;
  target_key?: string;
  season: number;
  episode: number;
  vote_count: number;
  score_sum: number;
  emotion_counts: string | null;
  score_counts: string | null;
};

/** The columns every read of this table selects, so the two forms cannot diverge. */
const AGGREGATE_COLUMNS = 'vote_count, score_sum, emotion_counts, score_counts';

/**
 * A counts blob, parsed. Anything that is not a JSON object — including the NULL
 * a `score_counts` row carries until the nightly recount backfills it — becomes
 * `{}`, never null, so the client renders one shape and never special-cases the
 * migration window.
 */
function countsObject(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function shapeAggregate(row: AggregateRow) {
  return {
    ...(row.target_source ? { target_source: row.target_source, target_key: row.target_key } : {}),
    season: row.season,
    episode: row.episode,
    vote_count: row.vote_count,
    // Exposed raw, deliberately: the client renders score_sum / vote_count as
    // "average of votes cast". The schema carries no `scored_count`, so a
    // server-computed average would silently be the wrong one
    // (docs/IMPLEMENTATION.md Step 2, "The delta logic").
    score_sum: row.score_sum,
    emotion_counts: countsObject(row.emotion_counts),
    // The distribution. Additive — `score_sum` and `vote_count` stay exactly
    // where they were, because the app already reads them — but this is the one
    // the design actually needs: a mean cannot render "82% gave five stars".
    // See migrations/0004_score_distribution.sql.
    score_counts: countsObject(row.score_counts),
  };
}

// ── POST /v1/ratings ─────────────────────────────────────────────────────────

ratings.post('/ratings', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;

  if (!isTargetSource(b.target_source)) {
    return fail(c, 400, 'target_invalid', 'target_source must be tvdb, tmdb or title.');
  }
  if (typeof b.target_key !== 'string' || b.target_key.length === 0) {
    return fail(c, 400, 'target_invalid', 'target_key is required.');
  }
  const src = b.target_source;
  const key = b.target_key;

  const check = validateVote(b);
  if (!check.ok) return fail(c, 400, 'invalid_body', `Vote rejected (${check.reason}).`);
  const next = check.vote;

  // rating_aggregates' primary key cannot hold NULLs, so a show- or film-level
  // vote is -1/-1 there. `ratings` keeps the NULLs and COALESCEs on read.
  const s = next.season ?? -1;
  const e = next.episode ?? -1;

  const db = c.env.DB;
  const me = c.get('profileId');
  const now = new Date().toISOString();

  // The previous vote and the previous set of feelings, read first: a batch
  // cannot branch on a result, so every decision is made here in JS.
  const prev = await db
    .prepare(
      `SELECT id, score FROM ratings
       WHERE author_id = ? AND target_source = ? AND target_key = ?
         AND COALESCE(season, -1) = ? AND COALESCE(episode, -1) = ?`,
    )
    .bind(me, src, key, s, e)
    .first<{ id: string } & Vote>();

  const held = await db
    .prepare(
      `SELECT emotion FROM emotion_votes
       WHERE author_id = ? AND target_source = ? AND target_key = ?
         AND season = ? AND episode = ?`,
    )
    .bind(me, src, key, s, e)
    .all<{ emotion: string }>();
  const prevEmotions = (held.results ?? []).map((r) => r.emotion);

  // "Clear my feelings" when there are none and no vote either is an empty
  // vote after all — `validateVote` cannot see that, because only a read can.
  // Without this, `{score: null, emotions: []}` would mint a `ratings` row with
  // nothing in it and put +1 on a `vote_count` that stands for a person who
  // expressed nothing.
  if (next.score === null && next.emotions?.length === 0 && !prev && prevEmotions.length === 0) {
    return fail(c, 400, 'invalid_body', 'Vote rejected (empty_vote).');
  }

  const d = aggregateDelta(prev, next);
  const em = emotionSetDelta(prevEmotions, next.emotions);

  // The emotion blob is JSON, and a read-modify-write of it across users is
  // racy. Done in SQL it is not — one `json_set` per feeling the person dropped
  // and one per feeling they added, folded into a single expression. An
  // unchanged set emits nothing at all, which is what makes re-submitting the
  // same selection a no-op rather than a slow upward drift.
  //
  // The path is QUOTED (`'$."shocked"'`) like `score_counts` and the
  // character-vote rollup, so the two blobs on this table are maintained by one
  // idiom; every name has already passed `isEmotion`, and a quoted path can be
  // nothing but a single key regardless.
  const emotionBinds: string[] = [];
  let emotionSet = '';
  if (em.added.length > 0 || em.removed.length > 0) {
    let expr = "COALESCE(rating_aggregates.emotion_counts, '{}')";
    for (const gone of em.removed) {
      expr = `json_set(${expr}, '$."' || ? || '"', MAX(0, COALESCE(json_extract(rating_aggregates.emotion_counts, '$."' || ? || '"'), 0) - 1))`;
      emotionBinds.push(gone, gone);
    }
    for (const added of em.added) {
      expr = `json_set(${expr}, '$."' || ? || '"', COALESCE(json_extract(rating_aggregates.emotion_counts, '$."' || ? || '"'), 0) + 1)`;
      emotionBinds.push(added, added);
    }
    emotionSet = `emotion_counts = ${expr},`;
  }

  // The INSERT half of the upsert: this target had no rollup row, so the
  // person's whole new set is the whole blob. Nothing to decrement — there was
  // nothing there.
  const initialEmotionJson = JSON.stringify(Object.fromEntries(em.added.map((x) => [x, 1])));

  // The score distribution moves exactly as the emotion blob does, and for the
  // same reason: a read-modify-write across users is racy, done in SQL it is
  // not. The path is QUOTED (`'$."10"'`) like the character-vote rollup's, even
  // though a score is a number and `'$.' || 10` would parse — the two blobs on
  // this table should not be maintained by two different-looking idioms, and
  // `aggregateDelta` has already run both ends through `isScore`.
  //
  // The bucket key is bound as a STRING, and that is not cosmetic. A JS number
  // bound into `'$."' || ? || '"'` is concatenated by SQLite using the bound
  // value's own type: bind 10 as a float — which is all a JSON body ever
  // carries, and what a driver is free to hand the database — and the path
  // becomes `$."10.0"`, a second bucket for the same star that no read would
  // ever find. `String()` on an already-validated integer makes the key exactly
  // the "10" that `JSON.stringify` and the nightly `CAST(score AS TEXT)` both
  // produce.
  const scoreBinds: string[] = [];
  let scoreSet = '';
  if (d.scoreFrom !== d.scoreTo) {
    let expr = "COALESCE(rating_aggregates.score_counts, '{}')";
    if (d.scoreFrom !== null) {
      const k = String(d.scoreFrom);
      expr = `json_set(${expr}, '$."' || ? || '"', MAX(0, COALESCE(json_extract(rating_aggregates.score_counts, '$."' || ? || '"'), 0) - 1))`;
      scoreBinds.push(k, k);
    }
    if (d.scoreTo !== null) {
      const k = String(d.scoreTo);
      expr = `json_set(${expr}, '$."' || ? || '"', COALESCE(json_extract(rating_aggregates.score_counts, '$."' || ? || '"'), 0) + 1)`;
      scoreBinds.push(k, k);
    }
    scoreSet = `score_counts = ${expr},`;
  }

  const initialScoreJson = d.scoreTo === null ? '{}' : JSON.stringify({ [d.scoreTo]: 1 });

  await db.batch([
    db
      .prepare(
        // The ON CONFLICT target names `idx_one_vote_per_person` by its
        // EXPRESSION, COALESCE included: SQLite matches expression indexes by
        // expression, not by name. Get it wrong and the upsert silently
        // becomes a duplicate-key error.
        //
        // `emotion` is not named at all any more — the column is stranded NULL
        // by 0005 and the feelings live in `emotion_votes` below. A row with a
        // NULL score is still written and still wanted: it is what makes
        // `vote_count` count the person who only tapped a feeling.
        `INSERT INTO ratings (id, author_id, target_source, target_key, season, episode, score, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (author_id, target_source, target_key, COALESCE(season, -1), COALESCE(episode, -1))
         DO UPDATE SET score = excluded.score`,
      )
      .bind(
        `r_${crypto.randomUUID().replace(/-/g, '')}`,
        me,
        src,
        key,
        next.season,
        next.episode,
        next.score,
        now,
      ),

    // The set, replaced: one DELETE per feeling let go, one INSERT per feeling
    // picked up. `OR IGNORE` on the insert because a double-submit of the same
    // selection must be a no-op and not a 500 — the primary key is the set
    // semantics, and it is allowed to say no.
    ...em.removed.map((gone) =>
      db
        .prepare(
          `DELETE FROM emotion_votes
            WHERE author_id = ? AND target_source = ? AND target_key = ?
              AND season = ? AND episode = ? AND emotion = ?`,
        )
        .bind(me, src, key, s, e, gone),
    ),
    ...em.added.map((added) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO emotion_votes
             (author_id, target_source, target_key, season, episode, emotion, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(me, src, key, s, e, added, now),
    ),

    db
      .prepare(
        `INSERT INTO rating_aggregates
           (target_source, target_key, season, episode, vote_count, score_sum, emotion_counts,
            score_counts, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (target_source, target_key, season, episode) DO UPDATE SET
           vote_count = rating_aggregates.vote_count + excluded.vote_count,
           score_sum  = rating_aggregates.score_sum  + excluded.score_sum,
           ${emotionSet}
           ${scoreSet}
           updated_at = excluded.updated_at`,
      )
      .bind(
        src,
        key,
        s,
        e,
        d.dVotes,
        d.dScore,
        initialEmotionJson,
        initialScoreJson,
        now,
        ...emotionBinds,
        ...scoreBinds,
      ),
  ]);

  const row = await db
    .prepare(
      `SELECT season, episode, ${AGGREGATE_COLUMNS} FROM rating_aggregates
       WHERE target_source = ? AND target_key = ? AND season = ? AND episode = ?`,
    )
    .bind(src, key, s, e)
    .first<AggregateRow>();

  return c.json({ ok: true, aggregate: row ? shapeAggregate(row) : null });
});

// ── GET /v1/aggregates — open, edge-cached ───────────────────────────────────
//
// No auth: a percentage is public, and requiring a session would put a token
// on the one request a cache should be able to answer for everybody at once.

ratings.get('/aggregates', async (c) => {
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: 'GET' });

  const hit = await cache.match(cacheKey);
  if (hit) {
    // Header rewritten rather than served as-is so a hit is visible in a curl
    // -D-; the body is untouched.
    const headers = new Headers(hit.headers);
    headers.set('X-Cache', 'HIT');
    return new Response(hit.body, { status: hit.status, headers });
  }

  const url = new URL(c.req.url);
  const targets = url.searchParams.getAll('t');
  const source = url.searchParams.get('source');
  const key = url.searchParams.get('key');

  let rows: AggregateRow[];

  if (targets.length > 0) {
    // The list form: a mixed screen, e.g. a watchlist of films.
    const parsed = parseTargets(targets);
    if (!parsed) {
      return fail(
        c,
        400,
        'target_invalid',
        `t must be source:key[:season:episode], at most ${MAX_TARGETS} of them.`,
      );
    }
    rows = await listAggregates(c.env.DB, parsed);
  } else {
    // The season form: one short, highly cacheable URL for the screen that
    // asks most often.
    if (!isTargetSource(source) || !key) {
      return fail(c, 400, 'target_invalid', 'source and key are required.');
    }
    const seasonRaw = url.searchParams.get('season');
    // Absent season means the show/film level, which is -1 in this table.
    const season = seasonRaw === null ? -1 : Number(seasonRaw);
    if (!Number.isInteger(season) || season < -1) {
      return fail(c, 400, 'target_invalid', 'season must be a non-negative integer.');
    }
    const res = await c.env.DB.prepare(
      `SELECT season, episode, ${AGGREGATE_COLUMNS} FROM rating_aggregates
       WHERE target_source = ? AND target_key = ? AND season = ?
       ORDER BY episode`,
    )
      .bind(source, key, season)
      .all<AggregateRow>();
    rows = res.results ?? [];
  }

  const res = c.json({ items: rows.map(shapeAggregate) });
  res.headers.set('Cache-Control', CACHE_CONTROL);
  res.headers.set('X-Cache', 'MISS');

  // Only 200s are cached, and the clone is what goes in — the response body is
  // a stream and can be read exactly once.
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});

/**
 * The list form's read: a row-value `IN (VALUES …)` per group of at most
 * `AGGREGATE_TARGETS_PER_QUERY` targets, all groups in one `db.batch()`.
 *
 * IT USED TO BE ONE STATEMENT FOR ALL 100, AND THAT COULD NEVER HAVE WORKED.
 * Four binds a target against D1's 100-parameter ceiling means 25 targets was
 * the real limit and the 26th was an unconditional 500 — while `MAX_TARGETS`
 * went on advertising 100 and the app went on asking for 100. Every prefetch the
 * client has ever made failed, silently, and the user saw no community numbers
 * until they opened a title one at a time.
 *
 * The chunking is INTERNAL. The public cap is untouched, the batch is still one
 * round trip, and the groups are concatenated in order, so a call of 25 or fewer
 * produces byte-identical bytes to before: one group, one statement, one result
 * set, unchanged.
 */
async function listAggregates(db: D1Database, targets: readonly ParsedTarget[]): Promise<AggregateRow[]> {
  const groups = chunk(targets, AGGREGATE_TARGETS_PER_QUERY);

  const results = await db.batch<AggregateRow & { target_source: string; target_key: string }>(
    groups.map((group) =>
      db
        .prepare(
          `SELECT season, episode, target_source, target_key, ${AGGREGATE_COLUMNS}
       FROM rating_aggregates
       WHERE (target_source, target_key, season, episode) IN (VALUES ${group
         .map(() => '(?, ?, ?, ?)')
         .join(', ')})`,
        )
        .bind(...group.flatMap((t) => [t.source, t.key, t.season, t.episode])),
    ),
  );

  // Concatenated in group order, and each group's rows in the order the database
  // gave them — the same order the single statement produced, one slice at a
  // time.
  return results.flatMap((r) => r.results ?? []);
}
