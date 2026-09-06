import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { call, freshDatabase, makeEnv } from './harness';

/**
 * The dashboard's door. The cases here are the ones where being wrong is
 * invisible from the outside: a missing secret that opens rather than closes,
 * a cookie accepted without its signature, and an expiry nobody checks.
 */
describe('the admin dashboard', () => {
  let env: Env;
  /** The same database the env holds, for arranging rows a route cannot make. */
  let raw: ReturnType<typeof freshDatabase>['raw'];

  beforeEach(() => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    env = { ...makeEnv(fresh.db), ADMIN_EMAIL: 'me@example.com', ADMIN_PASSWORD: 'a-long-one' };
  });

  const login = (over: Record<string, string> = {}) =>
    call(env, 'POST', '/v1/admin/login', {
      body: { email: 'me@example.com', password: 'a-long-one', ...over },
    });

  it('refuses everything when no administrator is configured', async () => {
    const bare = makeEnv(freshDatabase().db);
    const res = await call(bare, 'POST', '/v1/admin/login', {
      body: { email: '', password: '' },
    });
    // The dangerous failure is comparing against undefined and letting an
    // empty password through.
    expect(res.status).toBe(503);
  });

  it('refuses a wrong password, and says nothing about which half was wrong', async () => {
    const wrongPass = await login({ password: 'not-it-at-all' });
    const wrongUser = await login({ email: 'someone@example.com' });
    expect(wrongPass.status).toBe(401);
    expect(wrongUser.status).toBe(401);
    expect(wrongPass.json).toEqual(wrongUser.json);
  });

  it('lets the right pair in and hands back an HttpOnly cookie', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('otv_admin=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('refuses stats without a cookie, and with a forged one', async () => {
    expect((await call(env, 'GET', '/v1/admin/stats')).status).toBe(401);

    const forged = await call(env, 'GET', '/v1/admin/stats', {
      headers: { Cookie: 'otv_admin=eyJleHAiOjk5OTk5OTk5OTl9.not-a-real-signature' },
    });
    expect(forged.status).toBe(401);
  });

  it('answers stats with the cookie it just issued', async () => {
    const cookie = (await login()).headers.get('set-cookie')!.split(';')[0]!;
    const res = await call(env, 'GET', '/v1/admin/stats', { headers: { Cookie: cookie } });

    expect(res.status).toBe(200);
    expect(res.json.totals.accounts).toBe(0);
    expect(Array.isArray(res.json.joins)).toBe(true);
  });

  it('answers the activity windows, and they are numbers rather than absent', async () => {
    const cookie = (await login()).headers.get('set-cookie')!.split(';')[0]!;
    const res = await call(env, 'GET', '/v1/admin/stats', { headers: { Cookie: cookie } });
    const t = res.json.totals;
    // A window that silently vanished from the query would render as an empty
    // card rather than an error, so the shape is what is worth asserting.
    for (const k of [
      'comments_today', 'comments_7d', 'comments_30d',
      'ratings_today', 'ratings_7d', 'ratings_30d',
      'characters_today', 'characters_7d', 'characters_30d',
      // People, which is the half a single bulk import cannot inflate.
      'raters_today', 'raters_7d', 'raters_30d',
      'commenters_today', 'commenters_7d', 'commenters_30d',
      'voters_today', 'voters_7d', 'voters_30d',
    ]) {
      expect(typeof t[k]).toBe('number');
    }
    // Windows nest: a day is inside a week is inside a month.
    expect(t.comments_today).toBeLessThanOrEqual(t.comments_7d);
    expect(t.comments_7d).toBeLessThanOrEqual(t.comments_30d);
  });

  it('counts what was written here, never what arrived in bulk', async () => {
    const cookie = (await login()).headers.get('set-cookie')!.split(';')[0]!;
    const now = new Date().toISOString();
    // One rating written tonight, one seeded from an archive an hour ago. Both
    // are real rows with today's created_at; only the first is activity.
    raw
      .prepare(`INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES ('p1', 'someone', 'someone', ?)`)
      .run(now);
    raw
      .prepare(
        `INSERT INTO ratings (id, author_id, target_source, target_key, score, created_at, imported_at)
         VALUES ('r1', 'p1', 'tvdb', 'tvdb:1', 5, ?, NULL), ('r2', 'p1', 'tvdb', 'tvdb:2', 4, ?, ?)`,
      )
      .run(now, now, now);

    const res = await call(env, 'GET', '/v1/admin/stats', { headers: { Cookie: cookie } });
    expect(res.json.totals.ratings).toBe(2);
    expect(res.json.totals.ratings_today).toBe(1);
    expect(res.json.totals.raters_today).toBe(1);
  });

  it('lists people without listing anything they wrote', async () => {
    const cookie = (await login()).headers.get('set-cookie')!.split(';')[0]!;
    const res = await call(env, 'GET', '/v1/admin/users', { headers: { Cookie: cookie } });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.items)).toBe(true);
    // The line this route sits on: who, and how much, never what. A body field
    // appearing here would be the thing to catch.
    expect(res.text).not.toContain('body');
  });

  it('refuses the people list without a cookie', async () => {
    expect((await call(env, 'GET', '/v1/admin/users')).status).toBe(401);
  });

  it('serves the page itself, unindexed', async () => {
    const res = await call(env, 'GET', '/admin/dashboard');
    expect(res.status).toBe(200);
    expect(res.text).toContain('OpenTV');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });
});
