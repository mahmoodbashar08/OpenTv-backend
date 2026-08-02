import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import type { Env } from '@/env';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * Registering a phone for push.
 *
 * The decisions here that can be quietly wrong: a token that reaches the table
 * malformed fails at send time and nowhere else; a phone that changes hands
 * keeps pushing to the previous owner; and a token nobody owns can be deleted
 * by anybody, which is a way to silence someone.
 */
const TOKEN = 'ExponentPushToken[abc123DEF-_456]';

describe('POST /v1/push/tokens', () => {
  let raw: Database.Database;
  let env: Env;
  let token: string;

  beforeEach(async () => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    env = makeEnv(fresh.db);
    insertProfile(raw, 'p_a', 'amanda');
    insertProfile(raw, 'p_b', 'tweeter');
    token = await tokenFor(env, 'p_a');
  });

  it('registers a device', async () => {
    const res = await call(env, 'POST', '/v1/push/tokens', {
      token,
      body: { token: TOKEN, platform: 'ios' },
    });
    expect(res.status).toBe(200);
    const row = raw.prepare('SELECT profile_id, platform, disabled_at FROM push_tokens WHERE token = ?').get(TOKEN);
    expect(row).toMatchObject({ profile_id: 'p_a', platform: 'ios', disabled_at: null });
  });

  it('refuses anything that is not an Expo token', async () => {
    for (const bad of ['', 'not-a-token', 'fcm:APA91bH', 'ExponentPushToken[]']) {
      const res = await call(env, 'POST', '/v1/push/tokens', {
        token,
        body: { token: bad, platform: 'ios' },
      });
      expect(res.status).toBe(400);
    }
    expect(raw.prepare('SELECT COUNT(*) AS n FROM push_tokens').get()).toMatchObject({ n: 0 });
  });

  it('refuses an unknown platform', async () => {
    const res = await call(env, 'POST', '/v1/push/tokens', {
      token,
      body: { token: TOKEN, platform: 'web' },
    });
    expect(res.status).toBe(400);
  });

  it('needs a session', async () => {
    const res = await call(env, 'POST', '/v1/push/tokens', { body: { token: TOKEN, platform: 'ios' } });
    expect(res.status).toBe(401);
  });

  it('re-registering the same device updates rather than accumulating', async () => {
    await call(env, 'POST', '/v1/push/tokens', { token, body: { token: TOKEN, platform: 'ios' } });
    await call(env, 'POST', '/v1/push/tokens', { token, body: { token: TOKEN, platform: 'ios' } });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM push_tokens').get()).toMatchObject({ n: 1 });
  });

  it('moves the device when somebody else signs in on it', async () => {
    await call(env, 'POST', '/v1/push/tokens', { token, body: { token: TOKEN, platform: 'ios' } });
    const other = await tokenFor(env, 'p_b');
    await call(env, 'POST', '/v1/push/tokens', { token: other, body: { token: TOKEN, platform: 'ios' } });

    const row = raw.prepare('SELECT profile_id FROM push_tokens WHERE token = ?').get(TOKEN);
    // Otherwise the previous owner keeps receiving pushes on a phone that is no
    // longer theirs.
    expect(row).toMatchObject({ profile_id: 'p_b' });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM push_tokens').get()).toMatchObject({ n: 1 });
  });

  it('revives a token that had been disabled', async () => {
    await call(env, 'POST', '/v1/push/tokens', { token, body: { token: TOKEN, platform: 'ios' } });
    raw.prepare("UPDATE push_tokens SET disabled_at = '2026-01-01T00:00:00.000Z'").run();
    await call(env, 'POST', '/v1/push/tokens', { token, body: { token: TOKEN, platform: 'ios' } });
    expect(raw.prepare('SELECT disabled_at FROM push_tokens WHERE token = ?').get(TOKEN)).toMatchObject({
      disabled_at: null,
    });
  });
});

describe('DELETE /v1/push/tokens/:token', () => {
  let raw: Database.Database;
  let env: Env;

  beforeEach(() => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    env = makeEnv(fresh.db);
    insertProfile(raw, 'p_a', 'amanda');
    insertProfile(raw, 'p_b', 'tweeter');
  });

  it('removes your own device', async () => {
    const token = await tokenFor(env, 'p_a');
    await call(env, 'POST', '/v1/push/tokens', { token, body: { token: TOKEN, platform: 'ios' } });
    const res = await call(env, 'DELETE', `/v1/push/tokens/${encodeURIComponent(TOKEN)}`, { token });
    expect(res.status).toBe(200);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM push_tokens').get()).toMatchObject({ n: 0 });
  });

  it('cannot silence somebody else by guessing their token', async () => {
    const mine = await tokenFor(env, 'p_a');
    await call(env, 'POST', '/v1/push/tokens', { token: mine, body: { token: TOKEN, platform: 'ios' } });

    const theirs = await tokenFor(env, 'p_b');
    const res = await call(env, 'DELETE', `/v1/push/tokens/${encodeURIComponent(TOKEN)}`, { token: theirs });
    // Answers the same either way — a 404 here would confirm the token exists.
    expect(res.status).toBe(200);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM push_tokens').get()).toMatchObject({ n: 1 });
  });
});
