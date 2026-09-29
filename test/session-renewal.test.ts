import { describe, expect, it } from 'vitest';
import { RENEW_AFTER_SECONDS, SESSION_TTL_SECONDS, sign, verifyScoped } from '@/session';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * Found 27 Sep 2026: every member was signed out seven days after signing in,
 * however much they used the app, because no token was ever renewed. These pin
 * the fix — a longer life, and a fresh token handed back on every launch once
 * the current one is a day old.
 */
describe('session renewal', () => {
  it('lives sixty days', () => {
    expect(SESSION_TTL_SECONDS).toBe(60 * 24 * 60 * 60);
  });

  it('leaves a fresh token alone', async () => {
    const { raw, db } = freshDatabase();
    insertProfile(raw, 'p_me', 'me');
    const env = makeEnv(db);
    const res = await call(env, 'GET', '/v1/me', { token: await tokenFor(env, 'p_me') });
    expect(res.status).toBe(200);
    expect(res.json.session).toBeUndefined();
  });

  it('hands back a new token once the current one is a day old', async () => {
    const { raw, db } = freshDatabase();
    insertProfile(raw, 'p_me', 'me');
    const env = makeEnv(db);
    const old = (await sign(env, 'p_me', Date.now() - (RENEW_AFTER_SECONDS + 60) * 1000)).token;
    const res = await call(env, 'GET', '/v1/me', { token: old });
    expect(res.status).toBe(200);
    expect(typeof res.json.session?.token).toBe('string');
    expect(res.json.session.token).not.toBe(old);

    // The new one works, for the same profile, and runs a full sixty days from now.
    const v = await verifyScoped(env, res.json.session.token, Date.now());
    expect(v?.profileId).toBe('p_me');
    const exp = Date.parse(res.json.session.expires_at);
    expect(exp - Date.now()).toBeGreaterThan((SESSION_TTL_SECONDS - 60) * 1000);
  });

  /** A renewal may extend a token's life; it must never widen what it can do. */
  it('keeps the scope of the token it renews', async () => {
    const { raw, db } = freshDatabase();
    insertProfile(raw, 'p_me', 'me');
    const env = makeEnv(db);
    const old = (await sign(env, 'p_me', Date.now() - (RENEW_AFTER_SECONDS + 60) * 1000, 'unverified')).token;
    const res = await call(env, 'GET', '/v1/me', { token: old });
    const v = await verifyScoped(env, res.json.session.token, Date.now());
    expect(v?.scope).toBe('unverified');
  });

  it('still refuses a token that has already expired — renewal is not resurrection', async () => {
    const { raw, db } = freshDatabase();
    insertProfile(raw, 'p_me', 'me');
    const env = makeEnv(db);
    const dead = (await sign(env, 'p_me', Date.now() - (SESSION_TTL_SECONDS + 60) * 1000)).token;
    const res = await call(env, 'GET', '/v1/me', { token: dead });
    expect(res.status).toBe(401);
  });
});
