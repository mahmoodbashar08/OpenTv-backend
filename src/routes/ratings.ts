import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import {
  aggregateDelta,
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
};

function emotionCounts(raw: string | null): Record<string, number> {
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
    emotion_counts: emotionCounts(row.emotion_counts),
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

  // The previous vote, alone: a batch cannot branch on a result.
  const prev = await db
    .prepare(
      `SELECT id, score, emotion FROM ratings
       WHERE author_id = ? AND target_source = ? AND target_key = ?
         AND COALESCE(season, -1) = ? AND COALESCE(episode, -1) = ?`,
    )
    .bind(me, src, key, s, e)
    .first<{ id: string } & Vote>();

  const d = aggregateDelta(prev, next);

  // The emotion blob is JSON, and a read-modify-write of it across users is
  // racy. Done in SQL it is not. Applied only when the emotion actually moved;
  // the decrement half is skipped when there was no previous emotion, the
  // increment half when the new vote has none (score-only over an emotion).
  const emotionBinds: string[] = [];
  let emotionSet = '';
  if (d.emotionFrom !== d.emotionTo) {
    let expr = "COALESCE(rating_aggregates.emotion_counts, '{}')";
    if (d.emotionFrom !== null) {
      expr = `json_set(${expr}, '$.' || ?, MAX(0, COALESCE(json_extract(rating_aggregates.emotion_counts, '$.' || ?), 0) - 1))`;
      emotionBinds.push(d.emotionFrom, d.emotionFrom);
    }
    if (d.emotionTo !== null) {
      expr = `json_set(${expr}, '$.' || ?, COALESCE(json_extract(rating_aggregates.emotion_counts, '$.' || ?), 0) + 1)`;
      emotionBinds.push(d.emotionTo, d.emotionTo);
    }
    emotionSet = `emotion_counts = ${expr},`;
  }

  const initialEmotionJson = d.emotionTo === null ? '{}' : JSON.stringify({ [d.emotionTo]: 1 });

  await db.batch([
    db
      .prepare(
        // The ON CONFLICT target names `idx_one_vote_per_person` by its
        // EXPRESSION, COALESCE included: SQLite matches expression indexes by
        // expression, not by name. Get it wrong and the upsert silently
        // becomes a duplicate-key error.
        `INSERT INTO ratings (id, author_id, target_source, target_key, season, episode, score, emotion, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (author_id, target_source, target_key, COALESCE(season, -1), COALESCE(episode, -1))
         DO UPDATE SET score = excluded.score, emotion = excluded.emotion`,
      )
      .bind(
        `r_${crypto.randomUUID().replace(/-/g, '')}`,
        me,
        src,
        key,
        next.season,
        next.episode,
        next.score,
        next.emotion,
        now,
      ),

    db
      .prepare(
        `INSERT INTO rating_aggregates
           (target_source, target_key, season, episode, vote_count, score_sum, emotion_counts, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (target_source, target_key, season, episode) DO UPDATE SET
           vote_count = rating_aggregates.vote_count + excluded.vote_count,
           score_sum  = rating_aggregates.score_sum  + excluded.score_sum,
           ${emotionSet}
           updated_at = excluded.updated_at`,
      )
      .bind(src, key, s, e, d.dVotes, d.dScore, initialEmotionJson, now, ...emotionBinds),
  ]);

  const row = await db
    .prepare(
      `SELECT season, episode, vote_count, score_sum, emotion_counts FROM rating_aggregates
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
      `SELECT season, episode, vote_count, score_sum, emotion_counts FROM rating_aggregates
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

/** One statement for the whole list: a row-value IN (VALUES …), capped at 100. */
async function listAggregates(db: D1Database, targets: readonly ParsedTarget[]): Promise<AggregateRow[]> {
  const tuples = targets.map(() => '(?, ?, ?, ?)').join(', ');
  const binds = targets.flatMap((t) => [t.source, t.key, t.season, t.episode]);
  const res = await db
    .prepare(
      `SELECT season, episode, target_source, target_key, vote_count, score_sum, emotion_counts
       FROM rating_aggregates
       WHERE (target_source, target_key, season, episode) IN (VALUES ${tuples})`,
    )
    .bind(...binds)
    .all<AggregateRow & { target_source: string; target_key: string }>();
  return res.results ?? [];
}
