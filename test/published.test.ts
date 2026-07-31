import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { PUBLISH_MAX_TITLES } from '@/routes/published';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * The published profile — stats and shelves.
 *
 * Two things here can be quietly wrong and pass every naive test:
 *
 *  1. THE PARAMETER CEILING. D1 binds at most 100 per query, and a shelf is
 *     bound eight columns per row. A test that publishes two titles proves
 *     nothing about one that publishes two hundred — that is precisely how the
 *     aggregate list form shipped a 500 nobody saw until the 26th target.
 *  2. VISIBILITY. This endpoint hands out what somebody watches. A private
 *     profile leaking its shelves to a stranger, or a blocked account's shelves
 *     leaking at all, is the kind of bug that is invisible from the inside.
 */

let raw: Database.Database;
let env: Env;
let token: string;

const title = (i: number, over: Record<string, unknown> = {}) => ({
  target_source: 'tvdb',
  target_key: String(1000 + i),
  name: `Show ${i}`,
  poster: `https://art/${i}.jpg`,
  favourite: false,
  ...over,
});

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = makeEnv(fresh.db);
  insertProfile(raw, 'p1', 'mahmood');
  insertProfile(raw, 'p2', 'sara');
  token = await tokenFor(env, 'p1');
});

describe('PUT /v1/me/published', () => {
  it('stores a shelf and its stats', async () => {
    const res = await call(env, 'PUT', '/v1/me/published', {
      token,
      body: {
        kind: 'show',
        stats: { episodes_watched: 23560, minutes_watched: 850_000, movie_minutes: 12_000 },
        titles: [title(1), title(2, { favourite: true })],
      },
    });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, kind: 'show', titles: 2 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM profile_titles').get()).toEqual({ n: 2 });
    expect(raw.prepare('SELECT episodes_watched, minutes_watched, movie_minutes, shows_count FROM profile_stats').get()).toEqual({
      episodes_watched: 23560,
      // Shows and films are stored APART: the profile draws four cards, two of
      // which are about films alone, and a combined figure cannot be split back.
      minutes_watched: 850_000,
      movie_minutes: 12_000,
      shows_count: 2,
    });
  });

  it('handles a FULL shelf without exceeding D1’s parameter ceiling', async () => {
    // The harness throws above 100 binds, exactly as D1 does. Two hundred and
    // fifty rows at eight columns is 2,000 parameters: it only works chunked.
    const titles = Array.from({ length: PUBLISH_MAX_TITLES }, (_, i) => title(i));
    const res = await call(env, 'PUT', '/v1/me/published', {
      token,
      body: { kind: 'show', stats: {}, titles },
    });

    expect(res.status).toBe(200);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM profile_titles').get()).toEqual({ n: PUBLISH_MAX_TITLES });
  });

  it('REPLACES the shelf — a title dropped on the phone disappears here', async () => {
    await call(env, 'PUT', '/v1/me/published', {
      token,
      body: { kind: 'show', stats: {}, titles: [title(1), title(2), title(3)] },
    });
    await call(env, 'PUT', '/v1/me/published', {
      token,
      body: { kind: 'show', stats: {}, titles: [title(1)] },
    });

    const keys = raw.prepare('SELECT target_key FROM profile_titles').all() as { target_key: string }[];
    expect(keys.map((k) => k.target_key)).toEqual(['1001']);
  });

  it('leaves the OTHER kind alone', async () => {
    await call(env, 'PUT', '/v1/me/published', { token, body: { kind: 'show', stats: {}, titles: [title(1)] } });
    await call(env, 'PUT', '/v1/me/published', { token, body: { kind: 'movie', stats: {}, titles: [title(9)] } });

    const rows = raw.prepare('SELECT kind FROM profile_titles ORDER BY kind').all() as { kind: string }[];
    expect(rows.map((r) => r.kind)).toEqual(['movie', 'show']);
    // …and each kind's count is its own.
    expect(raw.prepare('SELECT shows_count, movies_count FROM profile_stats').get()).toEqual({
      shows_count: 1,
      movies_count: 1,
    });
  });

  it('drops a malformed title rather than the whole request', async () => {
    const res = await call(env, 'PUT', '/v1/me/published', {
      token,
      body: {
        kind: 'show',
        stats: {},
        titles: [title(1), { target_source: 'nope', target_key: 'x' }, { target_source: 'tvdb', target_key: '' }],
      },
    });
    expect(res.json.titles).toBe(1);
  });

  it('refuses more than the cap', async () => {
    const titles = Array.from({ length: PUBLISH_MAX_TITLES + 1 }, (_, i) => title(i));
    const res = await call(env, 'PUT', '/v1/me/published', { token, body: { kind: 'show', stats: {}, titles } });
    expect(res.status).toBe(413);
  });

  it('requires a session and a valid kind', async () => {
    expect((await call(env, 'PUT', '/v1/me/published', { body: { kind: 'show', titles: [] } })).status).toBe(401);
    expect(
      (await call(env, 'PUT', '/v1/me/published', { token, body: { kind: 'people', titles: [] } })).status,
    ).toBe(400);
  });
});

describe('GET /v1/profiles/:handle/published', () => {
  const publish = async () => {
    await call(env, 'PUT', '/v1/me/published', {
      token,
      body: {
        kind: 'show',
        stats: { episodes_watched: 100, minutes_watched: 4000 },
        titles: [title(1), title(2, { favourite: true, rank: 0 })],
      },
    });
    await call(env, 'PUT', '/v1/me/published', {
      token,
      body: { kind: 'movie', stats: { episodes_watched: 100, minutes_watched: 4000 }, titles: [title(9)] },
    });
  };

  it('returns the shelves and the stats', async () => {
    await publish();
    const res = await call(env, 'GET', '/v1/profiles/mahmood/published');

    expect(res.status).toBe(200);
    expect(res.json.stats.episodes_watched).toBe(100);
    expect(res.json.shows).toHaveLength(2);
    expect(res.json.movies).toHaveLength(1);
  });

  it('puts favourites first', async () => {
    await publish();
    const res = await call(env, 'GET', '/v1/profiles/mahmood/published');
    expect(res.json.shows[0]).toMatchObject({ target_key: '1002', favourite: true });
  });

  it('says stats are NULL when nothing has been published — not zero', async () => {
    // "Has watched nothing" and "has never synced" are different sentences and
    // the screen shows different things for them.
    const res = await call(env, 'GET', '/v1/profiles/sara/published');
    expect(res.status).toBe(200);
    expect(res.json.stats).toBeNull();
    expect(res.json.shows).toEqual([]);
  });

  it('is 404 for a profile that does not exist', async () => {
    expect((await call(env, 'GET', '/v1/profiles/nobody/published')).status).toBe(404);
  });

  it('hides a PRIVATE profile’s shelves from a stranger', async () => {
    await publish();
    raw.prepare("UPDATE profiles SET is_private = 1 WHERE id = 'p1'").run();

    expect((await call(env, 'GET', '/v1/profiles/mahmood/published')).status).toBe(403);
    // The owner still sees their own.
    const mine = await call(env, 'GET', '/v1/profiles/mahmood/published', { token });
    expect(mine.status).toBe(200);
    expect(mine.json.shows).toHaveLength(2);
  });

  it('shows a private profile to an accepted follower', async () => {
    await publish();
    raw.prepare("UPDATE profiles SET is_private = 1 WHERE id = 'p1'").run();
    raw
      .prepare("INSERT INTO follows (follower_id, followee_id, created_at) VALUES ('p2','p1','2026-01-01T00:00:00Z')")
      .run();

    const res = await call(env, 'GET', '/v1/profiles/mahmood/published', { token: await tokenFor(env, 'p2') });
    expect(res.status).toBe(200);
  });

  it('is 404 across a block, in either direction', async () => {
    await publish();
    const p2 = await tokenFor(env, 'p2');
    raw.prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES ('p1','p2','2026-01-01T00:00:00Z')").run();
    expect((await call(env, 'GET', '/v1/profiles/mahmood/published', { token: p2 })).status).toBe(404);

    raw.prepare('DELETE FROM blocks').run();
    raw.prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES ('p2','p1','2026-01-01T00:00:00Z')").run();
    expect((await call(env, 'GET', '/v1/profiles/mahmood/published', { token: p2 })).status).toBe(404);
  });

  it('goes with the account when it is deleted', async () => {
    await publish();
    raw.prepare("DELETE FROM profiles WHERE id = 'p1'").run();
    // ON DELETE CASCADE, so no orphaned shelf survives its owner.
    expect(raw.prepare('SELECT COUNT(*) AS n FROM profile_titles').get()).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM profile_stats').get()).toEqual({ n: 0 });
  });
});
