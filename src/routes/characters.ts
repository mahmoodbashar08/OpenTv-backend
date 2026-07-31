import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import {
  isTargetSource,
  numberOrNull,
  shapeCharacterCounts,
  stableCharacterVoteId,
  validateCharacterName,
  VOTE_IMPORT_MAX_ITEMS,
} from '@/pure';

/**
 * "Who was your favourite?" — the question the app has asked per episode since
 * 1.0 and whose answer has never left the phone.
 *
 * The local table (`character_votes` in mobile/src/db.ts) is keyed
 * `(showId, season, episode)` and carries a `name` and a TheTVDB `charId`. The
 * community question is per SHOW, so the season and episode ride along as
 * provenance and take no part in the uniqueness rule. See migration 0003 for
 * the reasoning and for why the rollup is keyed by the NAME.
 *
 * `character_vote_aggregates` is maintained on write, exactly as
 * `rating_aggregates` is, and is allowed to drift for exactly as long as it
 * takes the 04:00 job to recount it.
 */

export const characterVotes = new Hono<App>();

/** Five minutes stale on a vote count is invisible; the D1 budget it protects is not. */
const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=3600';

/** D1 takes large batches, but 50 statements a round trip keeps each one well inside every limit. */
const BATCH_CHUNK = 50;

/**
 * The rollup increment. The name is BOUND, and the JSON path quotes it —
 * `'$."' || ? || '"'` — so "Dr. House" lands under one key instead of being
 * read as `$.Dr` → `House`. `validateCharacterName` is what guarantees the name
 * cannot close that quote.
 */
const INCREMENT = `json_set(COALESCE(character_vote_aggregates.counts, '{}'),
                    '$."' || ? || '"',
                    COALESCE(json_extract(character_vote_aggregates.counts, '$."' || ? || '"'), 0) + 1)`;

const DECREMENT = (inner: string) => `json_set(${inner},
                    '$."' || ? || '"',
                    MAX(0, COALESCE(json_extract(character_vote_aggregates.counts, '$."' || ? || '"'), 0) - 1))`;

function newCharacterVoteId(): string {
  return `cv_${crypto.randomUUID().replace(/-/g, '')}`;
}

// ── POST /v1/character-votes ────────────────────────────────────────────────

characterVotes.post('/character-votes', requireAuth, async (c) => {
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
  const name = validateCharacterName(b.character);
  if (!name.ok) return fail(c, 400, 'invalid_body', `Character rejected (${name.reason}).`);

  const season = numberOrNull(b.season);
  if (season === undefined) return fail(c, 400, 'invalid_body', 'season must be a non-negative integer.');
  const episode = numberOrNull(b.episode);
  if (episode === undefined) return fail(c, 400, 'invalid_body', 'episode must be a non-negative integer.');
  const characterId = numberOrNull(b.character_id);
  if (characterId === undefined) return fail(c, 400, 'invalid_body', 'character_id must be an integer.');

  const db = c.env.DB;
  const me = c.get('profileId');
  const src = b.target_source;
  const key = b.target_key;
  const now = new Date().toISOString();

  // The previous favourite, alone: a batch cannot branch on a result. Changing
  // your mind moves one count to another and leaves `total` alone — a re-vote
  // is not a new person.
  const prev = await db
    .prepare(
      'SELECT id, character_name FROM character_votes WHERE voter_id = ? AND target_source = ? AND target_key = ?',
    )
    .bind(me, src, key)
    .first<{ id: string; character_name: string }>();

  const moved = prev !== null && prev.character_name !== name.name;
  const binds: (string | number)[] = [];
  let countsSet = '';
  if (!prev || moved) {
    let expr = INCREMENT;
    binds.push(name.name, name.name);
    if (moved) {
      expr = DECREMENT(expr);
      binds.push(prev.character_name, prev.character_name);
    }
    countsSet = `counts = ${expr},`;
  }

  await db.batch([
    db
      .prepare(
        `INSERT INTO character_vote_aggregates (target_source, target_key, counts, total, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (target_source, target_key) DO UPDATE SET
           ${countsSet}
           total = character_vote_aggregates.total + ?,
           updated_at = excluded.updated_at`,
      )
      .bind(src, key, JSON.stringify({ [name.name]: 1 }), prev ? 0 : 1, now, ...binds, prev ? 0 : 1),

    db
      .prepare(
        `INSERT INTO character_votes
           (id, voter_id, target_source, target_key, character_name, character_id, season, episode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (voter_id, target_source, target_key) DO UPDATE SET
           character_name = excluded.character_name,
           character_id   = excluded.character_id,
           season         = excluded.season,
           episode        = excluded.episode`,
      )
      .bind(
        prev?.id ?? newCharacterVoteId(),
        me,
        src,
        key,
        name.name,
        characterId,
        season,
        episode,
        now,
      ),
  ]);

  return c.json({ ok: true, character: name.name });
});

// ── DELETE /v1/character-votes ──────────────────────────────────────────────

/**
 * Un-picking a favourite.
 *
 * WHY THIS EXISTS. The poll toggles: tapping your current favourite clears it,
 * because a poll with no way back out is a trap. Without this route that clear
 * was LOCAL ONLY, and the two sides silently disagreed — the phone showed
 * nothing selected while the server still counted the vote, so re-opening the
 * film showed a full bar next to an unhighlighted face and the feature looked
 * broken when every part of it was working.
 *
 * Deleting the row and decrementing are one batch, and `total` comes down with
 * the name's count: a person who has withdrawn is not a voter. Absent a vote
 * this is a no-op that still answers 200 — the caller is saying "there should
 * be no vote of mine here", and there is not.
 */
characterVotes.delete('/character-votes', requireAuth, async (c) => {
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

  const db = c.env.DB;
  const me = c.get('profileId');
  const src = b.target_source;
  const key = b.target_key;

  const prev = await db
    .prepare('SELECT character_name FROM character_votes WHERE voter_id = ? AND target_source = ? AND target_key = ?')
    .bind(me, src, key)
    .first<{ character_name: string }>();
  if (!prev) return c.json({ ok: true, removed: false });

  await db.batch([
    db
      .prepare(
        `UPDATE character_vote_aggregates
            SET counts = ${DECREMENT('COALESCE(character_vote_aggregates.counts, \'{}\')')},
                total = MAX(0, character_vote_aggregates.total - 1),
                updated_at = ?
          WHERE target_source = ? AND target_key = ?`,
      )
      .bind(prev.character_name, prev.character_name, new Date().toISOString(), src, key),
    db
      .prepare('DELETE FROM character_votes WHERE voter_id = ? AND target_source = ? AND target_key = ?')
      .bind(me, src, key),
  ]);

  return c.json({ ok: true, removed: true });
});

// ── POST /v1/character-votes/import ─────────────────────────────────────────
//
// The same shape and the same rules as `POST /v1/ratings/import`: cap 500,
// invalid items skipped and counted rather than fatal, ids derived so a
// re-import is a no-op, and the rollup moved in the SAME batch as the insert so
// the two cannot diverge. See `routes/import.ts` for why the rollup statement
// comes first and carries a `WHERE NOT EXISTS` guard.
//
// Unlike the live vote above, an import never REPLACES an existing favourite:
// `DO NOTHING`. The archive is the older, bulk act; a vote already on the
// server was chosen deliberately and wins.

type PreparedCharacterVote = {
  id: string;
  source: string;
  key: string;
  name: string;
  characterId: number | null;
  season: number | null;
  episode: number | null;
  createdAt: string;
};

characterVotes.post('/character-votes/import', requireAuth, async (c) => {
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

  // The archive holds one vote per EPISODE and the server holds one per SHOW,
  // so a show with forty per-episode favourites collapses to one row here. The
  // first item wins and the other thirty-nine are `skipped`, which is the
  // honest number: they were not brought over.
  const prepared: PreparedCharacterVote[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const it = raw as Record<string, unknown>;

    if (!isTargetSource(it.target_source)) continue;
    if (typeof it.target_key !== 'string' || it.target_key.length === 0) continue;

    const name = validateCharacterName(it.character);
    if (!name.ok) continue;

    const season = numberOrNull(it.season);
    if (season === undefined) continue;
    const episode = numberOrNull(it.episode);
    if (episode === undefined) continue;
    const characterId = numberOrNull(it.character_id);
    if (characterId === undefined) continue;

    prepared.push({
      id: await stableCharacterVoteId({
        voterId: me,
        targetSource: it.target_source,
        targetKey: it.target_key,
      }),
      source: it.target_source,
      key: it.target_key,
      name: name.name,
      characterId,
      season,
      episode,
      createdAt:
        typeof it.created_at === 'string' && !Number.isNaN(Date.parse(it.created_at))
          ? it.created_at
          : nowIso,
    });
  }

  let imported = 0;
  for (let i = 0; i < prepared.length; i += BATCH_CHUNK) {
    const statements: D1PreparedStatement[] = [];
    for (const p of prepared.slice(i, i + BATCH_CHUNK)) {
      statements.push(
        db
          .prepare(
            `INSERT INTO character_vote_aggregates (target_source, target_key, counts, total, updated_at)
             SELECT ?, ?, ?, 1, ?
              WHERE NOT EXISTS (
                SELECT 1 FROM character_votes v
                 WHERE v.voter_id = ? AND v.target_source = ? AND v.target_key = ?)
             ON CONFLICT (target_source, target_key) DO UPDATE SET
               counts = ${INCREMENT},
               total = character_vote_aggregates.total + 1,
               updated_at = excluded.updated_at`,
          )
          .bind(
            p.source,
            p.key,
            JSON.stringify({ [p.name]: 1 }),
            nowIso,
            me,
            p.source,
            p.key,
            p.name,
            p.name,
          ),
      );

      statements.push(
        db
          .prepare(
            `INSERT INTO character_votes
               (id, voter_id, target_source, target_key, character_name, character_id, season, episode, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (voter_id, target_source, target_key) DO NOTHING`,
          )
          .bind(
            p.id,
            me,
            p.source,
            p.key,
            p.name,
            p.characterId,
            p.season,
            p.episode,
            p.createdAt,
          ),
      );
    }

    const results = await db.batch(statements);
    for (let n = 1; n < results.length; n += 2) imported += results[n]?.meta?.changes ?? 0;
  }

  return c.json({ imported, skipped: items.length - imported });
});

// ── GET /v1/character-votes — open, edge-cached ─────────────────────────────
//
// No auth, for the same reason `GET /v1/aggregates` has none: a percentage is
// public, and requiring a session would put a token on the one request a cache
// could otherwise answer for everybody at once.

characterVotes.get('/character-votes', async (c) => {
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: 'GET' });

  const hit = await cache.match(cacheKey);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set('X-Cache', 'HIT');
    return new Response(hit.body, { status: hit.status, headers });
  }

  const url = new URL(c.req.url);
  const source = url.searchParams.get('source');
  const key = url.searchParams.get('key');
  if (!isTargetSource(source) || !key) {
    return fail(c, 400, 'target_invalid', 'source and key are required.');
  }

  const row = await c.env.DB.prepare(
    'SELECT counts, total FROM character_vote_aggregates WHERE target_source = ? AND target_key = ?',
  )
    .bind(source, key)
    .first<{ counts: string | null; total: number }>();

  // A show nobody has voted on is an empty rollup, not a 404: the client
  // renders "no favourite yet", and a 404 would make it render an error.
  const res = c.json({ items: shapeCharacterCounts(row?.counts ?? null), total: row?.total ?? 0 });
  res.headers.set('Cache-Control', CACHE_CONTROL);
  res.headers.set('X-Cache', 'MISS');

  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});
