/**
 * Giving somebody Plus from the dashboard.
 *
 * `plus_until` AND NEVER `is_plus`. The flag belongs to the RevenueCat webhook
 * and means "this person is paying". Writing it by hand would make the server
 * believe in a subscription that does not exist, it would be overwritten by the
 * next webhook anyway, and it would put a hand-out into the revenue numbers.
 * The date is the hand-grant lane, and `plusEntitled()` honours both.
 *
 * The one behaviour worth its own test is EXTENDING: a grant added to a live
 * grant has to reach further out, not reset to a month from today. Anything
 * else silently takes time away from the person being given something, which
 * is the opposite of the intent every single time this route is used.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '@/env';
import { call, freshDatabase, makeEnv } from './harness';

let raw: Database.Database;
let env: Env;
let cookie: string;

function profile(id: string, plusUntil: string | null = null, isPlus = 0): void {
  raw
    .prepare(
      'INSERT INTO profiles (id, handle, handle_lower, created_at, plus_until, is_plus) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, id, id, '2026-08-01T00:00:00.000Z', plusUntil, isPlus);
}

const read = (h: string) =>
  raw.prepare('SELECT plus_until AS until, is_plus AS flag FROM profiles WHERE handle_lower = ?').get(h) as {
    until: string | null;
    flag: number;
  };

const give = (handle: string, months: number) =>
  call(env, 'POST', `/v1/admin/users/${handle}/plus`, { body: { months }, headers: { Cookie: cookie } });

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = { ...makeEnv(fresh.db), ADMIN_EMAIL: 'me@example.com', ADMIN_PASSWORD: 'a-long-one' } as Env;
  const res = await call(env, 'POST', '/v1/admin/login', {
    body: { email: 'me@example.com', password: 'a-long-one' },
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
});

describe('POST /v1/admin/users/:handle/plus', () => {
  it('refuses without the admin cookie', async () => {
    profile('amanda');
    const res = await call(env, 'POST', '/v1/admin/users/amanda/plus', { body: { months: 1 } });
    expect(res.status).toBe(401);
    expect(read('amanda').until).toBeNull();
  });

  it('gives a month, and does not touch the paying flag', async () => {
    profile('amanda');
    const res = await give('amanda', 1);
    expect(res.status).toBe(200);
    const row = read('amanda');
    expect(row.until).not.toBeNull();
    // The webhook owns this. A gift must never look like revenue.
    expect(row.flag).toBe(0);
    expect(Date.parse(row.until as string)).toBeGreaterThan(Date.now());
  });

  it('EXTENDS a live grant instead of resetting it', async () => {
    // Three weeks left plus one month should be about seven weeks, not four.
    const threeWeeks = new Date(Date.now() + 21 * 86400000).toISOString();
    profile('amanda', threeWeeks);
    await give('amanda', 1);
    const days = (Date.parse(read('amanda').until as string) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(45);
  });

  it('starts from today when the old grant has already expired', async () => {
    // Otherwise "one month" would be measured from a date in the past and the
    // person would be given something that is already over.
    profile('amanda', '2020-01-01T00:00:00.000Z');
    await give('amanda', 1);
    const days = (Date.parse(read('amanda').until as string) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(33);
  });

  it('gives a year', async () => {
    profile('amanda');
    await give('amanda', 12);
    const days = (Date.parse(read('amanda').until as string) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(360);
  });

  it('removes the grant on months = 0', async () => {
    profile('amanda', new Date(Date.now() + 86400000).toISOString());
    const res = await give('amanda', 0);
    expect(res.status).toBe(200);
    expect(read('amanda').until).toBeNull();
  });

  it('leaves a paying subscriber’s flag alone when removing a grant', async () => {
    // Somebody who was given a month AND then subscribed properly must keep
    // their subscription when the gift is cleared.
    profile('amanda', new Date(Date.now() + 86400000).toISOString(), 1);
    await give('amanda', 0);
    const row = read('amanda');
    expect(row.until).toBeNull();
    expect(row.flag).toBe(1);
  });

  it('refuses nonsense month counts rather than writing a strange date', async () => {
    profile('amanda');
    for (const bad of [-1, 13, 1.5, 'two', null]) {
      const res = await call(env, 'POST', '/v1/admin/users/amanda/plus', {
        body: { months: bad },
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(400);
    }
    expect(read('amanda').until).toBeNull();
  });

  it('404s for a handle that does not exist', async () => {
    const res = await give('nobody', 1);
    expect(res.status).toBe(404);
  });

  it('ignores a deleted profile', async () => {
    profile('amanda');
    raw.prepare("UPDATE profiles SET deleted_at = ? WHERE handle_lower = 'amanda'").run('2026-08-30T00:00:00.000Z');
    const res = await give('amanda', 1);
    expect(res.status).toBe(404);
  });
});
