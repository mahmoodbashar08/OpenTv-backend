import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import {
  migrateTitleThreads,
  purgeSoftDeleted,
  reconcileCharacterVoteAggregates,
  reconcileLikeCounts,
  reconcileRatingAggregates,
} from '@/jobs';
import { mergeEmotionCounts } from '@/pure';
import { freshDatabase, insertProfile } from './harness';

/**
 * docs/IMPLEMENTATION.md Step 5, "Unit tests": the reconcile statements are
 * plain SQLite, so they are tested against a real in-memory `better-sqlite3` —
 * a dev dependency of the tests only; nothing in `src/` may import it. The
 * harness loads the real migration files; see `test/harness.ts`.
 */

let raw: Database.Database;
let db: D1Database;

beforeEach(() => {
  ({ raw, db } = freshDatabase());
});

const profile = (id: string, handle: string, deletedAt: string | null = null) =>
  insertProfile(raw, id, handle, deletedAt);

function comment(id: string, author: string, likeCount: number, key = 'k1', source = 'tvdb') {
  raw
    .prepare(
      `INSERT INTO comments (id, author_id, target_source, target_key, body, like_count, created_at)
       VALUES (?, ?, ?, ?, 'hi', ?, '2026-07-01T00:00:00.000Z')`,
    )
    .run(id, author, source, key, likeCount);
}

function like(commentId: string, userId: string) {
  raw
    .prepare(
      `INSERT INTO comment_likes (comment_id, user_id, created_at)
       VALUES (?, ?, '2026-07-01T00:00:00.000Z')`,
    )
    .run(commentId, userId);
}

function rating(
  id: string,
  author: string,
  key: string,
  score: number | null,
  emotion: string | null,
  source = 'tvdb',
) {
  raw
    .prepare(
      `INSERT INTO ratings (id, author_id, target_source, target_key, score, created_at)
       VALUES (?, ?, ?, ?, ?, '2026-07-01T00:00:00.000Z')`,
    )
    .run(id, author, source, key, score);
  // A feeling is a row in its own table since 0005, never a column on the vote —
  // `ratings.emotion` is stranded NULL and nothing reads it any more. The helper
  // keeps the old call shape so these cases still read as "this person voted
  // this, feeling that".
  if (emotion !== null) feeling(author, key, emotion, source);
}

/** One selection. Several calls for one person on one target is the point of 0005. */
function feeling(author: string, key: string, emotion: string, source = 'tvdb') {
  raw
    .prepare(
      `INSERT INTO emotion_votes
         (author_id, target_source, target_key, season, episode, emotion, created_at)
       VALUES (?, ?, ?, -1, -1, ?, '2026-07-01T00:00:00.000Z')`,
    )
    .run(author, source, key, emotion);
}

function aggregate(
  source: string,
  key: string,
  votes: number,
  sum: number,
  emotions: string | null,
  // Defaults to NULL — the shape every row has the moment 0004 lands, and the
  // shape the reconciliation is expected to treat as drift and backfill.
  scores: string | null = null,
) {
  raw
    .prepare(
      `INSERT INTO rating_aggregates
         (target_source, target_key, season, episode, vote_count, score_sum, emotion_counts,
          score_counts, updated_at)
       VALUES (?, ?, -1, -1, ?, ?, ?, ?, '2026-07-01T00:00:00.000Z')`,
    )
    .run(source, key, votes, sum, emotions, scores);
}

const repair = (table: string) =>
  raw.prepare('SELECT * FROM counter_repair WHERE table_name = ?').get(table) as
    | { rows_checked: number; rows_corrected: number; last_run_at: string }
    | undefined;

// ── 5a · like counts ─────────────────────────────────────────────────────────

describe('reconcileLikeCounts', () => {
  it('pulls a wrong counter back to the truth and records the repair', async () => {
    profile('p1', 'mahmood');
    profile('p2', 'sara');
    comment('c1', 'p1', 99); // the lie
    like('c1', 'p1');
    like('c1', 'p2'); // the truth: 2

    const res = await reconcileLikeCounts(db);
    expect(res.corrected).toBe(1);
    expect(res.checked).toBe(1);
    expect(raw.prepare('SELECT like_count FROM comments WHERE id = ?').get('c1')).toEqual({
      like_count: 2,
    });

    const row = repair('comments');
    expect(row?.rows_corrected).toBe(1);
    expect(row?.rows_checked).toBe(1);
  });

  it('corrects nothing on a second pass — a zero here is the healthy number', async () => {
    profile('p1', 'mahmood');
    comment('c1', 'p1', 99);
    like('c1', 'p1');

    await reconcileLikeCounts(db);
    const again = await reconcileLikeCounts(db);
    expect(again.corrected).toBe(0);
    expect(repair('comments')?.rows_corrected).toBe(0);
  });

  it('leaves a correct counter — and a never-liked comment — alone', async () => {
    profile('p1', 'mahmood');
    comment('c1', 'p1', 1);
    like('c1', 'p1');
    comment('c2', 'p1', 0); // no likes, correct counter: not even counted as checked

    const res = await reconcileLikeCounts(db);
    expect(res).toEqual({ checked: 1, corrected: 0 });
  });
});

// ── 5a · rating aggregates ───────────────────────────────────────────────────

describe('reconcileRatingAggregates', () => {
  it('fixes the sum, rebuilds the emotions, and deletes the ghost row', async () => {
    profile('p1', 'mahmood');
    profile('p2', 'sara');
    profile('p3', 'ali');

    rating('r1', 'p1', '111', 9, 'touched');
    rating('r2', 'p2', '111', 7, 'touched');
    rating('r3', 'p3', '111', null, null); // emotion-less, score-less rows still count as people
    aggregate('tvdb', '111', 2, 99, '{"shocked":5}'); // wrong count, wrong sum, stale json

    // Every vote behind this one was cascaded away by an account deletion.
    aggregate('tvdb', '222', 4, 30, '{"sad":4}');

    const res = await reconcileRatingAggregates(db);
    expect(res.checked).toBe(2);
    expect(res.corrected).toBe(2); // one updated, one ghost deleted

    const fixed = raw
      .prepare('SELECT vote_count, score_sum, emotion_counts FROM rating_aggregates WHERE target_key = ?')
      .get('111');
    expect(fixed).toEqual({ vote_count: 3, score_sum: 16, emotion_counts: '{"touched":2}' });

    expect(
      raw.prepare('SELECT COUNT(*) AS n FROM rating_aggregates WHERE target_key = ?').get('222'),
    ).toEqual({ n: 0 });

    const row = repair('rating_aggregates');
    expect(row?.rows_corrected).toBe(2);
    expect(row?.rows_checked).toBe(2);
  });

  it('is idempotent, and writes {} where the write path would', async () => {
    profile('p1', 'mahmood');
    rating('r1', 'p1', '111', 8, null);
    aggregate('tvdb', '111', 1, 8, '{}', '{"8":1}');

    const first = await reconcileRatingAggregates(db);
    expect(first.corrected).toBe(0); // already true — nothing to do

    const again = await reconcileRatingAggregates(db);
    expect(again.corrected).toBe(0);
    expect(
      raw
        .prepare('SELECT emotion_counts, score_counts FROM rating_aggregates WHERE target_key = ?')
        .get('111'),
    ).toEqual({ emotion_counts: '{}', score_counts: '{"8":1}' });
  });

  it('counts a NULL emotion_counts over real emotions as drift', async () => {
    profile('p1', 'mahmood');
    rating('r1', 'p1', '111', null, 'scared');
    aggregate('tvdb', '111', 1, 0, null, '{}');

    expect((await reconcileRatingAggregates(db)).corrected).toBe(1);
    expect(
      raw.prepare('SELECT emotion_counts FROM rating_aggregates WHERE target_key = ?').get('111'),
    ).toEqual({ emotion_counts: '{"scared":1}' });
  });

  // ── score_counts · migrations/0004_score_distribution.sql ──────────────────
  //
  // THIS IS THE BACKFILL. 0004 could not reconstruct a distribution from a sum
  // and a count, so it left the column NULL and left the rebuild here. If these
  // two stop passing, every row that existed before that migration keeps a NULL
  // forever and the star bars stay blank for the whole back catalogue.

  it('rebuilds a NULL score_counts from ratings — the 0004 backfill path', async () => {
    profile('p1', 'mahmood');
    profile('p2', 'sara');
    profile('p3', 'ali');

    rating('r1', 'p1', '111', 10, null);
    rating('r2', 'p2', '111', 10, 'touched');
    rating('r3', 'p3', '111', 6, null);
    // A pre-0004 row: the sum and the count are right, the distribution has
    // never been written. {10,10,6} and {9,9,8} are the same sum over the same
    // count, which is exactly why the migration refused to guess.
    aggregate('tvdb', '111', 3, 26, '{"touched":1}');

    expect((await reconcileRatingAggregates(db)).corrected).toBe(1);
    expect(
      raw.prepare('SELECT score_counts FROM rating_aggregates WHERE target_key = ?').get('111'),
    ).toEqual({ score_counts: '{"6":1,"10":2}' });
  });

  it('corrects a score_counts that is simply wrong, and skips NULL scores', async () => {
    profile('p1', 'mahmood');
    profile('p2', 'sara');

    rating('r1', 'p1', '111', 8, null);
    rating('r2', 'p2', '111', null, 'bored'); // a person, but not a score

    aggregate('tvdb', '111', 2, 8, '{"bored":1}', '{"8":9,"2":4}'); // deliberately wrong

    expect((await reconcileRatingAggregates(db)).corrected).toBe(1);
    expect(
      raw.prepare('SELECT score_counts FROM rating_aggregates WHERE target_key = ?').get('111'),
    ).toEqual({ score_counts: '{"8":1}' });
  });

  it('writes {} where nobody scored, so a clean row never looks drifted', async () => {
    profile('p1', 'mahmood');
    rating('r1', 'p1', '111', null, 'confused');
    aggregate('tvdb', '111', 1, 0, '{"confused":1}');

    expect((await reconcileRatingAggregates(db)).corrected).toBe(1); // the NULL
    expect(
      raw.prepare('SELECT score_counts FROM rating_aggregates WHERE target_key = ?').get('111'),
    ).toEqual({ score_counts: '{}' });
    expect((await reconcileRatingAggregates(db)).corrected).toBe(0); // and stays put
  });
});

// ── 5a · character vote aggregates ───────────────────────────────────────────

describe('reconcileCharacterVoteAggregates', () => {
  function characterVote(id: string, voter: string, key: string, name: string, source = 'tvdb') {
    raw
      .prepare(
        `INSERT INTO character_votes
           (id, voter_id, target_source, target_key, character_name, created_at)
         VALUES (?, ?, ?, ?, ?, '2026-07-01T00:00:00.000Z')`,
      )
      .run(id, voter, source, key, name);
  }

  function characterAggregate(key: string, counts: string | null, total: number, source = 'tvdb') {
    raw
      .prepare(
        `INSERT INTO character_vote_aggregates (target_source, target_key, counts, total, updated_at)
         VALUES (?, ?, ?, ?, '2026-07-01T00:00:00.000Z')`,
      )
      .run(source, key, counts, total);
  }

  const agg = (key: string) =>
    raw
      .prepare('SELECT counts, total FROM character_vote_aggregates WHERE target_key = ?')
      .get(key) as { counts: string; total: number } | undefined;

  it('rebuilds a drifted blob, fixes the total, and deletes the ghost row', async () => {
    profile('p1', 'mahmood');
    profile('p2', 'sara');
    profile('p3', 'ali');

    characterVote('v1', 'p1', '121361', 'Tyrion Lannister');
    characterVote('v2', 'p2', '121361', 'Tyrion Lannister');
    characterVote('v3', 'p3', '121361', 'Arya Stark');
    characterAggregate('121361', '{"Tyrion Lannister":9}', 99); // the lie

    // Every vote behind this one was cascaded away by an account deletion.
    characterAggregate('999', '{"Nobody":4}', 4);

    const res = await reconcileCharacterVoteAggregates(db);
    expect(res.checked).toBe(2);
    expect(res.corrected).toBe(2); // one updated, one ghost deleted

    expect(agg('121361')).toEqual({
      counts: '{"Arya Stark":1,"Tyrion Lannister":2}',
      total: 3,
    });
    expect(agg('999')).toBeUndefined();

    const row = repair('character_vote_aggregates');
    expect(row?.rows_corrected).toBe(2);
    expect(row?.rows_checked).toBe(2);
  });

  it('corrects nothing on a second pass — a zero here is the healthy number', async () => {
    profile('p1', 'mahmood');
    characterVote('v1', 'p1', '121361', 'Arya Stark');
    characterAggregate('121361', '{"Arya Stark":1}', 1);

    expect((await reconcileCharacterVoteAggregates(db)).corrected).toBe(0);
    expect((await reconcileCharacterVoteAggregates(db)).corrected).toBe(0);
  });

  it('counts a NULL counts blob over real votes as drift', async () => {
    profile('p1', 'mahmood');
    characterVote('v1', 'p1', '121361', 'Arya Stark');
    characterAggregate('121361', null, 1);

    expect((await reconcileCharacterVoteAggregates(db)).corrected).toBe(1);
    expect(agg('121361')?.counts).toBe('{"Arya Stark":1}');
  });

  it('recounts total from the votes, not from the sum of a blob that may be the thing that drifted', async () => {
    profile('p1', 'mahmood');
    profile('p2', 'sara');
    characterVote('v1', 'p1', '121361', 'Arya Stark');
    characterVote('v2', 'p2', '121361', 'Arya Stark');
    characterAggregate('121361', '{"Arya Stark":500}', 500);

    await reconcileCharacterVoteAggregates(db);
    expect(agg('121361')).toEqual({ counts: '{"Arya Stark":2}', total: 2 });
  });
});

// ── 5b · purge ───────────────────────────────────────────────────────────────

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('purgeSoftDeleted', () => {
  const env = {} as Env;

  it('takes a 31-day-old deletion and everything that hangs off it', async () => {
    profile('gone', 'gone', daysAgo(31));
    profile('stays', 'stays');
    raw
      .prepare(
        `INSERT INTO identities (provider, external_id, profile_id, created_at)
         VALUES ('apple', 'x', 'gone', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    comment('c1', 'gone', 0);
    raw
      .prepare(
        `INSERT INTO follows (follower_id, followee_id, created_at)
         VALUES ('gone', 'stays', '2026-01-01T00:00:00.000Z')`,
      )
      .run();

    const res = await purgeSoftDeleted(db, env);
    expect(res).toEqual({ purged: 1, skipped: [] });

    const count = (t: string) =>
      (raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(count('profiles')).toBe(1);
    expect(count('identities')).toBe(0);
    expect(count('comments')).toBe(0);
    expect(count('follows')).toBe(0);
  });

  it('leaves a 29-day-old deletion alone — the window is 30 days, not "soon"', async () => {
    profile('recent', 'recent', daysAgo(29));
    expect((await purgeSoftDeleted(db, env)).purged).toBe(0);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM profiles').get()).toEqual({ n: 1 });
  });

  it('holds back a moderator and says whose desk it lands on', async () => {
    profile('mod', 'mod', daysAgo(31));
    profile('victim', 'victim');
    raw
      .prepare(
        `INSERT INTO moderation_actions
           (id, moderator_id, action, target_type, target_id, created_at)
         VALUES ('m1', 'mod', 'hide', 'comment', 'c9', '2026-02-01T00:00:00.000Z')`,
      )
      .run();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await purgeSoftDeleted(db, env);
    expect(res.purged).toBe(0);
    expect(res.skipped).toEqual(['mod']);
    expect(warn.mock.calls[0]?.[0]).toContain('mod');
    warn.mockRestore();

    // The audit trail survives, which is the entire point of the exclusion.
    expect(raw.prepare('SELECT COUNT(*) AS n FROM moderation_actions').get()).toEqual({ n: 1 });
  });
});

// ── 5c · title → tvdb migration ──────────────────────────────────────────────

describe('migrateTitleThreads', () => {
  it('re-keys comments and ratings and MERGES the aggregate into the existing tvdb row', async () => {
    profile('p1', 'mahmood');
    profile('p2', 'sara');

    comment('c1', 'p1', 0, 'amado|2011', 'title');
    comment('c2', 'p2', 0, 'amado|2011', 'title');
    comment('c3', 'p1', 0, 'other|1999', 'title'); // untouched

    rating('r1', 'p1', 'amado|2011', 9, 'touched', 'title');
    aggregate('title', 'amado|2011', 1, 9, '{"touched":1,"shocked":2}', '{"9":1}');

    rating('r2', 'p2', '428391', 8, 'touched');
    aggregate('tvdb', '428391', 1, 8, '{"touched":1}', '{"8":1,"9":2}');

    const res = await migrateTitleThreads(db, [
      { old_key: 'amado|2011', new_source: 'tvdb', new_key: '428391' },
    ]);
    // p1's feeling moves with their rating: one row re-keyed, one merged blob.
    expect(res).toEqual({ comments: 2, ratings: 1, emotions: 1, aggregates: 1 });
    expect(
      raw
        .prepare(
          `SELECT COUNT(*) AS n FROM emotion_votes
            WHERE target_source = 'tvdb' AND target_key = '428391'`,
        )
        .get(),
    ).toEqual({ n: 2 });

    expect(
      raw
        .prepare(
          `SELECT COUNT(*) AS n FROM comments WHERE target_source = 'tvdb' AND target_key = '428391'`,
        )
        .get(),
    ).toEqual({ n: 2 });
    expect(
      raw.prepare(`SELECT COUNT(*) AS n FROM comments WHERE target_source = 'title'`).get(),
    ).toEqual({ n: 1 }); // other|1999

    expect(
      raw.prepare(`SELECT target_source, target_key FROM ratings WHERE id = 'r1'`).get(),
    ).toEqual({ target_source: 'tvdb', target_key: '428391' });

    const merged = raw
      .prepare(
        `SELECT vote_count, score_sum, emotion_counts, score_counts FROM rating_aggregates
          WHERE target_source = 'tvdb' AND target_key = '428391'`,
      )
      .get();
    expect(merged).toEqual({
      vote_count: 2,
      score_sum: 17,
      emotion_counts: '{"touched":2,"shocked":2}',
      // Both distributions merge; dropping the source's would throw away a
      // spread nothing could rebuild until the next 04:00 run.
      score_counts: '{"8":1,"9":3}',
    });

    // The source row is gone, not left behind as a second half of the thread.
    expect(
      raw.prepare(`SELECT COUNT(*) AS n FROM rating_aggregates WHERE target_source = 'title'`).get(),
    ).toEqual({ n: 0 });
  });

  it('renames the aggregate when the destination has no row yet', async () => {
    profile('p1', 'mahmood');
    rating('r1', 'p1', 'amado|2011', 9, null, 'title');
    aggregate('title', 'amado|2011', 1, 9, '{}');

    await migrateTitleThreads(db, [
      { old_key: 'amado|2011', new_source: 'tvdb', new_key: '428391' },
    ]);
    expect(
      raw
        .prepare(
          `SELECT vote_count, score_sum FROM rating_aggregates
            WHERE target_source = 'tvdb' AND target_key = '428391'`,
        )
        .get(),
    ).toEqual({ vote_count: 1, score_sum: 9 });
  });

  it('keeps the canonical vote when one person voted on both keys, instead of aborting', async () => {
    profile('p1', 'mahmood');
    rating('r1', 'p1', 'amado|2011', 4, null, 'title');
    rating('r2', 'p1', '428391', 9, null);

    const res = await migrateTitleThreads(db, [
      { old_key: 'amado|2011', new_source: 'tvdb', new_key: '428391' },
    ]);
    expect(res.ratings).toBe(0); // OR IGNORE: the tvdb vote wins
    expect(raw.prepare(`SELECT score FROM ratings WHERE id = 'r2'`).get()).toEqual({ score: 9 });
    expect(raw.prepare(`SELECT target_source FROM ratings WHERE id = 'r1'`).get()).toEqual({
      target_source: 'title',
    });
  });

  it('is a no-op on the empty mapping it actually ships with', async () => {
    profile('p1', 'mahmood');
    comment('c1', 'p1', 0, 'amado|2011', 'title');
    expect(await migrateTitleThreads(db, [])).toEqual({
      comments: 0,
      ratings: 0,
      emotions: 0,
      aggregates: 0,
    });
    expect(raw.prepare(`SELECT target_source FROM comments WHERE id = 'c1'`).get()).toEqual({
      target_source: 'title',
    });
  });
});

// ── mergeEmotionCounts ───────────────────────────────────────────────────────

describe('mergeEmotionCounts', () => {
  it('sums shared keys and keeps the rest', () => {
    expect(mergeEmotionCounts('{"touched":2,"shocked":1}', '{"touched":3,"sad":1}')).toBe(
      '{"touched":5,"shocked":1,"sad":1}',
    );
  });

  it('treats null, empty and malformed sides as nothing', () => {
    expect(mergeEmotionCounts(null, null)).toBe('{}');
    expect(mergeEmotionCounts('{"touched":1}', null)).toBe('{"touched":1}');
    expect(mergeEmotionCounts(null, '{"touched":1}')).toBe('{"touched":1}');
    expect(mergeEmotionCounts('{}', '{"touched":1}')).toBe('{"touched":1}');
    expect(mergeEmotionCounts('not json', '{"touched":1}')).toBe('{"touched":1}');
    expect(mergeEmotionCounts('[1,2]', '{"touched":1}')).toBe('{"touched":1}');
  });

  it('drops the zeroed keys the write path leaves behind', () => {
    expect(mergeEmotionCounts('{"touched":0,"shocked":2}', '{"sad":-1}')).toBe('{"shocked":2}');
  });
});
