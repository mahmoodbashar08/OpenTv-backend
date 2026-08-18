import { describe, expect, it } from 'vitest';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';
import type { Env } from '@/env';

/**
 * The development Plus switch. Everything worth testing here is a refusal —
 * this route grants entitlement, so what matters is every case where it must
 * not.
 */

function seed(secret?: string): { env: Env; raw: ReturnType<typeof freshDatabase>['raw'] } {
  const { raw, db } = freshDatabase();
  insertProfile(raw, 'p_me', 'me');
  insertProfile(raw, 'p_other', 'other');
  const env = { ...makeEnv(db), ...(secret ? { DEV_PLUS_SECRET: secret } : {}) } as Env;
  return { env, raw };
}

const isPlus = (raw: ReturnType<typeof freshDatabase>['raw'], id: string) =>
  (raw.prepare('SELECT is_plus FROM profiles WHERE id = ?').get(id) as { is_plus: number }).is_plus;

describe('POST /v1/dev/plus', () => {
  it('turns the tier on for the caller', async () => {
    const { env, raw } = seed('shh');
    const token = await tokenFor(env, 'p_me');
    const res = await call(env, 'POST', '/v1/dev/plus', {
      token,
      body: { on: true },
      headers: { 'X-Dev-Secret': 'shh' },
    });
    expect(res.status).toBe(200);
    expect(isPlus(raw, 'p_me')).toBe(1);
  });

  it('turns it off again, and clears a date that would outlive the switch', async () => {
    const { env, raw } = seed('shh');
    raw.prepare("UPDATE profiles SET is_plus = 1, plus_until = '2099-01-01T00:00:00.000Z' WHERE id = 'p_me'").run();
    const token = await tokenFor(env, 'p_me');
    await call(env, 'POST', '/v1/dev/plus', { token, body: { on: false }, headers: { 'X-Dev-Secret': 'shh' } });
    const row = raw.prepare('SELECT is_plus, plus_until FROM profiles WHERE id = ?').get('p_me') as {
      is_plus: number;
      plus_until: string | null;
    };
    expect(row.is_plus).toBe(0);
    // Without this, plusOn() would keep the tier alive off a stale future date.
    expect(row.plus_until).toBeNull();
  });

  it('does not exist at all on a deployment with no secret set', async () => {
    const { env, raw } = seed();
    const token = await tokenFor(env, 'p_me');
    const res = await call(env, 'POST', '/v1/dev/plus', {
      token,
      body: { on: true },
      headers: { 'X-Dev-Secret': 'shh' },
    });
    expect(res.status).toBe(404);
    expect(isPlus(raw, 'p_me')).toBe(0);
  });

  it('answers a wrong secret the same way as a missing route, telling nobody it is there', async () => {
    const { env, raw } = seed('shh');
    const token = await tokenFor(env, 'p_me');
    const res = await call(env, 'POST', '/v1/dev/plus', {
      token,
      body: { on: true },
      headers: { 'X-Dev-Secret': 'wrong' },
    });
    expect(res.status).toBe(404);
    expect(isPlus(raw, 'p_me')).toBe(0);
  });

  it('needs a session as well as the secret', async () => {
    const { env, raw } = seed('shh');
    const res = await call(env, 'POST', '/v1/dev/plus', {
      body: { on: true },
      headers: { 'X-Dev-Secret': 'shh' },
    });
    expect(res.status).toBe(401);
    expect(isPlus(raw, 'p_me')).toBe(0);
  });

  it('cannot reach anybody else, because there is nowhere to name them', async () => {
    const { env, raw } = seed('shh');
    const token = await tokenFor(env, 'p_me');
    await call(env, 'POST', '/v1/dev/plus', {
      token,
      // A handle in the body is simply ignored — the route reads the session.
      body: { on: true, handle: 'other', id: 'p_other' },
      headers: { 'X-Dev-Secret': 'shh' },
    });
    expect(isPlus(raw, 'p_me')).toBe(1);
    expect(isPlus(raw, 'p_other')).toBe(0);
  });

  it('refuses a body that does not say which way', async () => {
    const { env } = seed('shh');
    const token = await tokenFor(env, 'p_me');
    const res = await call(env, 'POST', '/v1/dev/plus', {
      token,
      body: { on: 'yes' },
      headers: { 'X-Dev-Secret': 'shh' },
    });
    expect(res.status).toBe(400);
  });
});
