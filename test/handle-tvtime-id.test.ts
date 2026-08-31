/**
 * One TV Time account, one profile.
 *
 * WHAT THIS DEFENDS AGAINST, and what it does not. Claiming a handle has always
 * been first come, first served: nothing checked that the person claiming
 * `@amanda` was the Amanda who wrote nine years of comments under it. This does
 * NOT fix that, and the tests are written so nobody later reads them as if it
 * did — an id proves you hold an export, not that you are the person in it, and
 * somebody who imports a friend's export passes it as easily as its owner.
 *
 * What it fixes is the cheap version: one export used over and over to take
 * name after name. A TV Time account belongs to one person, so its id may sit
 * on one profile — after which a squatter needs a distinct real export per
 * name, which is the difference between a script and a project.
 *
 * That mattered little at 75 accounts. It matters the day this is where TV Time
 * people are moving, because the names worth squatting are exactly the ones
 * people would recognise, and somebody who loses their own name has no way to
 * appeal it.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '@/env';
import { call, freshDatabase, makeEnv, tokenFor } from './harness';

let raw: Database.Database;
let env: Env;

/** A profile with no handle yet, which is the state a new account is in. */
function profile(id: string, tvtimeUserId: number | null = null): void {
  raw
    .prepare('INSERT INTO profiles (id, handle, handle_lower, created_at, tvtime_user_id) VALUES (?, ?, ?, ?, ?)')
    .run(id, id, id, '2026-08-31T00:00:00.000Z', tvtimeUserId);
}

const idOf = (p: string) => raw.prepare('SELECT tvtime_user_id AS v FROM profiles WHERE id = ?').get(p) as { v: number | null };

beforeEach(() => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = makeEnv(fresh.db);
});

describe('POST /v1/me/handle — the TV Time id', () => {
  it('records the id when the claim wins the handle', async () => {
    profile('p1');
    const res = await call(env, 'POST', '/v1/me/handle', {
      token: await tokenFor(env, 'p1'),
      body: { handle: 'amanda', tvtime_user_id: 12345 },
    });
    expect(res.status).toBe(200);
    expect(idOf('p1').v).toBe(12345);
  });

  it('refuses a second profile claiming with the SAME export', async () => {
    // The whole point: one TV Time account cannot be two people here.
    profile('p1', 12345);
    profile('p2');
    const res = await call(env, 'POST', '/v1/me/handle', {
      token: await tokenFor(env, 'p2'),
      body: { handle: 'amanda_2', tvtime_user_id: 12345 },
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('tvtime_id_claimed');
    // And it did not half-succeed: no handle, no id.
    expect(idOf('p2').v).toBeNull();
  });

  it('lets the SAME profile claim again with its own id', async () => {
    // Changing your own handle later must not trip over your own id.
    profile('p1', 12345);
    const res = await call(env, 'POST', '/v1/me/handle', {
      token: await tokenFor(env, 'p1'),
      body: { handle: 'amanda_new', tvtime_user_id: 12345 },
    });
    expect(res.status).toBe(200);
  });

  it('ignores an id held by a DELETED profile', async () => {
    /*
     * Somebody who deleted their account and signed up again is the same
     * person, and their export is the same export. Holding their own id against
     * them would lock them out of their own name for ever, with no appeal —
     * which is the exact harm this feature exists to prevent.
     */
    profile('gone', 12345);
    raw.prepare("UPDATE profiles SET deleted_at = ? WHERE id = 'gone'").run('2026-08-30T00:00:00.000Z');
    profile('p2');
    const res = await call(env, 'POST', '/v1/me/handle', {
      token: await tokenFor(env, 'p2'),
      body: { handle: 'amanda', tvtime_user_id: 12345 },
    });
    expect(res.status).toBe(200);
    expect(idOf('p2').v).toBe(12345);
  });

  it('is write-once: a second, different id does not overwrite the first', async () => {
    // A profile does not become a different TV Time person later. `reconcile`
    // writes the same column under the same rule, so whichever lands first wins
    // and the other is a no-op rather than a silent overwrite.
    profile('p1', 111);
    const res = await call(env, 'POST', '/v1/me/handle', {
      token: await tokenFor(env, 'p1'),
      body: { handle: 'newname', tvtime_user_id: 999 },
    });
    expect(res.status).toBe(200);
    expect(idOf('p1').v).toBe(111);
  });

  it('leaves grandfathered claims alone — no id sent, nothing checked', async () => {
    /*
     * Every handle taken before this shipped has a NULL id and must stay
     * exactly as valid as it was. A hand-typed handle sends no id either.
     */
    profile('p1', 12345);
    profile('p2');
    const res = await call(env, 'POST', '/v1/me/handle', {
      token: await tokenFor(env, 'p2'),
      body: { handle: 'somebody_else' },
    });
    expect(res.status).toBe(200);
    expect(idOf('p2').v).toBeNull();
  });

  it('still refuses a handle somebody else holds, id or no id', async () => {
    // The new rule is additional. It must not have replaced the old one.
    profile('p1');
    await call(env, 'POST', '/v1/me/handle', { token: await tokenFor(env, 'p1'), body: { handle: 'amanda' } });
    profile('p2');
    const res = await call(env, 'POST', '/v1/me/handle', {
      token: await tokenFor(env, 'p2'),
      body: { handle: 'amanda', tvtime_user_id: 777 },
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('handle_taken');
    // The handle was refused, so the id must not have been recorded either.
    expect(idOf('p2').v).toBeNull();
  });

  it('rejects an id that is not a positive integer', async () => {
    profile('p1');
    const token = await tokenFor(env, 'p1');
    for (const bad of [0, -1, 1.5, 'twelve', {}]) {
      const res = await call(env, 'POST', '/v1/me/handle', {
        token,
        body: { handle: 'amanda', tvtime_user_id: bad },
      });
      expect(res.status).toBe(400);
    }
  });

  it('accepts a null id as "not supplied" rather than as a value', async () => {
    profile('p1');
    const res = await call(env, 'POST', '/v1/me/handle', {
      token: await tokenFor(env, 'p1'),
      body: { handle: 'amanda', tvtime_user_id: null },
    });
    expect(res.status).toBe(200);
    expect(idOf('p1').v).toBeNull();
  });

  it('reports the clash on check_only too, before anything is written', async () => {
    // The app asks this before showing "that name is yours" — it must not
    // promise a handle the real claim will refuse.
    profile('p1', 12345);
    profile('p2');
    const res = await call(env, 'POST', '/v1/me/handle', {
      token: await tokenFor(env, 'p2'),
      body: { handle: 'amanda', check_only: true, tvtime_user_id: 12345 },
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('tvtime_id_claimed');
  });
});
