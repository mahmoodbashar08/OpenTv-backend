import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import {
  CHARACTER_NAME_MAX,
  stableCharacterVoteId,
  stableRatingId,
  validateCharacterName,
  VOTE_IMPORT_MAX_ITEMS,
} from '@/pure';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * Seeding the archive's VOTES — ratings, emotions and favourite characters.
 *
 * The assertion this suite exists for is "the aggregate actually moves". A
 * version of this endpoint that filled `ratings` and left `rating_aggregates`
 * at zero would pass every validation test ever written and still ship the
 * exact bug it was built to fix: an app showing 0% for everything, forever.
 */

let raw: Database.Database;
let env: Env;
let token: string;

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = makeEnv(fresh.db);
  insertProfile(raw, 'p1', 'mahmood');
  insertProfile(raw, 'p2', 'sara');
  token = await tokenFor(env, 'p1');
});

const rating = (over: Record<string, unknown> = {}) => ({
  target_source: 'tvdb',
  target_key: '121361',
  season: 1,
  episode: 3,
  score: 9,
  emotion: 'shocked',
  created_at: '2019-04-02T10:00:00.000Z',
  ...over,
});

const aggregate = (season = 1, episode = 3) =>
  raw
    .prepare(
      `SELECT vote_count, score_sum, emotion_counts, score_counts FROM rating_aggregates
        WHERE target_source = 'tvdb' AND target_key = '121361' AND season = ? AND episode = ?`,
    )
    .get(season, episode) as
    | {
        vote_count: number;
        score_sum: number;
        emotion_counts: string;
        score_counts: string | null;
      }
    | undefined;

const countRatings = () =>
  (raw.prepare('SELECT COUNT(*) AS n FROM ratings').get() as { n: number }).n;

// ── POST /v1/ratings/import ──────────────────────────────────────────────────

describe('POST /v1/ratings/import', () => {
  it('needs a session', async () => {
    const res = await call(env, 'POST', '/v1/ratings/import', { body: { items: [rating()] } });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe('unauthenticated');
  });

  it('imports a valid batch and counts it', async () => {
    const items = [
      rating({ episode: 1 }),
      rating({ episode: 2, emotion: 'sad' }),
      rating({ episode: 3, score: null, emotion: 'touched' }),
    ];
    const res = await call(env, 'POST', '/v1/ratings/import', { token, body: { items } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ imported: 3, skipped: 0 });
    expect(countRatings()).toBe(3);
  });

  it('MOVES THE AGGREGATE — the whole point of the endpoint', async () => {
    // Three people on one episode: two with a score and an emotion, one with an
    // emotion only. `vote_count` counts people, so it is 3 even though only two
    // scores were cast.
    const p2 = await tokenFor(env, 'p2');
    insertProfile(raw, 'p3', 'ali');
    const p3 = await tokenFor(env, 'p3');

    for (const [t, item] of [
      [token, rating({ score: 9, emotion: 'shocked' })],
      [p2, rating({ score: 7, emotion: 'shocked' })],
      [p3, rating({ score: null, emotion: 'sad' })],
    ] as const) {
      const res = await call(env, 'POST', '/v1/ratings/import', { token: t, body: { items: [item] } });
      expect(res.json.imported).toBe(1);
    }

    expect(aggregate()).toEqual({
      vote_count: 3,
      score_sum: 16,
      emotion_counts: '{"shocked":2,"sad":1}',
      // And the DISTRIBUTION, not just the sum. Seeding an archive that filled
      // `score_counts` for nobody would leave every star bar at 0% while
      // `vote_count` climbed into the thousands — the same bug this endpoint
      // was written to fix, one column over.
      score_counts: '{"9":1,"7":1}',
    });
  });

  it('a re-import adds nothing to the distribution either', async () => {
    const item = rating({ score: 6, emotion: 'tense' });
    await call(env, 'POST', '/v1/ratings/import', { token, body: { items: [item] } });
    const second = await call(env, 'POST', '/v1/ratings/import', { token, body: { items: [item] } });
    expect(second.json).toEqual({ imported: 0, skipped: 1 });
    expect(aggregate()?.score_counts).toBe('{"6":1}');
  });

  it('an emotion-only import leaves the distribution empty rather than absent', async () => {
    const item = rating({ score: null, emotion: 'reflective' });
    await call(env, 'POST', '/v1/ratings/import', { token, body: { items: [item] } });
    expect(aggregate()?.score_counts).toBe('{}');
  });

  it('moves the aggregate for three items inside ONE call, too', async () => {
    // The batch path: three statements pairs in one `db.batch()`, where the
    // rollup upsert has to accumulate onto a row it created moments earlier.
    const items = [
      rating({ target_key: '1', season: null, episode: null, score: 10, emotion: 'thrilled' }),
      rating({ target_key: '2', season: null, episode: null, score: 4, emotion: 'bored' }),
      rating({ target_key: '3', season: null, episode: null, score: 8, emotion: null }),
    ];
    expect((await call(env, 'POST', '/v1/ratings/import', { token, body: { items } })).json).toEqual({
      imported: 3,
      skipped: 0,
    });

    const rows = raw
      .prepare(
        'SELECT target_key, vote_count, score_sum, emotion_counts, score_counts FROM rating_aggregates ORDER BY target_key',
      )
      .all();
    expect(rows).toEqual([
      // score_counts is a "10" and not a "10.0": the bucket key is bound as a
      // string, because a number concatenated into a JSON path by SQLite takes
      // the bound value's own type and a float would open a second bucket for
      // the same star that no read would ever find.
      { target_key: '1', vote_count: 1, score_sum: 10, emotion_counts: '{"thrilled":1}', score_counts: '{"10":1}' },
      { target_key: '2', vote_count: 1, score_sum: 4, emotion_counts: '{"bored":1}', score_counts: '{"4":1}' },
      { target_key: '3', vote_count: 1, score_sum: 8, emotion_counts: '{}', score_counts: '{"8":1}' },
    ]);
  });

  it('refuses 501 items with too_large, and accepts exactly 500', async () => {
    const at = Array.from({ length: VOTE_IMPORT_MAX_ITEMS }, (_, i) =>
      rating({ season: 1, episode: i + 1 }),
    );
    expect((await call(env, 'POST', '/v1/ratings/import', { token, body: { items: at } })).json).toEqual({
      imported: VOTE_IMPORT_MAX_ITEMS,
      skipped: 0,
    });

    const over = [...at, rating({ episode: 9999 })];
    const res = await call(env, 'POST', '/v1/ratings/import', { token, body: { items: over } });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('too_large');
  });

  it('skips the invalid item and imports the rest — one bad row is never fatal', async () => {
    const items = [
      rating({ episode: 1 }),
      rating({ episode: 2, score: 11 }), // out of range
      rating({ episode: 3, emotion: "love'] , '$.x" }), // not on the allow-list
      rating({ episode: 4, target_source: 'imdb' }), // not a target source
      rating({ episode: 5, score: null, emotion: null }), // says nothing
      rating({ episode: 6 }),
      'not an object',
    ];
    const res = await call(env, 'POST', '/v1/ratings/import', { token, body: { items } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ imported: 2, skipped: 5 });
    expect(countRatings()).toBe(2);
  });

  it('is a no-op on re-import: {imported: 0} and an aggregate that has not budged', async () => {
    const items = [rating({ episode: 1 }), rating({ episode: 2 })];
    expect((await call(env, 'POST', '/v1/ratings/import', { token, body: { items } })).json.imported).toBe(2);

    const again = await call(env, 'POST', '/v1/ratings/import', { token, body: { items } });
    expect(again.json).toEqual({ imported: 0, skipped: 2 });
    expect(countRatings()).toBe(2);
    expect(aggregate(1, 1)?.vote_count).toBe(1);
    expect(aggregate(1, 1)?.score_sum).toBe(9);
    expect(aggregate(1, 1)?.emotion_counts).toBe('{"shocked":1}');
  });

  it('dedupes duplicates INSIDE one payload, because the guard sees the earlier insert', async () => {
    const items = [rating(), rating(), rating()];
    const res = await call(env, 'POST', '/v1/ratings/import', { token, body: { items } });
    expect(res.json).toEqual({ imported: 1, skipped: 2 });
    expect(aggregate()).toEqual({
      vote_count: 1,
      score_sum: 9,
      emotion_counts: '{"shocked":1}',
      score_counts: '{"9":1}',
    });
  });

  it('never overwrites a live vote, and never double-counts it', async () => {
    // The row exists under a random `r_…` id, which the derived id cannot know
    // about; `idx_one_vote_per_person` is what catches it.
    await call(env, 'POST', '/v1/ratings', {
      token,
      body: { target_source: 'tvdb', target_key: '121361', season: 1, episode: 3, score: 9, emotion: 'shocked' },
    });
    const res = await call(env, 'POST', '/v1/ratings/import', {
      token,
      body: { items: [rating({ score: 4, emotion: 'bored' })] },
    });
    expect(res.json).toEqual({ imported: 0, skipped: 1 });
    expect(countRatings()).toBe(1);
    expect(aggregate()).toEqual({
      vote_count: 1,
      score_sum: 9,
      // The SCORE is not overwritten — the live 9 stands, the archive's 4 is
      // dropped, and the item is `skipped`. The FEELING is a different question:
      // feelings are a set (0005), and adding one the person does not hold
      // overwrites nothing. The archive says they were bored in 2019 and they
      // said shocked today; both are true, both count, and each is one selection.
      emotion_counts: '{"shocked":1,"bored":1}',
      score_counts: '{"9":1}',
    });
  });

  it('answers an empty list without touching the database', async () => {
    expect((await call(env, 'POST', '/v1/ratings/import', { token, body: { items: [] } })).json).toEqual({
      imported: 0,
      skipped: 0,
    });
  });

  it('rejects a body that is not a list of items', async () => {
    const res = await call(env, 'POST', '/v1/ratings/import', { token, body: { items: 'all of them' } });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('invalid_body');
  });

  it('refuses a token for a profile that no longer exists', async () => {
    const ghost = await tokenFor(env, 'p_gone');
    const res = await call(env, 'POST', '/v1/ratings/import', { token: ghost, body: { items: [rating()] } });
    expect(res.status).toBe(401);
  });
});

// ── character votes ──────────────────────────────────────────────────────────

const charVote = (over: Record<string, unknown> = {}) => ({
  target_source: 'tvdb',
  target_key: '121361',
  character: 'Tyrion Lannister',
  character_id: 227236,
  season: 1,
  episode: 3,
  created_at: '2019-04-02T10:00:00.000Z',
  ...over,
});

const charAggregate = (key = '121361') =>
  raw
    .prepare('SELECT counts, total FROM character_vote_aggregates WHERE target_key = ?')
    .get(key) as { counts: string; total: number } | undefined;

describe('POST /v1/character-votes', () => {
  it('records a favourite and starts the rollup', async () => {
    const res = await call(env, 'POST', '/v1/character-votes', { token, body: charVote() });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, character: 'Tyrion Lannister' });
    expect(charAggregate()).toEqual({ counts: '{"Tyrion Lannister":1}', total: 1 });
  });

  it('is one vote per person per show: a re-vote REPLACES and never duplicates', async () => {
    await call(env, 'POST', '/v1/character-votes', { token, body: charVote() });
    await call(env, 'POST', '/v1/character-votes', {
      token,
      body: charVote({ character: 'Arya Stark', season: 4, episode: 1 }),
    });

    expect(raw.prepare('SELECT COUNT(*) AS n FROM character_votes').get()).toEqual({ n: 1 });
    expect(raw.prepare('SELECT character_name, season FROM character_votes').get()).toEqual({
      character_name: 'Arya Stark',
      season: 4,
    });
    // The count MOVED. `total` counts people, so it stays at one.
    expect(charAggregate()).toEqual({ counts: '{"Tyrion Lannister":0,"Arya Stark":1}', total: 1 });
  });

  it('counts two people separately', async () => {
    await call(env, 'POST', '/v1/character-votes', { token, body: charVote() });
    await call(env, 'POST', '/v1/character-votes', {
      token: await tokenFor(env, 'p2'),
      body: charVote(),
    });
    expect(charAggregate()).toEqual({ counts: '{"Tyrion Lannister":2}', total: 2 });
  });

  it('keeps a name with a full stop under ONE key — the JSON path is quoted', async () => {
    await call(env, 'POST', '/v1/character-votes', { token, body: charVote({ character: 'Dr. House' }) });
    await call(env, 'POST', '/v1/character-votes', {
      token: await tokenFor(env, 'p2'),
      body: charVote({ character: 'Dr. House' }),
    });
    expect(charAggregate()).toEqual({ counts: '{"Dr. House":2}', total: 2 });
  });

  it('refuses a name that could break out of that path', async () => {
    const res = await call(env, 'POST', '/v1/character-votes', {
      token,
      body: charVote({ character: 'x","y' }),
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('invalid_body');
  });
});

describe('DELETE /v1/character-votes', () => {
  const target = { target_source: 'tvdb', target_key: '121361' };

  it('withdraws the vote and takes the count down with it', async () => {
    await call(env, 'POST', '/v1/character-votes', { token, body: charVote() });
    const res = await call(env, 'DELETE', '/v1/character-votes', { token, body: target });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, removed: true });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM character_votes').get()).toEqual({ n: 0 });
    // `total` counts people, so a withdrawal is one fewer voter.
    expect(charAggregate()).toEqual({ counts: '{"Tyrion Lannister":0}', total: 0 });
  });

  it('leaves everyone else standing', async () => {
    await call(env, 'POST', '/v1/character-votes', { token, body: charVote() });
    await call(env, 'POST', '/v1/character-votes', {
      token: await tokenFor(env, 'p2'),
      body: charVote(),
    });
    await call(env, 'DELETE', '/v1/character-votes', { token, body: target });

    expect(charAggregate()).toEqual({ counts: '{"Tyrion Lannister":1}', total: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM character_votes').get()).toEqual({ n: 1 });
  });

  it('is a no-op when there was no vote — the caller asked for absence and got it', async () => {
    const res = await call(env, 'DELETE', '/v1/character-votes', { token, body: target });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, removed: false });
  });

  it('touches only the target named', async () => {
    await call(env, 'POST', '/v1/character-votes', { token, body: charVote() });
    await call(env, 'POST', '/v1/character-votes', {
      token,
      body: charVote({ target_key: '999', character: 'Arya Stark' }),
    });
    await call(env, 'DELETE', '/v1/character-votes', { token, body: target });

    expect(charAggregate('999')).toEqual({ counts: '{"Arya Stark":1}', total: 1 });
  });

  it('never drives a count below zero, however many times it is called', async () => {
    await call(env, 'POST', '/v1/character-votes', { token, body: charVote() });
    await call(env, 'DELETE', '/v1/character-votes', { token, body: target });
    await call(env, 'DELETE', '/v1/character-votes', { token, body: target });

    expect(charAggregate()).toEqual({ counts: '{"Tyrion Lannister":0}', total: 0 });
  });

  it('re-picking after a withdrawal counts once, not twice', async () => {
    await call(env, 'POST', '/v1/character-votes', { token, body: charVote() });
    await call(env, 'DELETE', '/v1/character-votes', { token, body: target });
    await call(env, 'POST', '/v1/character-votes', { token, body: charVote() });

    expect(charAggregate()).toEqual({ counts: '{"Tyrion Lannister":1}', total: 1 });
  });

  it('requires a token', async () => {
    const res = await call(env, 'DELETE', '/v1/character-votes', { body: target });
    expect(res.status).toBe(401);
  });

  it('refuses an unusable target', async () => {
    const res = await call(env, 'DELETE', '/v1/character-votes', {
      token,
      body: { target_source: 'nope', target_key: '1' },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('target_invalid');
  });
});

describe('POST /v1/character-votes/import', () => {
  it('imports one vote per show and skips the rest of that show’s episodes', async () => {
    // The archive holds a favourite per EPISODE; the community holds one per
    // show. Forty per-episode rows collapse to one, honestly counted.
    const items = [
      charVote({ episode: 1 }),
      charVote({ episode: 2, character: 'Arya Stark' }),
      charVote({ episode: 3 }),
      charVote({ target_key: '73739', character: 'Sawyer' }),
    ];
    const res = await call(env, 'POST', '/v1/character-votes/import', { token, body: { items } });
    expect(res.json).toEqual({ imported: 2, skipped: 2 });
    expect(charAggregate()).toEqual({ counts: '{"Tyrion Lannister":1}', total: 1 });
    expect(charAggregate('73739')).toEqual({ counts: '{"Sawyer":1}', total: 1 });
  });

  it('is a no-op on re-import', async () => {
    const items = [charVote()];
    expect((await call(env, 'POST', '/v1/character-votes/import', { token, body: { items } })).json.imported).toBe(1);
    expect((await call(env, 'POST', '/v1/character-votes/import', { token, body: { items } })).json).toEqual({
      imported: 0,
      skipped: 1,
    });
    expect(charAggregate()).toEqual({ counts: '{"Tyrion Lannister":1}', total: 1 });
  });

  it('never overwrites a favourite already chosen in the app', async () => {
    await call(env, 'POST', '/v1/character-votes', { token, body: charVote({ character: 'Arya Stark' }) });
    const res = await call(env, 'POST', '/v1/character-votes/import', { token, body: { items: [charVote()] } });
    expect(res.json).toEqual({ imported: 0, skipped: 1 });
    expect(charAggregate()).toEqual({ counts: '{"Arya Stark":1}', total: 1 });
  });

  it('skips an unnamed or unsafe character and imports the rest', async () => {
    const items = [
      charVote({ target_key: '1', character: null }), // a charId with no cached name
      charVote({ target_key: '2', character: '   ' }),
      charVote({ target_key: '3', character: 'a"b' }),
      charVote({ target_key: '4', target_source: 'nope' }),
      charVote({ target_key: '5' }),
    ];
    const res = await call(env, 'POST', '/v1/character-votes/import', { token, body: { items } });
    expect(res.json).toEqual({ imported: 1, skipped: 4 });
  });

  it('refuses 501 items with too_large', async () => {
    const items = Array.from({ length: VOTE_IMPORT_MAX_ITEMS + 1 }, (_, i) =>
      charVote({ target_key: String(i) }),
    );
    const res = await call(env, 'POST', '/v1/character-votes/import', { token, body: { items } });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('too_large');
  });
});

describe('GET /v1/character-votes', () => {
  it('is open, sorted biggest first, and cacheable', async () => {
    await call(env, 'POST', '/v1/character-votes', { token, body: charVote({ character: 'Arya Stark' }) });
    await call(env, 'POST', '/v1/character-votes', {
      token: await tokenFor(env, 'p2'),
      body: charVote(),
    });
    insertProfile(raw, 'p3', 'ali');
    await call(env, 'POST', '/v1/character-votes', {
      token: await tokenFor(env, 'p3'),
      body: charVote(),
    });

    const res = await call(env, 'GET', '/v1/character-votes?source=tvdb&key=121361');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      items: [
        { character: 'Tyrion Lannister', votes: 2 },
        { character: 'Arya Stark', votes: 1 },
      ],
      total: 3,
    });
  });

  it('answers a show nobody has voted on with an empty rollup, not a 404', async () => {
    const res = await call(env, 'GET', '/v1/character-votes?source=tvdb&key=999999');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ items: [], total: 0 });
  });

  it('rejects a missing target', async () => {
    expect((await call(env, 'GET', '/v1/character-votes?key=121361')).status).toBe(400);
    expect((await call(env, 'GET', '/v1/character-votes?source=tvdb')).status).toBe(400);
  });

  it('drops the zeroed key a changed vote leaves behind', async () => {
    await call(env, 'POST', '/v1/character-votes', { token, body: charVote() });
    await call(env, 'POST', '/v1/character-votes', { token, body: charVote({ character: 'Arya Stark' }) });
    const res = await call(env, 'GET', '/v1/character-votes?source=tvdb&key=121361');
    expect(res.json).toEqual({ items: [{ character: 'Arya Stark', votes: 1 }], total: 1 });
  });
});

// ── the pure guards ──────────────────────────────────────────────────────────

describe('validateCharacterName', () => {
  it('accepts the names people actually vote for', () => {
    for (const n of ['Dr. House', "Éowyn", 'أبو العز', 'Michael Scott', 'C-3PO', 'Sam & Dean']) {
      expect(validateCharacterName(n)).toEqual({ ok: true, name: n });
    }
  });

  it('trims, and refuses empty or non-string', () => {
    expect(validateCharacterName('  Arya  ')).toEqual({ ok: true, name: 'Arya' });
    expect(validateCharacterName('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(validateCharacterName(null)).toEqual({ ok: false, reason: 'empty' });
    expect(validateCharacterName(42)).toEqual({ ok: false, reason: 'empty' });
  });

  it('refuses anything that could close the JSON path quote', () => {
    expect(validateCharacterName('a"b')).toEqual({ ok: false, reason: 'unsafe' });
    expect(validateCharacterName('a\\b')).toEqual({ ok: false, reason: 'unsafe' });
    expect(validateCharacterName('a\nb')).toEqual({ ok: false, reason: 'unsafe' });
    expect(validateCharacterName('"}, "$.x": {"')).toEqual({ ok: false, reason: 'unsafe' });
  });

  it('caps the length', () => {
    expect(validateCharacterName('a'.repeat(CHARACTER_NAME_MAX)).ok).toBe(true);
    expect(validateCharacterName('a'.repeat(CHARACTER_NAME_MAX + 1))).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });
});

describe('stableRatingId / stableCharacterVoteId — dedupe by construction', () => {
  const R = { authorId: 'p1', targetSource: 'tvdb', targetKey: '121361', season: 1, episode: 3 };

  it('is deterministic and shaped like the comment id', async () => {
    expect(await stableRatingId(R)).toBe(await stableRatingId(R));
    expect(await stableRatingId(R)).toMatch(/^imr_[0-9a-f]{32}$/);
    expect(await stableCharacterVoteId({ voterId: 'p1', targetSource: 'tvdb', targetKey: '1' })).toMatch(
      /^imc_[0-9a-f]{32}$/,
    );
  });

  it('ignores the score and the emotion — a person holds ONE vote per title', async () => {
    // The id is the address, not the content. Two imports of the same title
    // must land on the same row even if the archive changed its mind.
    expect(await stableRatingId(R)).toBe(await stableRatingId({ ...R }));
  });

  it('differs per person, per target and per episode', async () => {
    const base = await stableRatingId(R);
    expect(await stableRatingId({ ...R, authorId: 'p2' })).not.toBe(base);
    expect(await stableRatingId({ ...R, targetKey: '73739' })).not.toBe(base);
    expect(await stableRatingId({ ...R, episode: 4 })).not.toBe(base);
    expect(await stableRatingId({ ...R, season: null, episode: null })).not.toBe(base);
  });
});
