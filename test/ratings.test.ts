import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import {
  AGGREGATE_PARAMS_PER_TARGET,
  AGGREGATE_TARGETS_PER_QUERY,
  aggregateDelta,
  chunk,
  D1_MAX_BOUND_PARAMS,
  emotionSetDelta,
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
  it('new vote with a score: +1 vote, +score', () => {
    expect(aggregateDelta(null, { score: 9 })).toEqual({
      dVotes: 1,
      dScore: 9,
      scoreFrom: null,
      scoreTo: 9,
    });
  });

  it('new vote, feelings only: still counts as a person', () => {
    // The `ratings` row with a NULL score exists for exactly this: the person
    // is counted once in `vote_count`, and their feelings are counted in
    // `emotion_counts` by `emotionSetDelta`, not here.
    expect(aggregateDelta(null, { score: null })).toEqual({
      dVotes: 1,
      dScore: 0,
      scoreFrom: null,
      scoreTo: null,
    });
  });

  it('changed score 7 → 9: no new person, +2', () => {
    expect(aggregateDelta({ score: 7 }, { score: 9 })).toEqual({
      dVotes: 0,
      dScore: 2,
      scoreFrom: 7,
      scoreTo: 9,
    });
  });

  it('score added to a feelings-only vote', () => {
    expect(aggregateDelta({ score: null }, { score: 8 })).toEqual({
      dVotes: 0,
      dScore: 8,
      scoreFrom: null,
      scoreTo: 8,
    });
  });

  it('score removed: -prev.score, person stays counted', () => {
    expect(aggregateDelta({ score: 8 }, { score: null })).toEqual({
      dVotes: 0,
      dScore: -8,
      scoreFrom: 8,
      scoreTo: null,
    });
  });

  it('feelings changed only: the score half moves nothing', () => {
    expect(aggregateDelta({ score: 9 }, { score: 9 })).toEqual({
      dVotes: 0,
      dScore: 0,
      scoreFrom: 9,
      scoreTo: 9,
    });
  });
});

describe('aggregateDelta — the cases the table leaves implicit', () => {
  it('an identical re-vote moves nothing at all', () => {
    const d = aggregateDelta({ score: 7 }, { score: 7 });
    expect(d).toEqual({ dVotes: 0, dScore: 0, scoreFrom: 7, scoreTo: 7 });
    // from === to, so no json_set clause is emitted at all.
    expect(d.scoreFrom).toBe(d.scoreTo);
  });
});

// ── the set, in the pure layer ───────────────────────────────────────────────
//
// migrations/0005_emotion_votes.sql. The bug this replaced: the server kept the
// lowest-indexed selection and dropped the rest, so SHOCKED + THRILLED was
// stored, aggregated and returned as SHOCKED alone.

describe('emotionSetDelta', () => {
  it('a first set is all additions', () => {
    expect(emotionSetDelta([], ['shocked', 'thrilled'])).toEqual({
      added: ['shocked', 'thrilled'],
      removed: [],
    });
  });

  it('adding one to an existing set moves only that one', () => {
    expect(emotionSetDelta(['shocked'], ['shocked', 'thrilled'])).toEqual({
      added: ['thrilled'],
      removed: [],
    });
  });

  it('an empty array clears the whole set', () => {
    expect(emotionSetDelta(['shocked', 'thrilled'], [])).toEqual({
      added: [],
      removed: ['shocked', 'thrilled'],
    });
  });

  it('an absent field leaves the set exactly where it is', () => {
    // Not the same request as `[]`. A client changing only a score must not be
    // able to wipe the feelings it never sent.
    expect(emotionSetDelta(['shocked'], undefined)).toEqual({ added: [], removed: [] });
  });

  it('re-sending the same set is a no-op, order and all', () => {
    expect(emotionSetDelta(['shocked', 'thrilled'], ['thrilled', 'shocked'])).toEqual({
      added: [],
      removed: [],
    });
  });

  it('swapping one feeling for another decrements and increments once each', () => {
    expect(emotionSetDelta(['sad'], ['amused'])).toEqual({ added: ['amused'], removed: ['sad'] });
  });
});

describe('validateVote', () => {
  it('accepts a score with a set of feelings', () => {
    const r = validateVote({ score: 9, emotions: ['touched', 'sad'], season: 1, episode: 3 });
    expect(r).toEqual({
      ok: true,
      vote: { score: 9, emotions: ['touched', 'sad'], season: 1, episode: 3 },
    });
  });

  it('accepts a show-level vote with no season or episode', () => {
    const r = validateVote({ score: 10 });
    expect(r.ok && r.vote).toEqual({
      score: 10,
      emotions: undefined,
      season: null,
      episode: null,
    });
  });

  it('rejects score 0 and score 11 before any SQL is prepared', () => {
    expect(validateVote({ score: 0, emotions: ['touched'] })).toEqual({
      ok: false,
      reason: 'score_invalid',
    });
    expect(validateVote({ score: 11 })).toEqual({ ok: false, reason: 'score_invalid' });
  });

  it('rejects a non-integer score', () => {
    expect(validateVote({ score: 8.5 })).toEqual({ ok: false, reason: 'score_invalid' });
    expect(validateVote({ score: '9' })).toEqual({ ok: false, reason: 'score_invalid' });
  });

  it('rejects an emotion outside the allow-list — it becomes a JSON path', () => {
    expect(validateVote({ emotions: ['shock'] })).toEqual({ ok: false, reason: 'emotion_invalid' });
    expect(validateVote({ emotions: ["love\"] , '$.x"] })).toEqual({
      ok: false,
      reason: 'emotion_invalid',
    });
    // One bad member poisons the whole set: a partially-applied selection would
    // be a silent discard, which is the bug this design exists to end.
    expect(validateVote({ emotions: ['sad', 'nope'] })).toEqual({
      ok: false,
      reason: 'emotion_invalid',
    });
  });

  it('rejects an emotions field that is not an array of strings', () => {
    expect(validateVote({ emotions: 'sad' })).toEqual({ ok: false, reason: 'emotion_invalid' });
    expect(validateVote({ emotions: [1, 2] })).toEqual({ ok: false, reason: 'emotion_invalid' });
    expect(validateVote({ emotions: [['sad']] })).toEqual({ ok: false, reason: 'emotion_invalid' });
  });

  it('accepts the whole list at once and refuses more members than there are feelings', () => {
    expect(validateVote({ emotions: [...EMOTIONS] }).ok).toBe(true);
    expect(validateVote({ emotions: [...EMOTIONS, 'sad'] })).toEqual({
      ok: false,
      reason: 'emotion_invalid',
    });
  });

  it('dedupes: two sads are one sad', () => {
    const r = validateVote({ emotions: ['sad', 'sad', 'amused'] });
    expect(r.ok && r.vote.emotions).toEqual(['sad', 'amused']);
  });

  it('accepts every emotion on the list', () => {
    for (const e of EMOTIONS) expect(validateVote({ emotions: [e] }).ok).toBe(true);
  });

  it('still accepts the old single `emotion` field, as a one-member set', () => {
    const r = validateVote({ emotion: 'touched' });
    expect(r.ok && r.vote.emotions).toEqual(['touched']);
    expect(validateVote({ emotion: 'shock' })).toEqual({ ok: false, reason: 'emotion_invalid' });
  });

  it('lets `emotions` win when a client sends both', () => {
    const r = validateVote({ emotion: 'sad', emotions: ['amused', 'tense'] });
    expect(r.ok && r.vote.emotions).toEqual(['amused', 'tense']);
  });

  it('reads the old `emotion: null` as ABSENT, never as a clear', () => {
    // The build on people's phones sends it to mean "not touching feelings".
    expect(validateVote({ score: 7, emotion: null }).ok && true).toBe(true);
    const r = validateVote({ score: 7, emotion: null });
    expect(r.ok && r.vote.emotions).toBeUndefined();
  });

  it('rejects a vote that says nothing', () => {
    expect(validateVote({})).toEqual({ ok: false, reason: 'empty_vote' });
    expect(validateVote({ score: null, emotion: null })).toEqual({
      ok: false,
      reason: 'empty_vote',
    });
  });

  it('accepts a bare clear — an empty array is an instruction, not silence', () => {
    // Whether there is anything to clear is a question only a read can answer,
    // so the route makes that call; the pure layer lets it through.
    expect(validateVote({ score: null, emotions: [] })).toEqual({
      ok: true,
      vote: { score: null, emotions: [], season: null, episode: null },
    });
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
    const d = aggregateDelta(null, { score: 10 });
    expect(d.scoreFrom).toBeNull();
    expect(d.scoreTo).toBe(10);
  });

  it('a changed score moves the bucket, 10 → 8', () => {
    const d = aggregateDelta({ score: 10 }, { score: 8 });
    expect(d.scoreFrom).toBe(10);
    expect(d.scoreTo).toBe(8);
  });

  it('a removed score decrements and opens nothing', () => {
    const d = aggregateDelta({ score: 6 }, { score: null });
    expect(d.scoreFrom).toBe(6);
    expect(d.scoreTo).toBeNull();
  });

  it('a feelings-only vote moves no bucket at all', () => {
    const d = aggregateDelta(null, { score: null });
    expect(d.scoreFrom).toBeNull();
    expect(d.scoreTo).toBeNull();
    expect(d.scoreFrom).toBe(d.scoreTo); // the caller skips the clause entirely
  });

  it('an out-of-range stored score decrements nothing rather than inventing a bucket', () => {
    // Only a hand-edited row could hold this; the CHECK on `ratings.score`
    // forbids it. `dScore` is left honest so the nightly recount still sees it.
    const d = aggregateDelta({ score: 42 }, { score: 8 });
    expect(d.scoreFrom).toBeNull();
    expect(d.scoreTo).toBe(8);
    expect(d.dScore).toBe(-34);
  });

  it('every score the contract allows is a bucket, not just the app five', () => {
    // 1..10, deliberately. The app maps five stars onto 2/4/6/8/10 today; a
    // half-star build must not need a migration.
    for (let n = SCORE_MIN; n <= SCORE_MAX; n++) {
      expect(aggregateDelta(null, { score: n }).scoreTo).toBe(n);
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

/**
 * THE TEST THAT WOULD HAVE CAUGHT IT.
 *
 * Every list-form test above asks for one or two targets. The route binds four
 * parameters per target into a row-value `IN (VALUES …)`, D1 permits 100 bound
 * parameters per statement, and so the 26th target was an unconditional 500
 * while `MAX_TARGETS` went on advertising 100 and the app went on sending 100.
 * A handful of targets can never see that; thirty can.
 */
describe('GET /v1/aggregates — the list form past one statement\'s worth', () => {
  describe('the internal chunker', () => {
    it('derives 25 from D1\'s limit and the width of a target key', () => {
      expect(AGGREGATE_TARGETS_PER_QUERY).toBe(25);
      expect(AGGREGATE_TARGETS_PER_QUERY * AGGREGATE_PARAMS_PER_TARGET).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMS,
      );
    });

    it.each([
      [0, []],
      [1, [1]],
      [25, [25]],
      [26, [25, 1]],
      [100, [25, 25, 25, 25]],
    ])('%i targets becomes groups %j', (count, sizes) => {
      const targets = Array.from({ length: count }, (_, i) => i);
      const groups = chunk(targets, AGGREGATE_TARGETS_PER_QUERY);
      expect(groups.map((g) => g.length)).toEqual(sizes);
      // No group may exceed what one statement can bind…
      for (const g of groups) expect(g.length).toBeLessThanOrEqual(AGGREGATE_TARGETS_PER_QUERY);
      // …and flattening must give back exactly the input: order kept, nothing
      // duplicated across a boundary, nothing dropped at one.
      expect(groups.flat()).toEqual(targets);
    });
  });

  describe('against the database', () => {
    let raw: Database.Database;
    let env: Env;

    /** 30 distinct targets — five past the point a single statement can serve. */
    const KEYS = Array.from({ length: 30 }, (_, i) => `t${String(i).padStart(2, '0')}`);

    beforeEach(() => {
      const fresh = freshDatabase();
      raw = fresh.raw;
      env = makeEnv(fresh.db);
      const insert = raw.prepare(
        `INSERT INTO rating_aggregates
           (target_source, target_key, season, episode, vote_count, score_sum, emotion_counts,
            score_counts, updated_at)
         VALUES ('tvdb', ?, 1, 3, ?, 0, '{}', '{}', '2026-07-01T00:00:00.000Z')`,
      );
      KEYS.forEach((k, i) => insert.run(k, i + 1));
    });

    const ask = (keys: readonly string[]) =>
      call(env, 'GET', `/v1/aggregates?${keys.map((k) => `t=tvdb:${k}:1:3`).join('&')}`);

    it('returns all 30 — every target once, none dropped at a group boundary', async () => {
      const res = await ask(KEYS);
      expect(res.status).toBe(200);
      expect(res.json.items).toHaveLength(30);

      const keys = res.json.items.map((i: { target_key: string }) => i.target_key);
      // The contract the client relies on: every requested target that has a
      // row comes back exactly once, carrying the `target_key` it matches on.
      // A target duplicated across two groups, or lost at the seam between
      // them, is what chunking could plausibly get wrong.
      expect(new Set(keys).size).toBe(30);
      expect([...keys].sort()).toEqual([...KEYS].sort());

      // ORDER, honestly stated: rows come back in the database's order within
      // each group, and the groups are concatenated in request order. Seeded
      // here in request order, that makes the two coincide — which is what
      // pins the seam at 25/26 rather than any promise the route makes. The
      // route has never sorted, and the client matches on `target_key`.
      expect(keys).toEqual([...KEYS]);

      // The rows are real, not thirty empty shells stitched together.
      expect(res.json.items.map((i: { vote_count: number }) => i.vote_count)).toEqual(
        KEYS.map((_, i) => i + 1),
      );
    });

    it('serves 25 and 26 alike — the boundary that used to be a 500', async () => {
      const twentyFive = await ask(KEYS.slice(0, 25));
      expect(twentyFive.status).toBe(200);
      expect(twentyFive.json.items).toHaveLength(25);

      const twentySix = await ask(KEYS.slice(0, 26));
      expect(twentySix.status).toBe(200);
      expect(twentySix.json.items).toHaveLength(26);
    });

    it('answers a target with no votes by omitting it, at 30 as at 1', async () => {
      const res = await ask([...KEYS, 'never-voted-on']);
      expect(res.status).toBe(200);
      expect(res.json.items).toHaveLength(30);
    });

    it('still serves the full advertised 100 — the batch the app actually sends', async () => {
      const padded = [...KEYS, ...Array.from({ length: 70 }, (_, i) => `pad${i}`)];
      const res = await ask(padded);
      expect(res.status).toBe(200);
      expect(res.json.items).toHaveLength(30); // the 70 padding targets have no rows
    });

    it('still refuses 101: the public cap is unchanged', async () => {
      const res = await ask(Array.from({ length: MAX_TARGETS + 1 }, (_, i) => `x${i}`));
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('target_invalid');
    });
  });
});
