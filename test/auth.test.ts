import { describe, expect, it } from 'vitest';
import {
  isHandleValid,
  normaliseHandle,
  placeholderHandle,
  verifyClaims,
  type ExpectedClaims,
  type IdTokenPayload,
} from '@/pure';
import { sign, verify } from '@/session';
import type { Env } from '@/env';
import { call, freshDatabase, makeEnv } from './harness';

/**
 * The decisions in Step 1 that can be quietly wrong. The crypto around them
 * (RS256 signature checking, the `alg` gate in src/auth.ts) is I/O-shaped and
 * is verified by hand against a running Worker, not here.
 */

// ── verifyClaims ─────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-07-31T12:00:00Z');
const nowSec = Math.floor(NOW / 1000);

const APPLE: ExpectedClaims = { provider: 'apple', audiences: ['com.insightfy.opentv'] };
const GOOGLE: ExpectedClaims = {
  provider: 'google',
  audiences: ['111-ios.apps.googleusercontent.com', '222-web.apps.googleusercontent.com'],
};

function payload(over: Partial<IdTokenPayload> = {}): IdTokenPayload {
  return {
    iss: 'https://appleid.apple.com',
    aud: 'com.insightfy.opentv',
    exp: nowSec + 3600,
    iat: nowSec - 10,
    sub: '001234.abcdef',
    ...over,
  };
}

describe('verifyClaims', () => {
  it('accepts a well-formed Apple token', () => {
    const r = verifyClaims(payload(), APPLE, NOW);
    expect(r).toEqual({ ok: true, sub: '001234.abcdef', email: null });
  });

  it('rejects the wrong issuer', () => {
    // Google's issuer on an Apple token: the classic confused-provider bug.
    const r = verifyClaims(payload({ iss: 'https://accounts.google.com' }), APPLE, NOW);
    expect(r).toEqual({ ok: false, reason: 'bad_issuer' });
  });

  it('accepts both spellings of the Google issuer — Google emits both', () => {
    const base = { aud: GOOGLE.audiences[0], exp: nowSec + 3600, iat: nowSec, sub: '10769150350006150715' };
    expect(verifyClaims({ ...base, iss: 'https://accounts.google.com' }, GOOGLE, NOW).ok).toBe(true);
    expect(verifyClaims({ ...base, iss: 'accounts.google.com' }, GOOGLE, NOW).ok).toBe(true);
  });

  it('rejects an aud outside the allowed set', () => {
    const r = verifyClaims(payload({ aud: 'com.someone.else' }), APPLE, NOW);
    expect(r).toEqual({ ok: false, reason: 'bad_audience' });
  });

  it('accepts the SECOND Google client id — Android returns the web one', () => {
    const r = verifyClaims(
      payload({ iss: 'accounts.google.com', aud: '222-web.apps.googleusercontent.com', sub: 'g1' }),
      GOOGLE,
      NOW,
    );
    expect(r).toEqual({ ok: true, sub: 'g1', email: null });
  });

  it('rejects an expired token', () => {
    expect(verifyClaims(payload({ exp: nowSec - 1 }), APPLE, NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects an iat five minutes in the future', () => {
    const r = verifyClaims(payload({ iat: nowSec + 301 }), APPLE, NOW);
    expect(r).toEqual({ ok: false, reason: 'issued_in_future' });
  });

  it('accepts an iat four minutes in the future — clock skew is real', () => {
    expect(verifyClaims(payload({ iat: nowSec + 240 }), APPLE, NOW).ok).toBe(true);
  });

  it('rejects a missing or empty sub', () => {
    expect(verifyClaims(payload({ sub: undefined }), APPLE, NOW)).toEqual({ ok: false, reason: 'missing_sub' });
    expect(verifyClaims(payload({ sub: '' }), APPLE, NOW)).toEqual({ ok: false, reason: 'missing_sub' });
  });

  it('rejects everything when no audience is configured', () => {
    // An empty GOOGLE_CLIENT_IDS must refuse tokens, not wave them through.
    const r = verifyClaims(payload({ iss: 'accounts.google.com' }), { provider: 'google', audiences: [''] }, NOW);
    expect(r).toEqual({ ok: false, reason: 'bad_audience' });
  });

  it('carries the email through when present', () => {
    const r = verifyClaims(payload({ email: 'a@b.c' }), APPLE, NOW);
    expect(r).toEqual({ ok: true, sub: '001234.abcdef', email: 'a@b.c' });
  });
});

// ── handles ──────────────────────────────────────────────────────────────────

describe('normaliseHandle', () => {
  it('folds case and trims', () => expect(normaliseHandle('  MahMood ')).toBe('mahmood'));
  it('applies NFKC — fullwidth characters are the same handle', () =>
    expect(normaliseHandle('ｍａｈｍｏｏｄ')).toBe('mahmood'));
});

describe('isHandleValid', () => {
  it('accepts a plain handle', () => expect(isHandleValid('mahmood')).toEqual({ ok: true, handle: 'mahmood' }));
  it('accepts digits and underscores', () => expect(isHandleValid('tv_time_99').ok).toBe(true));

  it('rejects too short', () => expect(isHandleValid('ab')).toEqual({ ok: false, reason: 'too_short' }));
  it('rejects too long', () =>
    expect(isHandleValid('a'.repeat(21))).toEqual({ ok: false, reason: 'too_long' }));
  it('accepts exactly 3 and exactly 20', () => {
    expect(isHandleValid('abc').ok).toBe(true);
    expect(isHandleValid('a'.repeat(20)).ok).toBe(true);
  });

  it('folds uppercase rather than rejecting it', () =>
    expect(isHandleValid('Mahmood')).toEqual({ ok: true, handle: 'mahmood' }));

  it('rejects spaces inside the handle', () =>
    expect(isHandleValid('mah mood')).toEqual({ ok: false, reason: 'bad_characters' }));

  it('rejects the user_ placeholder prefix', () =>
    expect(isHandleValid('user_p_ab12cd34')).toEqual({ ok: false, reason: 'reserved' }));

  it('rejects reserved words, case-folded', () => {
    for (const w of ['admin', 'OpenTV', 'support', 'help', 'api', 'moderator']) {
      expect(isHandleValid(w)).toEqual({ ok: false, reason: 'reserved' });
    }
  });

  it('rejects a Unicode lookalike — this is the homograph defence', () => {
    // U+0430 CYRILLIC SMALL LETTER A. Renders as "mahmood", is not "mahmood".
    const cyrillic = 'mаhmood';
    expect(cyrillic).not.toBe('mahmood');
    expect(isHandleValid(cyrillic)).toEqual({ ok: false, reason: 'bad_characters' });
  });

  it('rejects emoji and hyphens', () => {
    expect(isHandleValid('mah-mood').ok).toBe(false);
    expect(isHandleValid('mahmood😀').ok).toBe(false);
  });
});

describe('placeholderHandle', () => {
  it('is the first ten characters of the profile id', () =>
    expect(placeholderHandle('p_0123456789abcdef')).toBe('user_p_01234567'));
  it('is itself refused as a claimed handle', () =>
    expect(isHandleValid(placeholderHandle('p_0123456789abcdef')).ok).toBe(false));
});

// ── session tokens ───────────────────────────────────────────────────────────

const env = { SESSION_SECRET: 'test-secret' } as Env;

describe('session sign / verify', () => {
  it('round-trips against a fixed clock', async () => {
    const { token, expiresAt } = await sign(env, 'p_abc', NOW);
    expect(await verify(env, token, NOW)).toBe('p_abc');
    expect(expiresAt).toBe(new Date(NOW + 7 * 24 * 3600 * 1000).toISOString());
  });

  it('rejects a tampered payload', async () => {
    const { token } = await sign(env, 'p_abc', NOW);
    const [h, , s] = token.split('.') as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({ sub: 'p_someone_else', iat: nowSec, exp: nowSec + 3600 }),
    ).toString('base64url');
    expect(await verify(env, `${h}.${forged}.${s}`, NOW)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { token } = await sign(env, 'p_abc', NOW);
    const week = 7 * 24 * 3600 * 1000;
    expect(await verify(env, token, NOW + week - 1000)).toBe('p_abc');
    expect(await verify(env, token, NOW + week + 1000)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const { token } = await sign({ SESSION_SECRET: 'other' } as Env, 'p_abc', NOW);
    expect(await verify(env, token, NOW)).toBeNull();
  });

  it('rejects an alg: none token', async () => {
    const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ sub: 'p_abc', iat: nowSec, exp: nowSec + 3600 })).toString('base64url');
    expect(await verify(env, `${h}.${p}.`, NOW)).toBeNull();
  });

  it('rejects garbage', async () => {
    expect(await verify(env, 'not-a-token', NOW)).toBeNull();
    expect(await verify(env, '', NOW)).toBeNull();
  });
});

/**
 * The development sign-in, and the guard that keeps it out of production.
 *
 * `POST /v1/auth/dev` mints a session with no Apple or Google account behind
 * it. That is an authentication bypass, so what matters is not that it works
 * but that it CANNOT work anywhere the secret is absent — and that the accounts
 * it makes stay in a namespace that can be deleted wholesale without touching a
 * real one. Every assertion below is one of those two things.
 */
describe('POST /v1/auth/dev', () => {
  const withSecret = (db: D1Database) => ({ ...makeEnv(db), DEV_AUTH_SECRET: 'test-dev-secret' });

  it('DOES NOT EXIST without the secret — 404, not 403', async () => {
    // 403 would confirm to a stranger that the endpoint is there and locked.
    const fresh = freshDatabase();
    const res = await call(makeEnv(fresh.db), 'POST', '/v1/auth/dev', { body: { name: 'amanda' } });
    expect(res.status).toBe(404);
  });

  it('refuses a wrong secret', async () => {
    const fresh = freshDatabase();
    const res = await call(withSecret(fresh.db), 'POST', '/v1/auth/dev', {
      body: { name: 'amanda' },
      headers: { 'X-Dev-Secret': 'not-it' },
    });
    expect(res.status).toBe(401);
  });

  it('signs in a test account and returns an ordinary session', async () => {
    const fresh = freshDatabase();
    const res = await call(withSecret(fresh.db), 'POST', '/v1/auth/dev', {
      body: { name: 'amanda' },
      headers: { 'X-Dev-Secret': 'test-dev-secret' },
    });
    expect(res.status).toBe(200);
    expect(typeof res.json.token).toBe('string');
    expect(res.json.needs_handle).toBe(true);
  });

  it('keeps every account it makes in the dev namespace, so they can be purged together', async () => {
    const fresh = freshDatabase();
    await call(withSecret(fresh.db), 'POST', '/v1/auth/dev', {
      body: { name: 'amanda' },
      headers: { 'X-Dev-Secret': 'test-dev-secret' },
    });
    const row = fresh.raw.prepare('SELECT provider, external_id FROM identities').get() as {
      provider: string;
      external_id: string;
    };
    // DELETE FROM identities WHERE provider = 'dev' must be enough, and must
    // never be able to catch a real Apple or Google identity.
    expect(row).toEqual({ provider: 'dev', external_id: 'dev_amanda' });
  });

  it('returns the SAME account for the same name, and a different one otherwise', async () => {
    const fresh = freshDatabase();
    const env2 = withSecret(fresh.db);
    const h = { 'X-Dev-Secret': 'test-dev-secret' };
    const a1 = await call(env2, 'POST', '/v1/auth/dev', { body: { name: 'amanda' }, headers: h });
    const a2 = await call(env2, 'POST', '/v1/auth/dev', { body: { name: 'amanda' }, headers: h });
    const b = await call(env2, 'POST', '/v1/auth/dev', { body: { name: 'twitterfriend' }, headers: h });

    expect(a2.json.profile.id).toBe(a1.json.profile.id);
    expect(b.json.profile.id).not.toBe(a1.json.profile.id);
  });

  it('refuses a name that could steer the identity somewhere else', async () => {
    const fresh = freshDatabase();
    const h = { 'X-Dev-Secret': 'test-dev-secret' };
    for (const name of ['', 'a', 'has space', '../../etc', 'x'.repeat(25), 'UPPER!']) {
      const res = await call(withSecret(fresh.db), 'POST', '/v1/auth/dev', { body: { name }, headers: h });
      expect(res.status).toBe(400);
    }
  });
});
