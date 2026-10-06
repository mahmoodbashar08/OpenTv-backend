import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { SUPPORT_PER_DAY } from '@/routes/support-chat';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/** "Message the developer" (0050): one private thread per person, answered from the dashboard. */
let env: Env;
let raw: ReturnType<typeof freshDatabase>['raw'];
let cookie: string;

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = { ...makeEnv(fresh.db), ADMIN_EMAIL: 'me@example.com', ADMIN_PASSWORD: 'a-long-one' } as Env;
  insertProfile(raw, 'p1', 'asker');
  insertProfile(raw, 'p2', 'other');
  const res = await call(env, 'POST', '/v1/admin/login', { body: { email: 'me@example.com', password: 'a-long-one' } });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
});

describe('support chat', () => {
  it('a person writes, the dashboard reads and replies, the person sees the reply', async () => {
    const tk = await tokenFor(env, 'p1');
    expect((await call(env, 'POST', '/v1/support', { token: tk, body: { body: '  where did my shows go?  ' } })).status).toBe(201);

    const threads = await call(env, 'GET', '/v1/admin/support', { headers: { Cookie: cookie } });
    const t = (threads.json as { threads: { profile_id: string; unread: number; last_body: string }[] }).threads;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ profile_id: 'p1', unread: 1, last_body: 'where did my shows go?' });

    await call(env, 'GET', '/v1/admin/support/p1', { headers: { Cookie: cookie } });
    expect((await call(env, 'POST', '/v1/admin/support/p1', { headers: { Cookie: cookie }, body: { body: 'Did you remove them?' } })).status).toBe(201);

    const mine = await call(env, 'GET', '/v1/support', { token: tk });
    const msgs = (mine.json as { messages: { fromDev: boolean; body: string }[] }).messages;
    expect(msgs.map((m) => [m.fromDev, m.body])).toEqual([
      [false, 'where did my shows go?'],
      [true, 'Did you remove them?'],
    ]);
    const unread = (await call(env, 'GET', '/v1/admin/support', { headers: { Cookie: cookie } })).json as { threads: { unread: number }[] };
    expect(unread.threads[0]!.unread).toBe(0);
  });

  it('nobody reads another person’s thread, and the dashboard needs its cookie', async () => {
    await call(env, 'POST', '/v1/support', { token: await tokenFor(env, 'p1'), body: { body: 'private' } });
    const other = await call(env, 'GET', '/v1/support', { token: await tokenFor(env, 'p2') });
    expect((other.json as { messages: unknown[] }).messages).toEqual([]);
    expect((await call(env, 'GET', '/v1/admin/support')).status).toBe(401);
    expect((await call(env, 'GET', '/v1/support')).status).toBe(401);
  });

  it('refuses empty or flooding messages', async () => {
    const tk = await tokenFor(env, 'p1');
    expect((await call(env, 'POST', '/v1/support', { token: tk, body: { body: '   ' } })).status).toBe(400);
    for (let i = 0; i < SUPPORT_PER_DAY; i++) await call(env, 'POST', '/v1/support', { token: tk, body: { body: `m${i}` } });
    expect((await call(env, 'POST', '/v1/support', { token: tk, body: { body: 'one more' } })).status).toBe(429);
  });

  it('goes with the account', async () => {
    const tk = await tokenFor(env, 'p1');
    await call(env, 'POST', '/v1/support', { token: tk, body: { body: 'hello' } });
    await call(env, 'DELETE', '/v1/me', { token: tk });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM support_messages WHERE profile_id = 'p1'").get()).toEqual({ n: 0 });
  });
});
