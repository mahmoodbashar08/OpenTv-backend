import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * An account made for backup and sync only is nobody's to find (0049, 6 Oct):
 * not in user search, no public profile — while its owner still sees it, and
 * publishing or POST /v1/me/join makes it a member.
 */
let env: Env;
let raw: ReturnType<typeof freshDatabase>['raw'];

beforeEach(() => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = makeEnv(fresh.db);
  insertProfile(raw, 'p1', 'member');
  insertProfile(raw, 'p2', 'quietone');
  raw.prepare("UPDATE profiles SET joined_at = NULL WHERE id = 'p2'").run();
});

describe('an account only', () => {
  it('is not in user search, while a member is', async () => {
    const tk = await tokenFor(env, 'p1');
    const found = await call(env, 'GET', '/v1/users?q=quiet', { token: tk });
    expect(JSON.stringify(found.json)).not.toContain('quietone');
    const member = await call(env, 'GET', '/v1/users?q=memb', { token: await tokenFor(env, 'p2') });
    expect(JSON.stringify(member.json)).toContain('member');
  });

  it('has no public profile, except to its owner', async () => {
    expect((await call(env, 'GET', '/v1/profiles/quietone', { token: await tokenFor(env, 'p1') })).status).toBe(404);
    expect((await call(env, 'GET', '/v1/profiles/quietone', { token: await tokenFor(env, 'p2') })).status).toBe(200);
  });

  it('becomes a member on POST /v1/me/join', async () => {
    await call(env, 'POST', '/v1/me/join', { token: await tokenFor(env, 'p2') });
    expect((await call(env, 'GET', '/v1/profiles/quietone', { token: await tokenFor(env, 'p1') })).status).toBe(200);
  });

  it('becomes a member by publishing, whatever the app version', async () => {
    const stats = { episodes: 1, show_minutes: 40, movie_minutes: 0, shows: 1, movies: 0 };
    await call(env, 'PUT', '/v1/me/published', { token: await tokenFor(env, 'p2'), body: { kind: 'show', stats, titles: [] } });
    const row = raw.prepare("SELECT joined_at FROM profiles WHERE id = 'p2'").get() as { joined_at: string | null };
    expect(row.joined_at).not.toBeNull();
  });
});
