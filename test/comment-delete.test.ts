import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * Deleting a comment the phone knows only as an ARCHIVE ROW.
 *
 * THE BUG THIS EXISTS FOR. Deleting an imported comment wrote a tombstone in
 * local storage and nothing else: the row vanished from that phone and stayed
 * on the public profile and in the thread, for everybody else. The button said
 * "Delete comment" and meant "hide on this device" -- and somebody removing
 * something they wrote nine years ago is usually removing it from OTHER PEOPLE.
 *
 * The local row has no server id, so the route derives one from what the
 * comment IS, exactly as the seeder and the image upload already do. What these
 * tests pin is that the derivation reaches the right comment and no other:
 * the thread must lose it, a comment that was never seeded must not be an
 * error, and the same fields sent by a different person must not touch it.
 */

let raw: ReturnType<typeof freshDatabase>['raw'];
let env: Env;
let owner: string;
let friend: string;

const ITEM = {
  target_source: 'tvdb',
  target_key: '121361',
  season: 1,
  episode: 3,
  body: 'That scene wrecked me.',
  created_at: '2019-04-02T10:00:00.000Z',
};

// The thread GET names its params `source`/`key`, not the `target_*` the
// write routes use.
const THREAD = '/v1/comments?source=tvdb&key=121361&season=1&episode=3';

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = makeEnv(fresh.db);
  insertProfile(raw, 'p_owner', 'owner');
  insertProfile(raw, 'p_friend', 'friend');
  owner = await tokenFor(env, 'p_owner');
  friend = await tokenFor(env, 'p_friend');
});

describe('POST /v1/comments/import/delete', () => {
  it('takes the comment out of the THREAD, not just off one phone', async () => {
    await call(env, 'POST', '/v1/comments/import', { token: owner, body: { items: [ITEM] } });
    expect((await call(env, 'GET', THREAD, { token: owner })).json.items).toHaveLength(1);

    const del = await call(env, 'POST', '/v1/comments/import/delete', { token: owner, body: ITEM });
    expect(del.status).toBe(200);
    expect(del.json.deleted).toBe(true);

    expect((await call(env, 'GET', THREAD, { token: owner })).json.items).toHaveLength(0);
  });

  it('a comment that was never seeded is a success with nothing to do', async () => {
    // An error here would put a failure in front of somebody whose comment is,
    // as far as they can tell, already gone.
    const res = await call(env, 'POST', '/v1/comments/import/delete', { token: owner, body: ITEM });
    expect(res.status).toBe(200);
    expect(res.json.deleted).toBe(false);
  });

  it('the same fields from somebody else reach nothing', async () => {
    await call(env, 'POST', '/v1/comments/import', { token: owner, body: { items: [ITEM] } });

    // The id is derived from the CALLER's own profile id, so this addresses a
    // comment that does not exist rather than the owner's.
    const res = await call(env, 'POST', '/v1/comments/import/delete', { token: friend, body: ITEM });
    expect(res.json.deleted).toBe(false);
    expect((await call(env, 'GET', THREAD, { token: owner })).json.items).toHaveLength(1);
  });

  it('refuses a body with no target', async () => {
    const res = await call(env, 'POST', '/v1/comments/import/delete', {
      token: owner,
      body: { body: 'x', created_at: ITEM.created_at },
    });
    expect(res.status).toBe(400);
  });
});
