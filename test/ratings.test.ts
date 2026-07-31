import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import {
  aggregateDelta,
  EMOTIONS,
  MAX_TARGETS,
  parseTargets,
  SCORE_MAX,
  SCORE_MIN,
  validateVote,
} from '@/pure';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * docs/IMPLEMENTATION.md Step 2, "Unit tests". The delta table is the contract
 * between a vote and every percentage anybody ever sees; it gets a row-for-row
 * test, plus the two cases the table leaves implicit.
 */

describe('aggregateDelta — the six rows of the table', () => {
  it('new vote with a score: +1 vote, +score, no emotion to move', () => {
    expect(aggregateDelta(null, { score: 9, emotion: null })).toEqual({
      dVotes: 1,
      dScore: 9,
      emotionFrom: null,
      emotionTo: null,
      scoreFrom: null,
      scoreTo: 9,
    });
  });

  it('new vote with a score and an emotion', () => {
    expect(aggregateDelta(null, { score: 9, emotion: 'touched' })).toEqual({
      dVotes: 1,
      dScore: 9,
      emotionFrom: null,
      emotionTo: 'touched',
      scoreFrom: null,
      scoreTo: 9,
    });
  });

  it('new vote, emotion only: still counts as a person', () => {
    expect(aggregateDelta(null, { score: null, emotion: 'touched' })).toEqual({
      dVotes: 1,
      dScore: 0,
      emotionFrom: null,
      emotionTo: 'touched',
      scoreFrom: null,
      scoreTo: null,
    });
  });

  it('changed score 7 → 9: no new person, +2', () => {
    const d = aggregateDelta({ score: 7, emotion: 'touched' }, { score: 9, emotion: 'touched' });
    expect(d).toEqual({
      dVotes: 0,
      dScore: 2,
      emotionFrom: 'touched',
      emotionTo: 'touched',
      scoreFrom: 7,
      scoreTo: 9,
    });
    // from === to, so the caller skips the emotion clause entirely.
    expect(d.emotionFrom).toBe(d.emotionTo);
  });

  it('score added to an emotion-only vote', () => {
    expect(aggregateDelta({ score: null, emotion: 'sad' }, { score: 8, emotion: 'sad' })).toEqual({
      dVotes: 0,
      dScore: 8,
      emotionFrom: 'sad',
      emotionTo: 'sad',
      scoreFrom: null,
      scoreTo: 8,
    });
  });

  it('score removed: -prev.score, person stays counted', () => {
    expect(aggregateDelta({ score: 8, emotion: 'sad' }, { score: null, emotion: 'sad' })).toEqual({
      dVotes: 0,
      dScore: -8,
      emotionFrom: 'sad',
      emotionTo: 'sad',
      scoreFrom: 8,
      scoreTo: null,
    });
  });

  it('emotion changed only', () => {
    expect(aggregateDelta({ score: 9, emotion: 'touched' }, { score: 9, emotion: 'frustrated' })).toEqual({
      dVotes: 0,
      dScore: 0,
      emotionFrom: 'touched',
      emotionTo: 'frustrated',
      scoreFrom: 9,
      scoreTo: 9,
    });
  });
});

describe('aggregateDelta — the cases the table leaves implicit', () => {
  it('emotion-only → score-only clears the emotion (decrement, no increment)', () => {
    const d = aggregateDelta({ score: null, emotion: 'touched' }, { score: 7, emotion: null });
    expect(d).toEqual({
      dVotes: 0,
      dScore: 7,
      emotionFrom: 'touched',
      emotionTo: null,
      scoreFrom: null,
      scoreTo: 7,
    });
    expect(d.emotionFrom).not.toBe(d.emotionTo); // the clause runs, half of it
  });

  it('an identical re-vote moves nothing at all', () => {
    const d = aggregateDelta({ score: 7, emotion: 'amused' }, { score: 7, emotion: 'amused' });
    expect(d).toEqual({
      dVotes: 0,
      dScore: 0,
      emotionFrom: 'amused',
      emotionTo: 'amused',
      scoreFrom: 7,
      scoreTo: 7,
    });
    // from === to on BOTH blobs, so neither json_set clause is emitted at all.
    expect(d.scoreFrom).toBe(d.scoreTo);
  });
});

describe('validateVote', () => {
  it('accepts a score with an emotion', () => {
    const r = validateVote({ score: 9, emotion: 'touched', season: 1, episode: 3 });
    expect(r).toEqual({ ok: true, vote: { score: 9, emotion: 'touched', season: 1, episode: 3 } });
  });

  it('accepts a show-level vote with no season or episode', () => {
    const r = validateVote({ score: 10 });
    expect(r.ok && r.vote).toEqual({ score: 10, emotion: null, season: null, episode: null });
  });

  it('rejects score 0 and score 11 before any SQL is prepared', () => {
    expect(validateVote({ score: 0, emotion: 'touched' })).toEqual({ ok: false, reason: 'score_invalid' });
    expect(validateVote({ score: 11 })).toEqual({ ok: false, reason: 'score_invalid' });
  });

  it('rejects a non-integer score', () => {
    expect(validateVote({ score: 8.5 })).toEqual({ ok: false, reason: 'score_invalid' });
    expect(validateVote({ score: '9' })).toEqual({ ok: false, reason: 'score_invalid' });
  });

  it('rejects an emotion outside the allow-list — it becomes a JSON path', () => {
    expect(validateVote({ emotion: 'shock' })).toEqual({ ok: false, reason: 'emotion_invalid' });
    expect(validateVote({ emotion: "love'] , '$.x" })).toEqual({ ok: false, reason: 'emotion_invalid' });
  });

  it('accepts every emotion on the list', () => {
    for (const e of EMOTIONS) expect(validateVote({ emotion: e }).ok).toBe(true);
  });

  it('rejects a vote that says nothing', () => {
    expect(validateVote({})).toEqual({ ok: false, reason: 'empty_vote' });
    expect(validateVote({ score: null, emotion: null })).toEqual({ ok: false, reason: 'empty_vote' });
  });

  it('rejects negative or fractional season and episode', () => {
    expect(validateVote({ score: 5, season: -1 })).toEqual({ ok: false, reason: 'season_invalid' });
    expect(validateVote({ score: 5, season: 1, episode: 1.5 })).toEqual({
      ok: false,
      reason: 'episode_invalid',
    });
  });

  it('rejects an episode with no season', () => {
    expect(validateVote({ score: 5, episode: 3 })).toEqual({
      ok: false,
      reason: 'episode_without_season',
    });
  });

  it('allows season 0 — specials are a season', () => {
    expect(validateVote({ score: 5, season: 0, episode: 0 }).ok).toBe(true);
  });
});

describe('parseTargets', () => {
  it('parses a single show target', () => {
    expect(parseTargets(['tvdb:121361'])).toEqual([
      { source: 'tvdb', key: '121361', season: -1, episode: -1 },
    ]);
  });

  it('parses season and episode', () => {
    expect(parseTargets(['tvdb:121361:1:3'])).toEqual([
      { source: 'tvdb', key: '121361', season: 1, episode: 3 },
    ]);
  });

  it('keeps the literal | in a title key', () => {
    expect(parseTargets(['title:amado|2011'])).toEqual([
      { source: 'title', key: 'amado|2011', season: -1, episode: -1 },
    ]);
  });

  it('does not mistake a year for a season: title:1917|2019 has no colon after the source', () => {
    // The ambiguity the parsing rule exists for. The key ends in digits, but
    // season/episode are only split off when there are ≥2 colons in the
    // remainder AND both trailing segments are digits. Here there are none.
    expect(parseTargets(['title:1917|2019'])).toEqual([
      { source: 'title', key: '1917|2019', season: -1, episode: -1 },
    ]);
  });

  it('splits a title target that does carry a season and episode', () => {
    expect(parseTargets(['title:1917|2019:2:5'])).toEqual([
      { source: 'title', key: '1917|2019', season: 2, episode: 5 },
    ]);
  });

  it('parses a mixed list', () => {
    expect(parseTargets(['title:amado|2011', 'tvdb:121361', 'tmdb:603:1:1'])).toEqual([
      { source: 'title', key: 'amado|2011', season: -1, episode: -1 },
      { source: 'tvdb', key: '121361', season: -1, episode: -1 },
      { source: 'tmdb', key: '603', season: 1, episode: 1 },
    ]);
  });

  it('caps at 100', () => {
    const hundred = Array.from({ length: MAX_TARGETS }, (_, i) => `tvdb:${i}`);
    expect(parseTargets(hundred)).toHaveLength(MAX_TARGETS);
    expect(parseTargets([...hundred, 'tvdb:101'])).toBeNull();
  });

  it('rejects an empty list', () => {
    expect(parseTargets([])).toBeNull();
  });

  it('rejects malformed members — one bad target poisons the call', () => {
    expect(parseTargets(['121361'])).toBeNull(); // no source
    expect(parseTargets([':121361'])).toBeNull(); // empty source
    expect(parseTargets(['tvdb:'])).toBeNull(); // empty key
    expect(parseTargets(['imdb:tt123'])).toBeNull(); // unknown source
    expect(parseTargets(['tvdb:121361:1'])).toBeNull(); // half a pair
    expect(parseTargets(['tvdb:121361:one:two'])).toBeNull(); // not digits
    expect(parseTargets(['tvdb:121361', 'nonsense'])).toBeNull(); // one bad member
  });
});

// ── the score distribution ───────────────────────────────────────────────────
//
// migrations/0004_score_distribution.sql. `score_sum` and `vote_count` yield a
// mean and nothing else; the product's own reference screen wants a percentage
// per star. These are the cases that move a bucket, and the ones that must not.

describe('aggregateDelta — the score bucket', () => {
  it('a new scored vote opens a bucket and decrements none', () => {
    const d = aggregateDelta(null, { score: 10, emotion: null });
    expect(d.scoreFrom).toBeNull();
    expect(d.scoreTo).toBe(10);
  });

  it('a changed score moves the bucket, 10 → 8', () => {
    const d = aggregateDelta({ score: 10, emotion: null }, { score: 8, emotion: null });
    expect(d.scoreFrom).toBe(10);
    expect(d.scoreTo).toBe(8);
  });

  it('a removed score decrements and opens nothing', () => {
    const d = aggregateDelta({ score: 6, emotion: 'sad' }, { score: null, emotion: 'sad' });
    expect(d.scoreFrom).toBe(6);
    expect(d.scoreTo).toBeNull();
  });

  it('an emotion-only vote moves no bucket at all', () => {
    const d = aggregateDelta(null, { score: null, emotion: 'thrilled' });
    expect(d.scoreFrom).toBeNull();
    expect(d.scoreTo).toBeNull();
    expect(d.scoreFrom).toBe(d.scoreTo); // the caller skips the clause entirely
  });

  it('an emotion change over a steady score moves no bucket', () => {
    const d = aggregateDelta({ score: 4, emotion: 'bored' }, { score: 4, emotion: 'tense' });
    expect(d.scoreFrom).toBe(d.scoreTo);
    expect(d.scoreTo).toBe(4);
  });

  it('an out-of-range stored score decrements nothing rather than inventing a bucket', () => {
    // Only a hand-edited row could hold this; the CHECK on `ratings.score`
    // forbids it. `dScore` is left honest so the nightly recount still sees it.
    const d = aggregateDelta({ score: 42, emotion: null }, { score: 8, emotion: null });
    expect(d.scoreFrom).toBeNull();
    expect(d.scoreTo).toBe(8);
    expect(d.dScore).toBe(-34);
  });

  it('every score the contract allows is a bucket, not just the app five', () => {
    // 1..10, deliberately. The app maps five stars onto 2/4/6/8/10 today; a
    // half-star build must not need a migration.
    for (let n = SCORE_MIN; n <= SCORE_MAX; n++) {
      expect(aggregateDelta(null, { score: n, emotion: null }).scoreTo).toBe(n);
    }
  });
});

// ── against the real schema ──────────────────────────────────────────────────

describe('POST /v1/ratings — score_counts is maintained on write', () => {
  let raw: Database.Database;
  let env: Env;

  const vote = (token: string, body: Record<string, unknown>) =>
    call(env, 'POST', '/v1/ratings', {
      token,
      body: { target_source: 'tvdb', target_key: '121361', season: 1, episode: 3, ...body },
    });

  const counts = () =>
    JSON.parse(
      (
        raw
          .prepare(
            `SELECT score_counts FROM rating_aggregates
              WHERE target_source = 'tvdb' AND target_key = '121361' AND season = 1 AND episode = 3`,
          )
          .get() as { score_counts: string }
      ).score_counts,
    );

  beforeEach(() => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    env = makeEnv(fresh.db);
    insertProfile(raw, 'p1', 'mahmood');
    insertProfile(raw, 'p2', 'sara');
    insertProfile(raw, 'p3', 'ali');
  });

  it('three votes of 10, 10 and 6 make the distribution the design needs', async () => {
    for (const [id, score] of [
      ['p1', 10],
      ['p2', 10],
      ['p3', 6],
    ] as const) {
      const res = await vote(await tokenFor(env, id), { score });
      expect(res.status).toBe(200);
    }
    expect(counts()).toEqual({ '10': 2, '6': 1 });
    // The old fields are untouched — this is additive, and the app reads them.
    expect(
      raw
        .prepare(
          `SELECT vote_count, score_sum FROM rating_aggregates WHERE target_key = '121361'`,
        )
        .get(),
    ).toEqual({ vote_count: 3, score_sum: 26 });
  });

  it('the first vote returns the distribution in its aggregate, not just a sum', async () => {
    const res = await vote(await tokenFor(env, 'p1'), { score: 8, emotion: 'thrilled' });
    expect(res.json.aggregate.score_counts).toEqual({ '8': 1 });
    expect(res.json.aggregate.emotion_counts).toEqual({ thrilled: 1 });
  });

  it('changing one 10 to an 8 moves the bucket, it does not add one', async () => {
    const p1 = await tokenFor(env, 'p1');
    await vote(p1, { score: 10 });
    await vote(await tokenFor(env, 'p2'), { score: 10 });
    await vote(await tokenFor(env, 'p3'), { score: 6 });

    const res = await vote(p1, { score: 8 });
    expect(res.status).toBe(200);
    expect(counts()).toEqual({ '10': 1, '8': 1, '6': 1 });
    expect(res.json.aggregate.vote_count).toBe(3); // still three people
  });

  it('removing a score decrements the bucket and never goes negative', async () => {
    const p1 = await tokenFor(env, 'p1');
    await vote(p1, { score: 10, emotion: 'shocked' });
    // Score dropped, emotion kept — the vote survives, the bucket empties.
    const res = await vote(p1, { score: null, emotion: 'shocked' });
    expect(res.status).toBe(200);
    expect(counts()).toEqual({ '10': 0 });
    expect(res.json.aggregate.score_counts).toEqual({ '10': 0 });

    // And again, from an already-empty bucket: MAX(0, …) holds the floor.
    await vote(p1, { score: 10, emotion: 'shocked' });
    await vote(p1, { score: null, emotion: 'shocked' });
    await vote(p1, { score: null, emotion: 'sad' });
    expect(counts()['10']).toBe(0);
  });

  it('an emotion-only vote leaves the distribution empty rather than absent', async () => {
    await vote(await tokenFor(env, 'p1'), { emotion: 'amused' });
    expect(counts()).toEqual({});
  });
});

describe('GET /v1/aggregates — score_counts is exposed as an object', () => {
  let raw: Database.Database;
  let env: Env;

  beforeEach(() => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    env = makeEnv(fresh.db);
    insertProfile(raw, 'p1', 'mahmood');
  });

  const insertAggregate = (scoreCounts: string | null) =>
    raw
      .prepare(
        `INSERT INTO rating_aggregates
           (target_source, target_key, season, episode, vote_count, score_sum, emotion_counts,
            score_counts, updated_at)
         VALUES ('tvdb', '121361', 1, 3, 3, 26, '{"shocked":1}', ?, '2026-07-01T00:00:00.000Z')`,
      )
      .run(scoreCounts);

  it('returns the parsed distribution alongside the emotions, season form', async () => {
    insertAggregate('{"10":2,"6":1}');
    const res = await call(env, 'GET', '/v1/aggregates?source=tvdb&key=121361&season=1');
    expect(res.status).toBe(200);
    expect(res.json.items[0].score_counts).toEqual({ '10': 2, '6': 1 });
    expect(res.json.items[0].emotion_counts).toEqual({ shocked: 1 });
    expect(res.json.items[0].score_sum).toBe(26);
  });

  it('returns the parsed distribution in the t= list form too', async () => {
    insertAggregate('{"10":2,"6":1}');
    const res = await call(env, 'GET', '/v1/aggregates?t=tvdb:121361:1:3');
    expect(res.json.items[0].score_counts).toEqual({ '10': 2, '6': 1 });
    expect(res.json.items[0].target_key).toBe('121361');
  });

  it('serialises a not-yet-recounted NULL as {}, never null', async () => {
    // Every pre-0004 row looks like this until the 04:00 reconciliation
    // backfills it. The client must not have to special-case the window.
    insertAggregate(null);
    const res = await call(env, 'GET', '/v1/aggregates?source=tvdb&key=121361&season=1');
    expect(res.json.items[0].score_counts).toEqual({});
    expect(res.json.items[0].score_counts).not.toBeNull();
  });
});
