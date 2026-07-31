import type { Env } from '@/env';
import { mergeEmotionCounts } from '@/pure';

/**
 * The night shift. docs/IMPLEMENTATION.md Step 5 — maintenance.
 *
 * Three jobs, run from the 04:00 UTC cron: pull the counters that the request
 * paths are *allowed* to drift back onto the truth (5a), make soft-deleted
 * accounts stop existing (5b), and re-key `title` threads onto a real TheTVDB
 * id once something can tell us the mapping (5c — written, tested, fed nothing).
 *
 * Everything here is plain SQLite so the statements can be tested against a
 * real in-memory database without D1. Nothing in this file may import
 * `better-sqlite3`; that dependency is `test/jobs.test.ts`'s alone.
 */

/** One statement's worth of rows. The plan's 5,000; see `reconcileLikeCounts`. */
const BATCH = 5000;

// ── 5a · counter reconciliation ──────────────────────────────────────────────

export type ReconcileResult = { checked: number; corrected: number };

/**
 * `comments.like_count` from `comment_likes`, the plan's exact UPDATE: it
 * touches only rows where the stored counter disagrees with the like rows, so
 * `meta.changes` *is* the number of counters that were wrong.
 *
 * `checked` is deliberately the cheap definition — comments with a non-zero
 * counter **or** at least one like row — rather than "every comment". A corpus
 * where most comments have never been liked would otherwise report a
 * `rows_checked` that says nothing about the work done, and the pair
 * (checked, corrected) is only useful as a ratio.
 *
 * The batching is the plan's 5,000-row loop, expressed as `id IN (SELECT …
 * LIMIT ?)` rather than `UPDATE … LIMIT`: the latter needs a compile-time
 * SQLite option that neither D1 nor a stock `better-sqlite3` is guaranteed to
 * have. The loop terminates on its own, because a corrected row no longer
 * matches the predicate.
 */
export async function reconcileLikeCounts(db: D1Database): Promise<ReconcileResult> {
  const checkedRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM comments c
        WHERE c.like_count <> 0
           OR EXISTS (SELECT 1 FROM comment_likes l WHERE l.comment_id = c.id)`,
    )
    .first<{ n: number }>();
  const checked = checkedRow?.n ?? 0;

  let corrected = 0;
  for (;;) {
    const res = await db
      .prepare(
        `UPDATE comments SET like_count = (
           SELECT COUNT(*) FROM comment_likes WHERE comment_id = comments.id)
          WHERE id IN (
            SELECT c.id FROM comments c
             WHERE c.like_count <> (SELECT COUNT(*) FROM comment_likes l WHERE l.comment_id = c.id)
             LIMIT ?)`,
      )
      .bind(BATCH)
      .run();
    const n = res.meta.changes ?? 0;
    corrected += n;
    if (n < BATCH) break;
  }

  await writeCounterRepair(db, 'comments', checked, corrected);
  return { checked, corrected };
}

/**
 * `rating_aggregates` from `ratings`.
 *
 * One pass sets `vote_count`, `score_sum`, `emotion_counts` and `score_counts`
 * together, so a row that is wrong in two ways still counts as one corrected
 * row. `emotion_counts` is rebuilt with `json_group_object(emotion, n)` over a
 * `GROUP BY emotion` sub-select that skips NULL emotions — an empty set yields
 * `'{}'`, which is exactly what the write path stores for a vote with no
 * emotion, so a clean row never looks drifted.
 *
 * `score_counts` is rebuilt identically, `GROUP BY score` skipping NULL scores,
 * with a `CAST(score AS TEXT)` because `json_group_object` will not take an
 * integer as a label. THIS IS ALSO THE BACKFILL: 0004 added the column NULL for
 * every existing row because a distribution cannot be reconstructed from a sum,
 * and NULL counts as drift below, so the first run after that migration rebuilds
 * every one of them from `ratings` — which has each individual score — rather
 * than from a fabricated guess.
 *
 * **Recorded decision (the plan is silent):** an aggregate row whose key no
 * longer has a single vote is DELETED, not zeroed. Account deletion cascades
 * the `ratings` rows away and would otherwise leave a ghost `0 votes` row
 * behind that every read has to special-case, and that the 5c merge would then
 * merge. Ghosts go first, so a ghost is never counted as both updated and
 * deleted.
 */
export async function reconcileRatingAggregates(db: D1Database): Promise<ReconcileResult> {
  const checkedRow = await db
    .prepare('SELECT COUNT(*) AS n FROM rating_aggregates')
    .first<{ n: number }>();
  const checked = checkedRow?.n ?? 0;

  let corrected = 0;

  const ghosts = await db
    .prepare(
      `DELETE FROM rating_aggregates AS a
        WHERE NOT EXISTS (
          SELECT 1 FROM ratings r
           WHERE r.target_source = a.target_source AND r.target_key = a.target_key
             AND COALESCE(r.season, -1) = a.season AND COALESCE(r.episode, -1) = a.episode)`,
    )
    .run();
  corrected += ghosts.meta.changes ?? 0;

  const now = new Date().toISOString();
  for (;;) {
    const res = await db
      .prepare(
        `UPDATE rating_aggregates AS a SET
           vote_count = (SELECT COUNT(*) FROM ratings r
                          WHERE r.target_source = a.target_source AND r.target_key = a.target_key
                            AND COALESCE(r.season, -1) = a.season
                            AND COALESCE(r.episode, -1) = a.episode),
           score_sum  = (SELECT COALESCE(SUM(r.score), 0) FROM ratings r
                          WHERE r.target_source = a.target_source AND r.target_key = a.target_key
                            AND COALESCE(r.season, -1) = a.season
                            AND COALESCE(r.episode, -1) = a.episode),
           emotion_counts = (SELECT json_group_object(emotion, n) FROM (
                              SELECT r.emotion AS emotion, COUNT(*) AS n FROM ratings r
                               WHERE r.target_source = a.target_source
                                 AND r.target_key = a.target_key
                                 AND COALESCE(r.season, -1) = a.season
                                 AND COALESCE(r.episode, -1) = a.episode
                                 AND r.emotion IS NOT NULL
                               GROUP BY r.emotion)),
           score_counts = (SELECT json_group_object(score, n) FROM (
                              SELECT CAST(r.score AS TEXT) AS score, COUNT(*) AS n FROM ratings r
                               WHERE r.target_source = a.target_source
                                 AND r.target_key = a.target_key
                                 AND COALESCE(r.season, -1) = a.season
                                 AND COALESCE(r.episode, -1) = a.episode
                                 AND r.score IS NOT NULL
                               GROUP BY r.score)),
           updated_at = ?
         WHERE a.rowid IN (SELECT x.rowid FROM rating_aggregates x WHERE ${DRIFTED} LIMIT ?)`,
      )
      .bind(now, BATCH)
      .run();
    const n = res.meta.changes ?? 0;
    corrected += n;
    if (n < BATCH) break;
  }

  await writeCounterRepair(db, 'rating_aggregates', checked, corrected);
  return { checked, corrected };
}

/**
 * "This aggregate row disagrees with the votes underneath it", in one place so
 * the row picked for correction and the row that needed it can never diverge.
 * `IS NOT` rather than `<>` on the JSON, because a NULL `emotion_counts` on a
 * row that has emotions must count as drift and `<>` would answer NULL. The
 * same operator is what makes every pre-0004 row — `score_counts` NULL by
 * design — drifted on the first run, and therefore backfilled.
 */
const DRIFTED = `
  x.vote_count <> (SELECT COUNT(*) FROM ratings r
                    WHERE r.target_source = x.target_source AND r.target_key = x.target_key
                      AND COALESCE(r.season, -1) = x.season AND COALESCE(r.episode, -1) = x.episode)
  OR x.score_sum <> (SELECT COALESCE(SUM(r.score), 0) FROM ratings r
                    WHERE r.target_source = x.target_source AND r.target_key = x.target_key
                      AND COALESCE(r.season, -1) = x.season AND COALESCE(r.episode, -1) = x.episode)
  OR x.emotion_counts IS NOT (SELECT json_group_object(emotion, n) FROM (
                    SELECT r.emotion AS emotion, COUNT(*) AS n FROM ratings r
                     WHERE r.target_source = x.target_source AND r.target_key = x.target_key
                       AND COALESCE(r.season, -1) = x.season AND COALESCE(r.episode, -1) = x.episode
                       AND r.emotion IS NOT NULL
                     GROUP BY r.emotion))
  OR x.score_counts IS NOT (SELECT json_group_object(score, n) FROM (
                    SELECT CAST(r.score AS TEXT) AS score, COUNT(*) AS n FROM ratings r
                     WHERE r.target_source = x.target_source AND r.target_key = x.target_key
                       AND COALESCE(r.season, -1) = x.season AND COALESCE(r.episode, -1) = x.episode
                       AND r.score IS NOT NULL
                     GROUP BY r.score))`;

/**
 * `character_vote_aggregates` from `character_votes`.
 *
 * The same job as `reconcileRatingAggregates` and it exists for the same
 * reason: the rollup is written by delta on a request path that is allowed to
 * lose a race, and account deletion cascades votes away without touching it. A
 * favourite-character bar chart that slowly stops adding up is the failure this
 * prevents.
 *
 * `total` counts PEOPLE and is recounted as `COUNT(*)`, not as the sum of the
 * JSON counts — if the blob is what drifted, summing it would reconcile the
 * table against its own mistake.
 *
 * Ghost rows go first, exactly as they do for ratings: an aggregate whose votes
 * have all been cascaded away is deleted, not zeroed.
 */
export async function reconcileCharacterVoteAggregates(db: D1Database): Promise<ReconcileResult> {
  const checkedRow = await db
    .prepare('SELECT COUNT(*) AS n FROM character_vote_aggregates')
    .first<{ n: number }>();
  const checked = checkedRow?.n ?? 0;

  let corrected = 0;

  const ghosts = await db
    .prepare(
      `DELETE FROM character_vote_aggregates AS a
        WHERE NOT EXISTS (
          SELECT 1 FROM character_votes v
           WHERE v.target_source = a.target_source AND v.target_key = a.target_key)`,
    )
    .run();
  corrected += ghosts.meta.changes ?? 0;

  const now = new Date().toISOString();
  for (;;) {
    const res = await db
      .prepare(
        `UPDATE character_vote_aggregates AS a SET
           total = (SELECT COUNT(*) FROM character_votes v
                     WHERE v.target_source = a.target_source AND v.target_key = a.target_key),
           counts = (SELECT json_group_object(character_name, n) FROM (
                      SELECT v.character_name AS character_name, COUNT(*) AS n
                        FROM character_votes v
                       WHERE v.target_source = a.target_source AND v.target_key = a.target_key
                       GROUP BY v.character_name)),
           updated_at = ?
         WHERE a.rowid IN (
           SELECT x.rowid FROM character_vote_aggregates x WHERE ${CHARACTER_DRIFTED} LIMIT ?)`,
      )
      .bind(now, BATCH)
      .run();
    const n = res.meta.changes ?? 0;
    corrected += n;
    if (n < BATCH) break;
  }

  await writeCounterRepair(db, 'character_vote_aggregates', checked, corrected);
  return { checked, corrected };
}

/** Same shape as `DRIFTED`, same `IS NOT` on the JSON and for the same reason. */
const CHARACTER_DRIFTED = `
  x.total <> (SELECT COUNT(*) FROM character_votes v
               WHERE v.target_source = x.target_source AND v.target_key = x.target_key)
  OR x.counts IS NOT (SELECT json_group_object(character_name, n) FROM (
               SELECT v.character_name AS character_name, COUNT(*) AS n FROM character_votes v
                WHERE v.target_source = x.target_source AND v.target_key = x.target_key
                GROUP BY v.character_name))`;

/**
 * The audit row. `rows_corrected` is the number worth watching: consistently
 * zero means the write paths are correct, and a number that grows means a
 * handler is losing updates and this job is papering over it
 * (docs/IMPLEMENTATION.md Step 5a).
 */
async function writeCounterRepair(
  db: D1Database,
  table: string,
  checked: number,
  corrected: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO counter_repair (table_name, last_run_at, rows_checked, rows_corrected)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (table_name) DO UPDATE SET
         last_run_at = excluded.last_run_at,
         rows_checked = excluded.rows_checked,
         rows_corrected = excluded.rows_corrected`,
    )
    .bind(table, new Date().toISOString(), checked, corrected)
    .run();
}

// ── 5b · soft-delete purge ───────────────────────────────────────────────────

export type PurgeResult = { purged: number; skipped: string[] };

/**
 * Soft-deleted accounts stop existing at 30 days. The cascades take
 * `identities`, `follows`, `blocks`, `comments`, `comment_likes`, `ratings`,
 * `lists`, `list_items`, `notifications` and the reports they filed; at 30 days
 * the moderation queue is long since resolved, which is what makes the report
 * cascade acceptable here and not at deletion time.
 *
 * The trap: `moderation_actions.moderator_id` has no `ON DELETE` clause, so a
 * profile that ever moderated fails the whole DELETE on a foreign key. Those
 * ids are excluded and logged for manual handling — losing the audit trail is
 * not an option, and a moderator deleting their account is rare enough to be a
 * person's problem.
 */
export async function purgeSoftDeleted(db: D1Database, _env: Env): Promise<PurgeResult> {
  const due = `deleted_at IS NOT NULL AND deleted_at < datetime('now', '-30 days')`;

  const held = await db
    .prepare(
      `SELECT id, handle FROM profiles
        WHERE ${due} AND id IN (SELECT moderator_id FROM moderation_actions)`,
    )
    .all<{ id: string; handle: string }>();
  const skipped = (held.results ?? []).map((r) => r.id);
  if (skipped.length > 0) {
    console.warn(
      `[maintenance] purge held back ${skipped.length} moderator profile(s) — ` +
        `moderation_actions has no ON DELETE, so these need manual handling: ` +
        (held.results ?? []).map((r) => `${r.id} (@${r.handle})`).join(', '),
    );
  }

  const res = await db
    .prepare(
      `DELETE FROM profiles
        WHERE ${due} AND id NOT IN (SELECT moderator_id FROM moderation_actions)`,
    )
    .run();

  // R2 avatar sweep goes here — a `list()` over the avatar prefix diffed
  // against `SELECT avatar_key FROM profiles`, capped and paged. Not built:
  // there is no AVATARS binding yet, and `DELETE /v1/me` already deletes the
  // key it owns. Step 5b, "R2 avatars".

  return { purged: res.meta.changes ?? 0, skipped };
}

// ── 5c · title → tvdb thread migration ───────────────────────────────────────

export type ThreadMapping = { old_key: string; new_source: string; new_key: string };
export type MigrateResult = { comments: number; ratings: number; aggregates: number };

/** The countable half of a `rating_aggregates` row — everything a merge has to add up. */
type AggregateBlobs = {
  vote_count: number;
  score_sum: number;
  emotion_counts: string | null;
  score_counts: string | null;
};

/**
 * When a film that had no id gains a TheTVDB one, its threads sit on a `title`
 * key while new clients address it by `tvdb`, splitting the conversation. Three
 * UPDATEs put them back together.
 *
 * `comments` and `ratings` are straight re-keys. `rating_aggregates` is a
 * MERGE, not a rename, whenever the destination key already has a row: counts
 * and sums add, `emotion_counts` merges through `mergeEmotionCounts`, and the
 * source row is then deleted.
 *
 * Ratings re-key with `UPDATE OR IGNORE`: one person can hold a vote on both
 * keys, and `idx_one_vote_per_person` would abort the whole migration for that
 * mapping over a single duplicate. The `tvdb` vote — the newer, canonical one —
 * wins; the stranded `title` vote is left in place rather than silently
 * deleted, because deleting someone's rating to tidy an index is not this job's
 * call.
 *
 * **The mapping source is deferred**, not forgotten: nothing on the server
 * knows that `amado|2011` is now TheTVDB 428391, and both candidates (the app
 * reporting the change, or a TheTVDB search from this job) wait on the
 * commercial licence. See docs/IMPLEMENTATION.md Step 5c, "Decision deferred
 * until that licence is settled". This function is written and tested; only the
 * feed is missing.
 */
export async function migrateTitleThreads(
  db: D1Database,
  mapping: readonly ThreadMapping[],
): Promise<MigrateResult> {
  const out: MigrateResult = { comments: 0, ratings: 0, aggregates: 0 };

  for (const m of mapping) {
    const c = await db
      .prepare(
        `UPDATE comments SET target_source = ?, target_key = ?
          WHERE target_source = 'title' AND target_key = ?`,
      )
      .bind(m.new_source, m.new_key, m.old_key)
      .run();
    out.comments += c.meta.changes ?? 0;

    const r = await db
      .prepare(
        `UPDATE OR IGNORE ratings SET target_source = ?, target_key = ?
          WHERE target_source = 'title' AND target_key = ?`,
      )
      .bind(m.new_source, m.new_key, m.old_key)
      .run();
    out.ratings += r.meta.changes ?? 0;

    const sources = await db
      .prepare(
        `SELECT season, episode, vote_count, score_sum, emotion_counts, score_counts
           FROM rating_aggregates WHERE target_source = 'title' AND target_key = ?`,
      )
      .bind(m.old_key)
      .all<AggregateBlobs & { season: number; episode: number }>();

    for (const src of sources.results ?? []) {
      const dest = await db
        .prepare(
          `SELECT vote_count, score_sum, emotion_counts, score_counts FROM rating_aggregates
            WHERE target_source = ? AND target_key = ? AND season = ? AND episode = ?`,
        )
        .bind(m.new_source, m.new_key, src.season, src.episode)
        .first<AggregateBlobs>();

      if (dest) {
        await db.batch([
          db
            .prepare(
              `UPDATE rating_aggregates SET vote_count = ?, score_sum = ?,
                 emotion_counts = ?, score_counts = ?, updated_at = ?
                WHERE target_source = ? AND target_key = ? AND season = ? AND episode = ?`,
            )
            .bind(
              dest.vote_count + src.vote_count,
              dest.score_sum + src.score_sum,
              mergeEmotionCounts(dest.emotion_counts, src.emotion_counts),
              // Both distributions on this table merge by the same rule — the
              // function is about summing two counts blobs, not about emotions.
              // Dropping the source's here would throw away a distribution that
              // nothing could rebuild until 04:00.
              mergeEmotionCounts(dest.score_counts, src.score_counts),
              new Date().toISOString(),
              m.new_source,
              m.new_key,
              src.season,
              src.episode,
            ),
          db
            .prepare(
              `DELETE FROM rating_aggregates
                WHERE target_source = 'title' AND target_key = ? AND season = ? AND episode = ?`,
            )
            .bind(m.old_key, src.season, src.episode),
        ]);
      } else {
        await db
          .prepare(
            `UPDATE rating_aggregates SET target_source = ?, target_key = ?
              WHERE target_source = 'title' AND target_key = ? AND season = ? AND episode = ?`,
          )
          .bind(m.new_source, m.new_key, m.old_key, src.season, src.episode)
          .run();
      }
      out.aggregates += 1;
    }
  }

  return out;
}

// ── the cron entry point ─────────────────────────────────────────────────────

/**
 * Everything the 04:00 UTC cron does, in order. Each job is wrapped on its own:
 * a purge that trips over an unexpected foreign key must not stop the counter
 * reconciliation that runs after it, and a job that throws is a log line, not a
 * silent night.
 */
export async function runMaintenance(env: Env): Promise<void> {
  const started = Date.now();
  const db = env.DB;

  const likes = await step('reconcileLikeCounts', () => reconcileLikeCounts(db));
  const aggregates = await step('reconcileRatingAggregates', () => reconcileRatingAggregates(db));
  const characters = await step('reconcileCharacterVoteAggregates', () =>
    reconcileCharacterVoteAggregates(db),
  );
  const purge = await step('purgeSoftDeleted', () => purgeSoftDeleted(db, env));
  // Empty on purpose: the mechanism is proven, the mapping source is deferred
  // until the TheTVDB licence is settled (Step 5c, "Decision deferred").
  const migrated = await step('migrateTitleThreads', () => migrateTitleThreads(db, []));

  console.log(
    '[maintenance] done in ' +
      `${Date.now() - started}ms — likes ${likes?.corrected ?? '!'}/${likes?.checked ?? '!'} ` +
      `corrected, aggregates ${aggregates?.corrected ?? '!'}/${aggregates?.checked ?? '!'} ` +
      `corrected, characters ${characters?.corrected ?? '!'}/${characters?.checked ?? '!'} ` +
      `corrected, ${purge?.purged ?? '!'} profiles purged ` +
      `(${purge?.skipped.length ?? '!'} held back), ` +
      `${migrated?.comments ?? '!'} comments re-keyed`,
  );
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    console.error(`[maintenance] ${name} failed:`, err);
    return null;
  }
}
