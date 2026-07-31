import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import {
  migrateTitleThreads,
  purgeSoftDeleted,
  reconcileLikeCounts,
  reconcileRatingAggregates,
} from '@/jobs';
import { mergeEmotionCounts } from '@/pure';

/**
 * docs/IMPLEMENTATION.md Step 5, "Unit tests": the reconcile statements are
 * plain SQLite, so they are tested against a real in-memory `better-sqlite3` —
 * a dev dependency of the tests only; nothing in `src/` may import it.
 *
 * The schema is READ FROM THE MIGRATION FILES, never restated here. A copied
 * schema drifts from the real one the first time a migration lands, and a test
 * that passes against a schema production does not have is worse than no test.
 */

const MIGRATIONS = ['../migrations/0001_initial.sql', '../migrations/0002_comment_hidden.sql'].map(
  (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'),
);

/**
 * The smallest honest D1 shim: `prepare().bind().run()/all()/first()` with
 * `meta.changes`, which is the whole surface `src/jobs.ts` uses. Synchronous
 * underneath, async on the outside, exactly as D1 presents itself.
 */
function d1(db: Database.Database): D1Database {
  const prepare = (sql: string, binds: unknown[] = []): D1PreparedStatement => {
    const stmt = () => db.prepare(sql);
    const api = {
      bind: (...values: unknown[]) => prepare(sql, values),
      async run() {
        const info = stmt().run(...(binds as never[]));
        return { success: true, meta: { changes: info.changes } };
      },
      async all() {
        return { success: true, results: stmt().all(...(binds as never[])), meta: {} };
      },
      async first(col?: string) {
        const row = stmt().get(...(binds as never[])) as Record<string, unknown> | undefined;
        if (!row) return null;
        return col === undefined ? row : (row[col] ?? null);
      },
      async raw() {
        return [];
      },
    };
    return api as unknown as D1PreparedStatement;
  };

  const api = {
    prepare: (sql: string) => prepare(sql),
    async batch(stmts: D1PreparedStatement[]) {
      const out = [];
      for (const s of stmts) out.push(await (s as unknown as { run(): Promise<unknown> }).run());
      return out;
    },
  };
  return api as unknown as D1Database;
}

let raw: Database.Database;
let db: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  for (const sql of MIGRATIONS) raw.exec(sql);
  db = d1(raw);
});

function profile(id: string, handle: string, deletedAt: string | null = null) {
  raw
    .prepare(
      `INSERT INTO profiles (id, handle, handle_lower, created_at, deleted_at)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(id, handle, handle.toLowerCase(), deletedAt);
}

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
      `INSERT INTO ratings (id, author_id, target_source, target_key, score, emotion, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '2026-07-01T00:00:00.000Z')`,
    )
    .run(id, author, source, key, score, emotion);
}

function aggregate(
  source: string,
  key: string,
  votes: number,
  sum: number,
  emotions: string | null,
) {
  raw
    .prepare(
      `INSERT INTO rating_aggregates
         (target_source, target_key, season, episode, vote_count, score_sum, emotion_counts, updated_at)
       VALUES (?, ?, -1, -1, ?, ?, ?, '2026-07-01T00:00:00.000Z')`,
    )
    .run(source, key, votes, sum, emotions);
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
    aggregate('tvdb', '111', 1, 8, '{}');

    const first = await reconcileRatingAggregates(db);
    expect(first.corrected).toBe(0); // already true — nothing to do

    const again = await reconcileRatingAggregates(db);
    expect(again.corrected).toBe(0);
    expect(
      raw.prepare('SELECT emotion_counts FROM rating_aggregates WHERE target_key = ?').get('111'),
    ).toEqual({ emotion_counts: '{}' });
  });

  it('counts a NULL emotion_counts over real emotions as drift', async () => {
    profile('p1', 'mahmood');
    rating('r1', 'p1', '111', null, 'scared');
    aggregate('tvdb', '111', 1, 0, null);

    expect((await reconcileRatingAggregates(db)).corrected).toBe(1);
    expect(
      raw.prepare('SELECT emotion_counts FROM rating_aggregates WHERE target_key = ?').get('111'),
    ).toEqual({ emotion_counts: '{"scared":1}' });
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
    aggregate('title', 'amado|2011', 1, 9, '{"touched":1,"shocked":2}');

    rating('r2', 'p2', '428391', 8, 'touched');
    aggregate('tvdb', '428391', 1, 8, '{"touched":1}');

    const res = await migrateTitleThreads(db, [
      { old_key: 'amado|2011', new_source: 'tvdb', new_key: '428391' },
    ]);
    expect(res).toEqual({ comments: 2, ratings: 1, aggregates: 1 });

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
        `SELECT vote_count, score_sum, emotion_counts FROM rating_aggregates
          WHERE target_source = 'tvdb' AND target_key = '428391'`,
      )
      .get();
    expect(merged).toEqual({ vote_count: 2, score_sum: 17, emotion_counts: '{"touched":2,"shocked":2}' });

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
