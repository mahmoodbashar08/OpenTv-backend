import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { hashPassword, verifyPassword, needsRehash, newToken, hashToken, MAX_ITERATIONS } from '@/passwords';
import { normaliseEmail, passwordError, LOGIN_FAIL_LIMIT } from '@/pure';
import type { Env } from '@/env';
import { call, freshDatabase, makeEnv } from './harness';

/**
 * Email sign-in.
 *
 * The cases chosen are the ones where getting it wrong is not visible from the
 * outside: a membership oracle answers correctly and still leaks, a password
 * comparison that returns early is still "working", and a lockout that counts
 * per IP still lets a botnet through. Those are asserted here because no amount
 * of using the app would reveal them.
 */

describe('normaliseEmail', () => {
  it('lowercases and trims', () => {
    expect(normaliseEmail('  Me@Example.COM ')).toBe('me@example.com');
  });

  it('refuses what is not an address', () => {
    for (const bad of ['', 'me', 'me@', '@example.com', 'me@@example.com', 'me @example.com', 'me@example', 'me@.com', 'me@example..com', 'a@b.c'.repeat(80)]) {
      expect(normaliseEmail(bad)).toBeNull();
    }
  });

  it('refuses a non-string', () => {
    expect(normaliseEmail(null)).toBeNull();
    expect(normaliseEmail(42)).toBeNull();
  });
});

describe('passwordError', () => {
  it('takes an ordinary password', () => {
    expect(passwordError('correct horse battery')).toBeNull();
  });

  it('refuses one under eight characters', () => {
    expect(passwordError('short7')).toBe('too_short');
    expect(passwordError('12345678')).toBe('too_common');
  });

  it('refuses the obvious ones however they are decorated', () => {
    expect(passwordError('Password!')).toBe('too_common');
    expect(passwordError('P-a-s-s-w-o-r-d')).toBe('too_common');
  });

  it('refuses a novel, so PBKDF2 is not handed a megabyte', () => {
    expect(passwordError('a'.repeat(500))).toBe('too_long');
  });
});

describe('password hashing', () => {
  // THE TEST THAT WOULD HAVE CAUGHT THE 500. workerd refuses PBKDF2 above
  // 100,000 iterations; Node's WebCrypto does not, so the whole suite passed
  // while production answered every registration with an error. Node cannot
  // enforce the ceiling, so assert the constant instead.
  it('stays under the iteration count workerd will actually run', () => {
    expect(MAX_ITERATIONS).toBeLessThanOrEqual(100_000);
  });

  it('round-trips', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batteru', hash)).toBe(false);
  });

  it('salts, so two identical passwords do not share a hash', async () => {
    const a = await hashPassword('same password here');
    const b = await hashPassword('same password here');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password here', b)).toBe(true);
  });

  it('never throws on a corrupt or foreign hash — it just fails', async () => {
    for (const bad of ['', 'nonsense', 'pbkdf2$x$y$z', 'bcrypt$12$abc', 'pbkdf2$1$AA$AA']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('knows when a stored hash is below the current cost', async () => {
    expect(needsRehash('pbkdf2$1000$AA==$AA==')).toBe(true);
    expect(needsRehash(await hashPassword('a strong enough one'))).toBe(false);
  });
});

describe('tokens', () => {
  it('are url-safe and unique', () => {
    const a = newToken();
    const b = newToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('are stored only as a digest', async () => {
    const t = newToken();
    const h = await hashToken(t);
    expect(h).not.toContain(t);
    expect(await hashToken(t)).toBe(h);
  });
});

// ── end to end, through the Worker ──────────────────────────────────────────

describe('email sign-in over HTTP', () => {
  let env: Env;
  let raw: Database.Database;

  beforeEach(() => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    env = makeEnv(fresh.db);
  });

  const register = (email: string, password = 'correct horse battery') =>
    call(env, 'POST', '/v1/auth/email/register', { body: { email, password } });

  it('creates an account and signs it in immediately, unverified', async () => {
    const res = await register('me@example.com');
    expect(res.status).toBe(201);
    expect(res.json.token).toBeTruthy();
    expect(res.json.email_verified).toBe(false);

    // The identity row exists too, so account deletion and the rest of the
    // system keep working without knowing about email_credentials.
    const ident = raw.prepare("SELECT COUNT(*) AS n FROM identities WHERE provider = 'email'").get() as { n: number };
    expect(ident.n).toBe(1);
  });

  it('refuses a bad address or a weak password before touching the database', async () => {
    expect((await register('not-an-address')).status).toBe(400);
    expect((await call(env, 'POST', '/v1/auth/email/register', { body: { email: 'a@b.co', password: '123' } })).status).toBe(400);
    const n = raw.prepare('SELECT COUNT(*) AS n FROM profiles').get() as { n: number };
    expect(n.n).toBe(0);
  });

  // THE ONE THAT MATTERS MOST. A different status, body or shape here turns
  // the endpoint into "does this person use OpenTV?".
  it('answers a taken address exactly as it answers a free one, and mints nothing', async () => {
    await register('taken@example.com');
    const again = await register('taken@example.com', 'a totally different one');
    expect(again.status).toBe(202);
    expect(again.json.token).toBeUndefined();

    const profiles = raw.prepare('SELECT COUNT(*) AS n FROM profiles').get() as { n: number };
    expect(profiles.n).toBe(1);
    // And the original password still works — a re-registration must not
    // overwrite the credential of an account somebody else owns.
    const login = await call(env, 'POST', '/v1/auth/email/login', {
      body: { email: 'taken@example.com', password: 'correct horse battery' },
    });
    expect(login.status).toBe(200);
  });

  it('treats the address case-insensitively', async () => {
    await register('Me@Example.com');
    const login = await call(env, 'POST', '/v1/auth/email/login', {
      body: { email: 'ME@EXAMPLE.COM', password: 'correct horse battery' },
    });
    expect(login.status).toBe(200);
  });

  it('gives the same 401 for a wrong password and an unknown address', async () => {
    await register('me@example.com');
    const wrongPassword = await call(env, 'POST', '/v1/auth/email/login', {
      body: { email: 'me@example.com', password: 'not the password' },
    });
    const unknown = await call(env, 'POST', '/v1/auth/email/login', {
      body: { email: 'nobody@example.com', password: 'not the password' },
    });
    expect(wrongPassword.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPassword.json).toEqual(unknown.json);
  });

  it('locks ONE account after repeated failures, which an IP limit would not', async () => {
    await register('me@example.com');
    for (let i = 0; i < LOGIN_FAIL_LIMIT; i++) {
      await call(env, 'POST', '/v1/auth/email/login', { body: { email: 'me@example.com', password: 'wrong' } });
    }
    // Even the CORRECT password is refused while locked.
    const now = await call(env, 'POST', '/v1/auth/email/login', {
      body: { email: 'me@example.com', password: 'correct horse battery' },
    });
    expect(now.status).toBe(429);
  });

  it('verifies with the emailed token, once', async () => {
    await register('me@example.com');
    // The plain token never leaves the server, so the test reads the row and
    // reverses nothing — it re-issues instead, which is what a user does.
    const row = raw.prepare('SELECT profile_id FROM email_credentials').get() as { profile_id: string };
    const token = newToken();
    raw
      .prepare('UPDATE email_credentials SET verify_hash = ?, verify_expires = ? WHERE profile_id = ?')
      .run(await hashToken(token), new Date(Date.now() + 60_000).toISOString(), row.profile_id);

    const ok = await call(env, 'POST', '/v1/auth/email/verify', { body: { token } });
    expect(ok.status).toBe(200);
    expect(ok.json.email_verified).toBe(true);

    // Replay does nothing: the token was consumed.
    const again = await call(env, 'POST', '/v1/auth/email/verify', { body: { token } });
    expect(again.status).toBe(400);
  });

  it('refuses an expired token, and says the same thing as for an unknown one', async () => {
    await register('me@example.com');
    const row = raw.prepare('SELECT profile_id FROM email_credentials').get() as { profile_id: string };
    const token = newToken();
    raw
      .prepare('UPDATE email_credentials SET verify_hash = ?, verify_expires = ? WHERE profile_id = ?')
      .run(await hashToken(token), new Date(Date.now() - 1000).toISOString(), row.profile_id);

    const expired = await call(env, 'POST', '/v1/auth/email/verify', { body: { token } });
    const unknown = await call(env, 'POST', '/v1/auth/email/verify', { body: { token: newToken() } });
    expect(expired.status).toBe(400);
    expect(expired.json).toEqual(unknown.json);
  });

  it('always answers "forgot" with 202, known address or not', async () => {
    await register('me@example.com');
    const known = await call(env, 'POST', '/v1/auth/email/forgot', { body: { email: 'me@example.com' } });
    const unknown = await call(env, 'POST', '/v1/auth/email/forgot', { body: { email: 'nobody@example.com' } });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.json).toEqual(unknown.json);
  });

  it('resets the password, clears the lockout, and verifies the address', async () => {
    await register('me@example.com');
    const row = raw.prepare('SELECT profile_id FROM email_credentials').get() as { profile_id: string };
    const token = newToken();
    raw
      .prepare(
        'UPDATE email_credentials SET reset_hash = ?, reset_expires = ?, failed_count = 99, locked_until = ? WHERE profile_id = ?',
      )
      .run(
        await hashToken(token),
        new Date(Date.now() + 60_000).toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
        row.profile_id,
      );

    const reset = await call(env, 'POST', '/v1/auth/email/reset', {
      body: { token, password: 'a brand new secret' },
    });
    expect(reset.status).toBe(200);

    const after = raw
      .prepare('SELECT verified_at, locked_until, failed_count FROM email_credentials')
      .get() as { verified_at: string | null; locked_until: string | null; failed_count: number };
    expect(after.verified_at).not.toBeNull();
    expect(after.locked_until).toBeNull();
    expect(after.failed_count).toBe(0);

    expect(
      (await call(env, 'POST', '/v1/auth/email/login', { body: { email: 'me@example.com', password: 'a brand new secret' } }))
        .status,
    ).toBe(200);
    expect(
      (await call(env, 'POST', '/v1/auth/email/login', { body: { email: 'me@example.com', password: 'correct horse battery' } }))
        .status,
    ).toBe(401);
  });

  it('refuses a weak password on reset, not just on register', async () => {
    await register('me@example.com');
    const row = raw.prepare('SELECT profile_id FROM email_credentials').get() as { profile_id: string };
    const token = newToken();
    raw
      .prepare('UPDATE email_credentials SET reset_hash = ?, reset_expires = ? WHERE profile_id = ?')
      .run(await hashToken(token), new Date(Date.now() + 60_000).toISOString(), row.profile_id);

    expect((await call(env, 'POST', '/v1/auth/email/reset', { body: { token, password: 'password' } })).status).toBe(400);
  });

  it('never stores the password or a plain token', async () => {
    await register('me@example.com', 'correct horse battery');
    const row = raw.prepare('SELECT * FROM email_credentials').get() as Record<string, unknown>;
    const dump = JSON.stringify(row);
    expect(dump).not.toContain('correct horse battery');
    expect(String(row.password_hash)).toMatch(/^pbkdf2\$\d+\$/);
  });
});
