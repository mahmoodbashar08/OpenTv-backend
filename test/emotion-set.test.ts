import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { migrateTitleThreads, purgeSoftDeleted, reconcileRatingAggregates } from '@/jobs';
import { call, d1, freshDatabase, insertProfile, makeEnv, MIGRATIONS, tokenFor } from './harness';

/**
 * Feelings are a SET — migrations/0005_emotion_votes.sql.
 *
 * The bug: the app has always offered the twelve as a multi-select, and the
 * server stored one column's worth. SHOCKED and THRILLED on a film became
 * SHOCKED, with a 200 and a self-consistent aggregate to hide it.
 *
 * The contract now: `emotions` is the person's WHOLE selection and replaces
 * their previous one; `emotion_counts` counts SELECTIONS while `vote_count`
 * still counts PEOPLE, so one person with two feelings reads 50% / 50%.
 */

// ── the migration itself ─────────────────────────────────────────────────────

describe('migration 0005 — the emotions that already exist', () => {
  /** 0001..0004: the schema as the live database had it before this work. */
  function before(): Database.Database {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    for (const sql of MIGRATIONS.slice(0, 4)) raw.exec(sql);
    return raw;
  }

  const apply0005 = (raw: Database.Database) => raw.exec(MIGRATIONS[4]!);

  function seed(raw: Database.Database) {
    for (const [id, handle] of [
      ['p1', 'mahmood'],
      ['p2', 'sara'],
    ] as const) {
      insertProfile(raw, id, handle);
    }
    // Two people, one film, the single feeling each of them was allowed to keep.
    raw
      .prepare(
        `INSERT INTO ratings (id, author_id, target_source, target_key, season, episode, score, emotion, created_at)
         VALUES ('r1', 'p1', 'title', 'amado|2011', NULL, NULL, 10, 'shocked', '2026-07-01T00:00:00.000Z'),
                ('r2', 'p2', 'title', 'amado|2011', NULL, NULL, NULL, 'sad', '2026-07-02T00:00:00.000Z')`,
      )
      .run();
    // The rollup exactly as the write path left it — this is what users see now.
    raw
      .prepare(
        `INSERT INTO rating_aggregates
           (target_source, target_key, season, episode, vote_count, score_sum, emotion_counts,
            score_counts, updated_at)
         VALUES ('title', 'amado|2011', -1, -1, 2, 10, '{"shocked":1,"sad":1}', '{"10":1}',
                 '2026-07-02T00:00:00.000Z')`,
      )
      .run();
  }

  it('moves every stored emotion into emotion_votes and empties the column', async () => {
    const raw = before();
    seed(raw);
    apply0005(raw);

    expect(raw.prepare('SELECT * FROM emotion_votes ORDER BY author_id').all()).toEqual([
      {
        author_id: 'p1',
        target_source: 'title',
        target_key: 'amado|2011',
        // NULL season/episode on the vote become the -1 sentinel here, because
        // this table is keyed like the rollup it feeds.
        season: -1,
        episode: -1,
        emotion: 'shocked',
        created_at: '2026-07-01T00:00:00.000Z',
      },
      {
        author_id: 'p2',
        target_source: 'title',
        target_key: 'amado|2011',
        season: -1,
        episode: -1,
        emotion: 'sad',
        created_at: '2026-07-02T00:00:00.000Z',
      },
    ]);

    // The column survives (dropping it is a table rebuild) but holds nothing.
    expect(
      raw.prepare('SELECT COUNT(*) AS n FROM ratings WHERE emotion IS NOT NULL').get(),
    ).toEqual({ n: 0 });
    // The votes themselves are untouched — nobody loses a rating to this.
    expect(raw.prepare('SELECT COUNT(*) AS n FROM ratings').get()).toEqual({ n: 2 });
  });

  it('leaves every percentage exactly where it was: the recount finds no drift', async () => {
    const raw = before();
    seed(raw);
    const read = () =>
      JSON.parse(
        (
          raw
            .prepare(`SELECT emotion_counts FROM rating_aggregates WHERE target_key = 'amado|2011'`)
            .get() as { emotion_counts: string }
        ).emotion_counts,
      );
    const was = read();

    apply0005(raw);
    await reconcileRatingAggregates(d1(raw));

    // The claim: the new source of truth reproduces the old numbers exactly, so
    // nobody sees a percentage move because of a migration.
    //
    // Compared PARSED, not as text. `json_group_object` emits keys in GROUP BY
    // order, so a row the write path left as `{"shocked":1,"sad":1}` is rewritten
    // as `{"sad":1,"shocked":1}` and counts as one correction — a reordering, not
    // a change. Asserting on the string would be asserting on SQLite's ordering.
    expect(read()).toEqual(was);
    expect(read()).toEqual({ shocked: 1, sad: 1 });
  });

  it('is idempotent — re-running it neither duplicates nor loses a row', async () => {
    const raw = before();
    seed(raw);
    apply0005(raw);
    apply0005(raw);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM emotion_votes').get()).toEqual({ n: 2 });
  });
});

// ── the write path ───────────────────────────────────────────────────────────

describe('POST /v1/ratings — a set, replaced', () => {
  let raw: Database.Database;
  let env: Env;
  let token: string;

  const target = { target_source: 'tvdb', target_key: '121361', season: 1, episode: 3 };
  const vote = (tok: string, body: Record<string, unknown>) =>
    call(env, 'POST', '/v1/ratings', { token: tok, body: { ...target, ...body } });

  const counts = () =>
    JSON.parse(
      (
        raw
          .prepare(
            `SELECT emotion_counts FROM rating_aggregates
              WHERE target_source = 'tvdb' AND target_key = '121361' AND season = 1 AND episode = 3`,
          )
          .get() as { emotion_counts: string }
      ).emotion_counts,
    );

  const held = (author = 'p1') =>
    raw
      .prepare('SELECT emotion FROM emotion_votes WHERE author_id = ? ORDER BY emotion')
      .all(author)
      .map((r) => (r as { emotion: string }).emotion);

  beforeEach(async () => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    env = makeEnv(fresh.db);
    insertProfile(raw, 'p1', 'mahmood');
    insertProfile(raw, 'p2', 'sara');
    token = await tokenFor(env, 'p1');
  });

  it('counts BOTH feelings — the bug, in one test', async () => {
    // The owner picked SHOCKED and THRILLED on a film and only SHOCKED counted.
    const res = await vote(token, { emotions: ['shocked', 'thrilled'] });
    expect(res.status).toBe(200);
    expect(res.json.aggregate.emotion_counts).toEqual({ shocked: 1, thrilled: 1 });
    // One person, two selections: the app divides by the total of the object,
    // so this reads 50% / 50%.
    expect(res.json.aggregate.vote_count).toBe(1);
    expect(held()).toEqual(['shocked', 'thrilled']);
  });

  it('a person with two feelings and no score is one vote and two selections', async () => {
    await vote(token, { emotions: ['sad', 'touched'] });
    const row = raw
      .prepare(`SELECT vote_count, score_sum, emotion_counts FROM rating_aggregates`)
      .get() as { vote_count: number; score_sum: number; emotion_counts: string };
    expect(row.vote_count).toBe(1);
    expect(row.score_sum).toBe(0);
    const selections: number[] = Object.values(JSON.parse(row.emotion_counts));
    expect(selections.reduce((a, b) => a + b, 0)).toBe(2);
    // The score-less `ratings` row is what carries the person into vote_count.
    expect(raw.prepare('SELECT score FROM ratings').get()).toEqual({ score: null });
  });

  it('adding one to an existing set moves only that one', async () => {
    await vote(token, { emotions: ['shocked'] });
    expect(counts()).toEqual({ shocked: 1 });
    const res = await vote(token, { emotions: ['shocked', 'thrilled'] });
    expect(res.json.aggregate.emotion_counts).toEqual({ shocked: 1, thrilled: 1 });
    expect(held()).toEqual(['shocked', 'thrilled']);
  });

  it('an empty array clears the set and decrements everything in it', async () => {
    await vote(token, { score: 8, emotions: ['shocked', 'thrilled'] });
    const res = await vote(token, { score: 8, emotions: [] });
    expect(res.status).toBe(200);
    expect(res.json.aggregate.emotion_counts).toEqual({ shocked: 0, thrilled: 0 });
    expect(held()).toEqual([]);
    // The vote itself survives the clear; the person still rated it.
    expect(res.json.aggregate.vote_count).toBe(1);
    expect(res.json.aggregate.score_sum).toBe(8);
  });

  it('an ABSENT emotions field leaves the set exactly where it is', async () => {
    await vote(token, { emotions: ['shocked', 'thrilled'] });
    // A score-only edit. Not sending feelings must never be read as "none".
    const res = await vote(token, { score: 10 });
    expect(res.json.aggregate.emotion_counts).toEqual({ shocked: 1, thrilled: 1 });
    expect(held()).toEqual(['shocked', 'thrilled']);
  });

  it('re-sending the same set is a no-op — no drift, however many times', async () => {
    for (let i = 0; i < 5; i++) await vote(token, { emotions: ['thrilled', 'shocked'] });
    expect(counts()).toEqual({ shocked: 1, thrilled: 1 });
    expect(held()).toEqual(['shocked', 'thrilled']);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM ratings').get()).toEqual({ n: 1 });
  });

  it('swapping a feeling decrements the old and increments the new', async () => {
    await vote(token, { emotions: ['sad'] });
    await vote(token, { emotions: ['amused'] });
    expect(counts()).toEqual({ sad: 0, amused: 1 });
    expect(held()).toEqual(['amused']);
  });

  it('two people with overlapping sets add up per selection', async () => {
    await vote(token, { emotions: ['shocked', 'thrilled'] });
    await vote(await tokenFor(env, 'p2'), { emotions: ['shocked', 'sad'], score: 6 });
    expect(counts()).toEqual({ shocked: 2, thrilled: 1, sad: 1 });
    expect(
      raw.prepare('SELECT vote_count FROM rating_aggregates').get(),
    ).toEqual({ vote_count: 2 }); // people, not selections
  });

  it('one person’s clear never touches another person’s selections', async () => {
    await vote(token, { emotions: ['shocked'] });
    await vote(await tokenFor(env, 'p2'), { emotions: ['shocked'] });
    await vote(token, { emotions: [] });
    expect(counts()).toEqual({ shocked: 1 });
    expect(held('p2')).toEqual(['shocked']);
  });

  it('the old single `emotion` field still works, and null still means absent', async () => {
    await vote(token, { emotion: 'shocked' });
    expect(counts()).toEqual({ shocked: 1 });
    await vote(token, { score: 4, emotion: null });
    expect(counts()).toEqual({ shocked: 1 });
    expect(held()).toEqual(['shocked']);
  });

  it('refuses a garbage set before any JSON path is built', async () => {
    for (const emotions of [['nope'], ['sad', 'nope'], 'sad', [{}], ["x\"] , '$.y"]]) {
      const res = await vote(token, { emotions });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('invalid_body');
    }
    expect(raw.prepare('SELECT COUNT(*) AS n FROM emotion_votes').get()).toEqual({ n: 0 });
  });

  it('refuses a clear of nothing — that body is an empty vote', async () => {
    const res = await vote(token, { score: null, emotions: [] });
    expect(res.status).toBe(400);
    expect(res.json.error.message).toContain('empty_vote');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM ratings').get()).toEqual({ n: 0 });
  });

  it('never lets a count go negative, even from an already-empty blob', async () => {
    await vote(token, { emotions: ['sad'] });
    await vote(token, { emotions: [] });
    await vote(token, { emotions: ['sad'] });
    await vote(token, { emotions: [] });
    expect(counts()).toEqual({ sad: 0 });
  });
});

// ── the bulk import ──────────────────────────────────────────────────────────

describe('POST /v1/ratings/import — sets from an archive', () => {
  let raw: Database.Database;
  let env: Env;
  let token: string;

  const item = (over: Record<string, unknown> = {}) => ({
    target_source: 'tvdb',
    target_key: '121361',
    season: 1,
    episode: 3,
    score: 9,
    emotions: ['shocked', 'thrilled'],
    created_at: '2019-05-19T21:00:00.000Z',
    ...over,
  });

  const aggregate = () =>
    raw
      .prepare(
        `SELECT vote_count, score_sum, emotion_counts FROM rating_aggregates
          WHERE target_key = '121361' AND season = 1 AND episode = 3`,
      )
      .get() as { vote_count: number; score_sum: number; emotion_counts: string };

  beforeEach(async () => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    env = makeEnv(fresh.db);
    insertProfile(raw, 'p1', 'mahmood');
    token = await tokenFor(env, 'p1');
  });

  it('seeds every feeling in an item, not the first one', async () => {
    const res = await call(env, 'POST', '/v1/ratings/import', { token, body: { items: [item()] } });
    expect(res.json).toEqual({ imported: 1, skipped: 0 });
    expect(aggregate()).toEqual({
      vote_count: 1,
      score_sum: 9,
      emotion_counts: '{"shocked":1,"thrilled":1}',
    });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM emotion_votes').get()).toEqual({ n: 2 });
  });

  it('carries the archive’s own timestamp onto each selection', async () => {
    await call(env, 'POST', '/v1/ratings/import', { token, body: { items: [item()] } });
    expect(
      raw.prepare('SELECT DISTINCT created_at AS at FROM emotion_votes').all(),
    ).toEqual([{ at: '2019-05-19T21:00:00.000Z' }]);
  });

  it('is a no-op on re-import — the guard sees the rows it wrote last time', async () => {
    const body = { items: [item(), item({ target_key: '999' })] };
    await call(env, 'POST', '/v1/ratings/import', { token, body });
    const second = await call(env, 'POST', '/v1/ratings/import', { token, body });
    expect(second.json).toEqual({ imported: 0, skipped: 2 });
    expect(aggregate()).toEqual({
      vote_count: 1,
      score_sum: 9,
      emotion_counts: '{"shocked":1,"thrilled":1}',
    });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM emotion_votes').get()).toEqual({ n: 4 });
  });

  it('dedupes the same feeling twice inside one payload', async () => {
    await call(env, 'POST', '/v1/ratings/import', { token, body: { items: [item(), item()] } });
    expect(aggregate().emotion_counts).toBe('{"shocked":1,"thrilled":1}');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM emotion_votes').get()).toEqual({ n: 2 });
  });

  it('takes the old single `emotion` spelling from an older client', async () => {
    await call(env, 'POST', '/v1/ratings/import', {
      token,
      body: { items: [item({ emotions: undefined, emotion: 'bored' })] },
    });
    expect(aggregate().emotion_counts).toBe('{"bored":1}');
  });

  it('skips an item whose set is not an allow-listed set, whole', async () => {
    const res = await call(env, 'POST', '/v1/ratings/import', {
      token,
      body: { items: [item({ emotions: ['shocked', 'nope'] })] },
    });
    expect(res.json).toEqual({ imported: 0, skipped: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM emotion_votes').get()).toEqual({ n: 0 });
  });

  it('imports feelings with no score at all', async () => {
    await call(env, 'POST', '/v1/ratings/import', {
      token,
      body: { items: [item({ score: null })] },
    });
    expect(aggregate()).toEqual({
      vote_count: 1,
      score_sum: 0,
      emotion_counts: '{"shocked":1,"thrilled":1}',
    });
  });
});

// ── the night shift ──────────────────────────────────────────────────────────

describe('maintenance covers emotion_votes', () => {
  let raw: Database.Database;
  let env: Env;

  const feeling = (author: string, key: string, emotion: string, source = 'tvdb') =>
    raw
      .prepare(
        `INSERT INTO emotion_votes
           (author_id, target_source, target_key, season, episode, emotion, created_at)
         VALUES (?, ?, ?, -1, -1, ?, '2026-07-01T00:00:00.000Z')`,
      )
      .run(author, source, key, emotion);

  beforeEach(() => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    env = makeEnv(fresh.db);
  });

  it('rebuilds emotion_counts from the selections, several per person', async () => {
    insertProfile(raw, 'p1', 'mahmood');
    insertProfile(raw, 'p2', 'sara');
    raw
      .prepare(
        `INSERT INTO ratings (id, author_id, target_source, target_key, score, created_at)
         VALUES ('r1', 'p1', 'tvdb', '111', NULL, '2026-07-01T00:00:00.000Z'),
                ('r2', 'p2', 'tvdb', '111', 8, '2026-07-01T00:00:00.000Z')`,
      )
      .run();
    for (const [who, e] of [
      ['p1', 'shocked'],
      ['p1', 'thrilled'],
      ['p2', 'shocked'],
    ] as const) {
      feeling(who, '111', e);
    }
    raw
      .prepare(
        `INSERT INTO rating_aggregates
           (target_source, target_key, season, episode, vote_count, score_sum, emotion_counts,
            score_counts, updated_at)
         VALUES ('tvdb', '111', -1, -1, 2, 8, '{"shocked":9}', '{"8":1}', '2026-07-01T00:00:00.000Z')`,
      )
      .run();

    expect((await reconcileRatingAggregates(env.DB)).corrected).toBe(1);
    expect(
      raw.prepare(`SELECT vote_count, emotion_counts FROM rating_aggregates`).get(),
    ).toEqual({ vote_count: 2, emotion_counts: '{"shocked":2,"thrilled":1}' });
  });

  it('does not call a row a ghost while it still has feelings on it', async () => {
    // A target whose only expression is a feeling — no `ratings` row survived an
    // account deletion, but the selections of everybody else did.
    insertProfile(raw, 'p1', 'mahmood');
    feeling('p1', '222', 'sad');
    raw
      .prepare(
        `INSERT INTO rating_aggregates
           (target_source, target_key, season, episode, vote_count, score_sum, emotion_counts,
            score_counts, updated_at)
         VALUES ('tvdb', '222', -1, -1, 0, 0, '{"sad":1}', '{}', '2026-07-01T00:00:00.000Z')`,
      )
      .run();
    await reconcileRatingAggregates(env.DB);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM rating_aggregates').get()).toEqual({ n: 1 });
  });

  it('the purge cascade takes a deleted account’s selections with it', async () => {
    insertProfile(raw, 'gone', 'gone', '2026-01-01T00:00:00.000Z');
    insertProfile(raw, 'stays', 'stays');
    feeling('gone', '111', 'sad');
    feeling('stays', '111', 'sad');

    const res = await purgeSoftDeleted(env.DB, env);
    expect(res.purged).toBe(1);
    expect(raw.prepare('SELECT author_id FROM emotion_votes').all()).toEqual([
      { author_id: 'stays' },
    ]);
  });

  it('the title-thread merge re-keys selections onto the tvdb key', async () => {
    insertProfile(raw, 'p1', 'mahmood');
    insertProfile(raw, 'p2', 'sara');
    feeling('p1', 'amado|2011', 'shocked', 'title');
    feeling('p1', 'amado|2011', 'thrilled', 'title');
    feeling('p2', '428391', 'sad');

    const res = await migrateTitleThreads(env.DB, [
      { old_key: 'amado|2011', new_source: 'tvdb', new_key: '428391' },
    ]);
    expect(res.emotions).toBe(2);
    expect(
      raw.prepare(`SELECT COUNT(*) AS n FROM emotion_votes WHERE target_source = 'title'`).get(),
    ).toEqual({ n: 0 });
    expect(
      raw.prepare(`SELECT COUNT(*) AS n FROM emotion_votes WHERE target_key = '428391'`).get(),
    ).toEqual({ n: 3 });
  });

  it('a person who felt the same thing on both keys keeps one row, not an aborted migration', async () => {
    insertProfile(raw, 'p1', 'mahmood');
    feeling('p1', 'amado|2011', 'shocked', 'title');
    feeling('p1', '428391', 'shocked');

    const res = await migrateTitleThreads(env.DB, [
      { old_key: 'amado|2011', new_source: 'tvdb', new_key: '428391' },
    ]);
    // OR IGNORE: the duplicate stays behind rather than taking the whole
    // mapping down with it. The recount settles the count that night.
    expect(res.emotions).toBe(0);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM emotion_votes').get()).toEqual({ n: 2 });
  });
});
