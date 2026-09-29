/**
 * "3 of your TV Time friends are already here" — a number, never a person.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '@/env';
import { call, freshDatabase, makeEnv } from './harness';

let env: Env;
let raw: ReturnType<typeof freshDatabase>['raw'];

beforeEach(() => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = makeEnv(fresh.db);
  const add = (id: string, handle: string, tv: number, priv = 0) =>
    raw.prepare('INSERT INTO profiles (id, handle, handle_lower, created_at, tvtime_user_id, is_private) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, handle, handle, '2026-09-29', tv, priv);
  add('p1', 'amy', 101);
  add('p2', 'ben', 102);
  add('p3', 'cat', 103, 1); // private: chose not to be found
  add('p4', 'user_p_abcd1234', 104); // account only, never joined
});

const ask = (ids: number[]) => call(env, 'POST', '/v1/friends/count', { body: { friend_ids: ids } });

describe('POST /v1/friends/count', () => {
  it('answers with a count of public members only, and nothing else', async () => {
    const res = await ask([101, 102, 103, 104, 105, 106]);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ found: 2 });
  });

  it('needs no account', async () => {
    expect((await ask([101, 102, 103, 104, 105])).status).toBe(200);
  });

  it('will not answer for fewer than five ids — no probing one person', async () => {
    expect((await ask([101])).json).toEqual({ found: 0 });
    expect((await ask([101, 102, 103, 104])).json).toEqual({ found: 0 });
  });

  it('refuses a body that is not a list of ids', async () => {
    expect((await call(env, 'POST', '/v1/friends/count', { body: { friend_ids: 'x' } })).status).toBe(400);
  });

  it('stores nothing', async () => {
    const before = raw.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number };
    await ask([101, 102, 103, 104, 105, 106]);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual(before);
  });
});
