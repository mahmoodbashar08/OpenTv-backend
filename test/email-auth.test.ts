import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { hashPassword, verifyPassword, needsRehash, newToken, hashToken, MAX_ITERATIONS } from '@/passwords';
import { normaliseEmail, passwordError, LOGIN_FAIL_LIMIT, MAX_CODE_TRIES } from '@/pure';
import type { Env } from '@/env';
import { call, freshDatabase, makeEnv, tokenFor } from './harness';
import { linkTarget } from '@/routes/auth';

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
  it('names what the address already signs in with, and mints nothing', async () => {
    await register('taken@example.com');
    const again = await register('taken@example.com', 'a totally different one');
    expect(again.status).toBe(200);
    expect(again.json.account_exists).toBe(true);
    expect(again.json.providers).toEqual(['email']);
    expect(again.json.has_password).toBe(true);
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

  /**
   * THE DUPLICATE-ACCOUNT BUG. The check used to read `email_credentials`, which
   * a Google or Apple account has no row in — so the address looked free and
   * registering it built a second profile for the same person, splitting their
   * comments and follows across two accounts with one inbox between them.
   */
  it('finds an address that only ever signed in with Google, and says which', async () => {
    raw.prepare('INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES (?, ?, ?, ?)')
      .run('p_google', 'googler', 'googler', new Date().toISOString());
    raw.prepare('INSERT INTO identities (provider, external_id, profile_id, email, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('google', 'sub-123', 'p_google', 'Both@Example.com', new Date().toISOString());

    const res = await register('both@example.com');

    expect(res.status).toBe(200);
    expect(res.json.account_exists).toBe(true);
    expect(res.json.providers).toEqual(['google']);
    // No password on that account, so the app offers to set one rather than
    // telling somebody to remember a password that has never existed.
    expect(res.json.has_password).toBe(false);

    const profiles = raw.prepare('SELECT COUNT(*) AS n FROM profiles').get() as { n: number };
    expect(profiles.n).toBe(1);
  });

  /**
   * DELETING AN ACCOUNT USED TO BURN ITS ADDRESS FOR EVER. Deletion removes the
   * identity and marks the profile deleted, but left `email_credentials` — and
   * `email_lower` is UNIQUE, so registering again either answered "check your
   * inbox" about an account that no longer existed, or hit the constraint and
   * answered 500. Found in production: one real address was unusable for two
   * days because of it.
   */
  it('lets a deleted account\'s address be used again', async () => {
    await register('gone@example.com');
    const row = raw.prepare('SELECT profile_id FROM email_credentials').get() as { profile_id: string };
    raw.prepare('UPDATE profiles SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), row.profile_id);
    raw.prepare('DELETE FROM identities WHERE profile_id = ?').run(row.profile_id);

    const again = await register('gone@example.com', 'a totally different one');

    expect(again.status).toBe(201);
    expect(again.json.token).toBeTruthy();
    // The new account is its own, not a resurrection of the deleted one.
    const cred = raw.prepare('SELECT profile_id FROM email_credentials').get() as { profile_id: string };
    expect(cred.profile_id).not.toBe(row.profile_id);
  });

  /**
   * THE DEAD "SET A PASSWORD" BUTTON. A Google account has no credential row,
   * so /forgot found nothing, minted nothing and sent nothing — and the one
   * action the app offers those users did nothing at all, for ever. The row is
   * created here with an unusable hash so the reset has something to hang on.
   */
  it('mints a first-password reset for an account that only has Google', async () => {
    raw.prepare('INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES (?, ?, ?, ?)')
      .run('p_google', 'googler', 'googler', new Date().toISOString());
    raw.prepare('INSERT INTO identities (provider, external_id, profile_id, email, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('google', 'sub-123', 'p_google', 'Both@Example.com', new Date().toISOString());

    const res = await call(env, 'POST', '/v1/auth/email/forgot', { body: { email: 'both@example.com' } });
    expect(res.status).toBe(202);

    const cred = raw
      .prepare('SELECT password_hash, reset_hash, verified_at FROM email_credentials WHERE profile_id = ?')
      .get('p_google') as { password_hash: string; reset_hash: string | null; verified_at: string | null };
    expect(cred.reset_hash).not.toBeNull();
    expect(cred.verified_at).not.toBeNull();
    // Inert until the reset completes — nothing can sign in with it.
    expect(cred.password_hash.startsWith('pbkdf2$')).toBe(false);

    // And the account still reports itself as password-less, so the app keeps
    // offering "Set a password" rather than "Sign in instead".
    const reg = await register('both@example.com');
    expect(reg.json.has_password).toBe(false);

    // Sign-in still names the provider instead of blaming a password that has
    // never existed.
    const login = await call(env, 'POST', '/v1/auth/email/login', {
      body: { email: 'both@example.com', password: 'anything at all' },
    });
    expect(login.status).toBe(409);
    expect(login.json.error.code).toBe('use_provider');
  });

  it('treats the address case-insensitively', async () => {
    await register('Me@Example.com');
    const login = await call(env, 'POST', '/v1/auth/email/login', {
      body: { email: 'ME@EXAMPLE.COM', password: 'correct horse battery' },
    });
    expect(login.status).toBe(200);
  });

  /**
   * The two now differ ON PURPOSE — see the route. Registration already names
   * the providers on an address, so hiding it one screen later bought nothing
   * and cost the person a guess at a door that is not there.
   */
  it('separates a wrong password from an address with no account', async () => {
    await register('me@example.com');
    const wrongPassword = await call(env, 'POST', '/v1/auth/email/login', {
      body: { email: 'me@example.com', password: 'not the password' },
    });
    const unknown = await call(env, 'POST', '/v1/auth/email/login', {
      body: { email: 'nobody@example.com', password: 'not the password' },
    });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.json.error.code).toBe('unauthenticated');
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe('no_account');
  });

  it('tells a Google account to use Google, rather than its password', async () => {
    raw.prepare('INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES (?, ?, ?, ?)')
      .run('p_google', 'googler', 'googler', new Date().toISOString());
    raw.prepare('INSERT INTO identities (provider, external_id, profile_id, email, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('google', 'sub-123', 'p_google', 'both@example.com', new Date().toISOString());

    const res = await call(env, 'POST', '/v1/auth/email/login', {
      body: { email: 'both@example.com', password: 'anything at all' },
    });

    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('use_provider');
    expect(res.json.providers).toEqual(['google']);
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

  /**
   * ONE EMAIL A MINUTE, from every door.
   *
   * Two of the three senders are unauthenticated and take any address, so
   * without a shared limit they are a machine for posting mail at an inbox
   * nobody involved owns. The limit is shared — `updated_at` — so they cannot
   * be alternated to send three times as much.
   *
   * And it must stay INVISIBLE on the unauthenticated ones: a 429 that only a
   * registered address could produce is the membership oracle those endpoints
   * are written to avoid.
   */
  /**
   * WHICH ACCOUNT A GOOGLE SIGN-IN LANDS IN.
   *
   * Registering by email and later signing in with Google is one person using
   * two doors, and handing them a second empty profile is the wrong answer. But
   * the rule that joins them is also the one that could put somebody inside
   * somebody else's account, so both sides must have proved the address: the
   * provider says it verified it, and the local account confirmed it.
   */
  /**
   * The other direction: a Google account gaining a password, so the same
   * person can use either door. Written already CONFIRMED, because the address
   * came from the provider rather than from anything typed here — which is
   * also what lets a later email sign-in link back instead of duplicating.
   */
  describe('POST /v1/me/password', () => {
    /** A profile that signed in with Google, as `resolveProfile` would leave it. */
    const googleAccount = async (email: string | null, id = 'p_google1') => {
      raw
        .prepare('INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES (?, ?, ?, ?)')
        .run(id, 'gjoe', 'gjoe', '2026-01-01T00:00:00.000Z');
      raw
        .prepare(
          'INSERT INTO identities (provider, external_id, profile_id, email, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('google', `sub-${id}`, id, email, '2026-01-01T00:00:00.000Z');
      return id;
    };

    it('adds a password, already confirmed, using the address the provider gave', async () => {
      const id = await googleAccount('joe@example.com');
      const r = await call(env, 'POST', '/v1/me/password', {
        token: await tokenFor(env, id),
        body: { password: 'a-good-long-password' },
      });
      expect(r.status).toBe(200);
      const row = raw.prepare('SELECT email, verified_at FROM email_credentials WHERE profile_id = ?').get(id) as {
        email: string;
        verified_at: string | null;
      };
      expect(row.email).toBe('joe@example.com');
      expect(row.verified_at).not.toBeNull();
    });

    it('makes the account reachable by linkTarget afterwards', async () => {
      const id = await googleAccount('joe@example.com');
      await call(env, 'POST', '/v1/me/password', { token: await tokenFor(env, id), body: { password: 'a-good-long-password' } });
      await expect(linkTarget(env.DB, 'joe@example.com')).resolves.toBe(id);
    });

    it('will not overwrite a password that already exists — that is the reset flow', async () => {
      const id = await googleAccount('joe@example.com');
      await call(env, 'POST', '/v1/me/password', { token: await tokenFor(env, id), body: { password: 'a-good-long-password' } });
      const again = await call(env, 'POST', '/v1/me/password', { token: await tokenFor(env, id), body: { password: 'another-long-one' } });
      expect(again.status).toBe(403);
    });

    it('refuses when the address is already a password account elsewhere', async () => {
      await register('taken@example.com');
      const id = await googleAccount('taken@example.com', 'p_google2');
      const r = await call(env, 'POST', '/v1/me/password', { token: await tokenFor(env, id), body: { password: 'a-good-long-password' } });
      expect(r.status).toBe(409);
    });

    it('refuses an account with no address at all', async () => {
      const id = await googleAccount(null, 'p_google3');
      const r = await call(env, 'POST', '/v1/me/password', { token: await tokenFor(env, id), body: { password: 'a-good-long-password' } });
      expect(r.status).toBe(400);
    });

    it('applies the same password rules as registration', async () => {
      const id = await googleAccount('joe@example.com');
      const r = await call(env, 'POST', '/v1/me/password', { token: await tokenFor(env, id), body: { password: 'short' } });
      expect(r.status).toBe(400);
    });
  });

  describe('linkTarget — joining a provider sign-in to an existing account', () => {
    const confirm = () =>
      raw.prepare("UPDATE email_credentials SET verified_at = '2026-01-01T00:00:00.000Z'").run();

    it('finds a confirmed account for the same address', async () => {
      await register('me@example.com');
      confirm();
      const row = raw.prepare('SELECT profile_id FROM email_credentials').get() as { profile_id: string };
      await expect(linkTarget(env.DB, 'me@example.com')).resolves.toBe(row.profile_id);
    });

    it('matches regardless of case or surrounding space, as sign-in does', async () => {
      await register('me@example.com');
      confirm();
      await expect(linkTarget(env.DB, '  ME@Example.COM ')).resolves.not.toBeNull();
    });

    it('REFUSES an unconfirmed account — this is the takeover', async () => {
      // Register victim@ with a password the attacker knows and never confirm
      // it. The victim then signs in with Google. If this linked, the attacker
      // would hold a working password for the victim's account.
      await register('victim@example.com');
      await expect(linkTarget(env.DB, 'victim@example.com')).resolves.toBeNull();
    });

    it('refuses an address nobody has registered', async () => {
      await expect(linkTarget(env.DB, 'nobody@example.com')).resolves.toBeNull();
    });

    it('refuses a deleted profile', async () => {
      await register('me@example.com');
      confirm();
      raw.prepare("UPDATE profiles SET deleted_at = '2026-01-02T00:00:00.000Z'").run();
      await expect(linkTarget(env.DB, 'me@example.com')).resolves.toBeNull();
    });
  });

  describe('the one-a-minute email limit', () => {
    // No mail provider is configured in tests, so "did it send?" is observed
    // through the side effect that always accompanies a send: a fresh token,
    // and a stamped `updated_at`.
    const cred = () =>
      raw.prepare('SELECT reset_hash, updated_at FROM email_credentials').get() as {
        reset_hash: string | null;
        updated_at: string;
      };

    // Registering a taken address sends no mail at all now — it answers with
    // the providers instead — so it must not touch the clock the other two
    // senders share, or a reset could be starved by somebody else's typing.
    it('sends nothing and touches nothing when a taken address is registered again', async () => {
      await register('me@example.com');
      const before = cred().updated_at;

      const a = await call(env, 'POST', '/v1/auth/email/register', {
        body: { email: 'me@example.com', password: 'a-good-long-password' },
      });
      const b = await call(env, 'POST', '/v1/auth/email/register', {
        body: { email: 'me@example.com', password: 'a-good-long-password' },
      });

      expect(a.status).toBe(200);
      expect(a.json).toEqual(b.json);
      expect(cred().reset_hash).toBeNull();
      expect(cred().updated_at).toBe(before);
    });

    it('issues one reset token for repeated requests, and still answers 202 to both', async () => {
      await register('me@example.com');
      // Registration just stamped the row, so the first forgot is throttled too
      // — which is the point: the clock is shared across every sender.
      const a = await call(env, 'POST', '/v1/auth/email/forgot', { body: { email: 'me@example.com' } });
      const b = await call(env, 'POST', '/v1/auth/email/forgot', { body: { email: 'me@example.com' } });

      expect(a.status).toBe(202);
      expect(b.status).toBe(202);
      expect(a.json).toEqual(b.json);
      expect(cred().reset_hash).toBeNull();
    });

    it('lets a reset through once the minute has passed', async () => {
      await register('me@example.com');
      const row = raw.prepare('SELECT profile_id FROM email_credentials').get() as { profile_id: string };
      raw
        .prepare('UPDATE email_credentials SET updated_at = ? WHERE profile_id = ?')
        .run(new Date(Date.now() - 61_000).toISOString(), row.profile_id);

      const ok = await call(env, 'POST', '/v1/auth/email/forgot', { body: { email: 'me@example.com' } });
      expect(ok.status).toBe(202);
      expect(cred().reset_hash).not.toBeNull();
    });

    it('answers an unknown address exactly as a throttled known one', async () => {
      await register('me@example.com');
      const throttled = await call(env, 'POST', '/v1/auth/email/forgot', { body: { email: 'me@example.com' } });
      const unknown = await call(env, 'POST', '/v1/auth/email/forgot', { body: { email: 'nobody@example.com' } });
      expect(throttled.status).toBe(unknown.status);
      expect(throttled.json).toEqual(unknown.json);
    });
  });

  /**
   * The code path. It exists because a deep link only works on the device that
   * received the email — read it on a phone, sign in on a simulator, and there
   * is nothing to tap. Its security rests on two things this pins: the code is
   * useless without the address, and it runs out of guesses.
   */
  describe('the six-digit code', () => {
    const setCode = async (code: string, expiresInMs = 60_000) => {
      const row = raw.prepare('SELECT profile_id FROM email_credentials').get() as { profile_id: string };
      raw
        .prepare(
          'UPDATE email_credentials SET verify_code_hash = ?, verify_code_tries = 0, verify_expires = ? WHERE profile_id = ?',
        )
        .run(await hashToken(code), new Date(Date.now() + expiresInMs).toISOString(), row.profile_id);
      return row.profile_id;
    };

    it('confirms with the address and the code, and cannot be replayed', async () => {
      await register('me@example.com');
      await setCode('042317');

      const ok = await call(env, 'POST', '/v1/auth/email/verify', {
        body: { email: 'me@example.com', code: '042317' },
      });
      expect(ok.status).toBe(200);
      expect(ok.json.email_verified).toBe(true);

      const again = await call(env, 'POST', '/v1/auth/email/verify', {
        body: { email: 'me@example.com', code: '042317' },
      });
      expect(again.status).toBe(400);
    });

    it('keeps a leading zero — 042317 is not 42317', async () => {
      await register('me@example.com');
      await setCode('042317');
      const short = await call(env, 'POST', '/v1/auth/email/verify', {
        body: { email: 'me@example.com', code: '42317' },
      });
      expect(short.status).toBe(400);
    });

    it('accepts a code pasted with spaces, because that is what people paste', async () => {
      await register('me@example.com');
      await setCode('042317');
      const spaced = await call(env, 'POST', '/v1/auth/email/verify', {
        body: { email: 'me@example.com', code: '042 317' },
      });
      expect(spaced.status).toBe(200);
    });

    it('is worthless without the address it was sent to', async () => {
      await register('me@example.com');
      await setCode('042317');
      const noEmail = await call(env, 'POST', '/v1/auth/email/verify', { body: { code: '042317' } });
      expect(noEmail.status).toBe(400);
      const wrongEmail = await call(env, 'POST', '/v1/auth/email/verify', {
        body: { email: 'someone@else.com', code: '042317' },
      });
      expect(wrongEmail.status).toBe(400);
      // and the real one still works, so nothing above consumed it
      const ok = await call(env, 'POST', '/v1/auth/email/verify', {
        body: { email: 'me@example.com', code: '042317' },
      });
      expect(ok.status).toBe(200);
    });

    it('runs out of guesses, and stays dead even when the right code arrives', async () => {
      await register('me@example.com');
      await setCode('042317');
      for (let i = 0; i < MAX_CODE_TRIES; i += 1) {
        const wrong = await call(env, 'POST', '/v1/auth/email/verify', {
          body: { email: 'me@example.com', code: '000000' },
        });
        expect(wrong.status).toBe(400);
      }
      const correct = await call(env, 'POST', '/v1/auth/email/verify', {
        body: { email: 'me@example.com', code: '042317' },
      });
      expect(correct.status).toBe(400);
    });

    it('expires with the link, and answers identically to a wrong code', async () => {
      await register('me@example.com');
      await setCode('042317', -1000);
      const expired = await call(env, 'POST', '/v1/auth/email/verify', {
        body: { email: 'me@example.com', code: '042317' },
      });
      const wrong = await call(env, 'POST', '/v1/auth/email/verify', {
        body: { email: 'me@example.com', code: '999999' },
      });
      expect(expired.status).toBe(400);
      expect(expired.json).toEqual(wrong.json);
    });
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

  /**
   * The gate. An account whose address nobody has proved they can read is an
   * anonymous account with a display name, and it must not be able to act OR
   * to look — a throwaway address would otherwise be a free window onto every
   * profile and everything they watch.
   */
  describe('until the email is confirmed', () => {
    let token: string;

    beforeEach(async () => {
      const res = await register('new@example.com');
      token = res.json.token;
    });

    it('refuses to write anything', async () => {
      for (const [method, path, body] of [
        ['POST', '/v1/comments', { target_source: 'tvdb', target_key: '1', body: 'hello there' }],
        ['POST', '/v1/follows/p_someone', undefined],
        ['PUT', '/v1/me/published', { kind: 'show', stats: {}, titles: [] }],
        ['POST', '/v1/me/avatar', undefined],
        ['PATCH', '/v1/me', { bio: 'hi' }],
      ] as const) {
        const res = await call(env, method, path, { token, body });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.json.error.code).toBe('email_unverified');
      }
    });

    it('refuses to let it look at anybody', async () => {
      const res = await call(env, 'GET', '/v1/profiles/someone', { token });
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('email_unverified');
    });

    it('still allows the four things that are the way out', async () => {
      expect((await call(env, 'GET', '/v1/me', { token })).status).toBe(200);
      // A resend immediately after registering is inside the cooldown, which is
      // a 429 rather than the 403 this test is about — either way, not blocked
      // by the gate.
      expect((await call(env, 'POST', '/v1/me/email/resend', { token })).status).not.toBe(403);
      expect((await call(env, 'DELETE', '/v1/me', { token })).status).not.toBe(403);
    });

    it('does not touch anonymous callers', async () => {
      // No token: the gate must be invisible. A public read stays public.
      expect((await call(env, 'GET', '/v1/profiles/nobody')).status).toBe(404);
    });

    it('lifts the moment the link is used, and hands back a full token', async () => {
      const row = raw.prepare('SELECT profile_id FROM email_credentials').get() as { profile_id: string };
      const link = newToken();
      raw
        .prepare('UPDATE email_credentials SET verify_hash = ?, verify_expires = ? WHERE profile_id = ?')
        .run(await hashToken(link), new Date(Date.now() + 60_000).toISOString(), row.profile_id);

      const verified = await call(env, 'POST', '/v1/auth/email/verify', { body: { token: link } });
      expect(verified.status).toBe(200);
      expect(verified.json.token).toBeTruthy();

      // The OLD token is still restricted — the claim is in the token, so a
      // client that ignores the new one stays gated. That is the correct
      // failure: it cannot be wrong in the permissive direction.
      expect((await call(env, 'GET', '/v1/profiles/someone', { token })).status).toBe(403);
      // The NEW one is not.
      const fresh = await call(env, 'GET', '/v1/profiles/someone', { token: verified.json.token });
      expect(fresh.status).not.toBe(403);
    });

    it('is not lifted by signing in again', async () => {
      const again = await call(env, 'POST', '/v1/auth/email/login', {
        body: { email: 'new@example.com', password: 'correct horse battery' },
      });
      expect(again.json.email_verified).toBe(false);
      expect((await call(env, 'GET', '/v1/profiles/someone', { token: again.json.token })).status).toBe(403);
    });
  });

  /**
   * "Somebody else is signed in as me."
   *
   * The password alone cannot help there — they are already holding a session,
   * and a JWT is not checked against anything. Before the epoch, changing the
   * password left them with the account for the rest of the token's seven days.
   */
  describe('revocation', () => {
    it('a password reset ends every session that already existed', async () => {
      await register('me@example.com');
      const theirToken = (
        await call(env, 'POST', '/v1/auth/email/login', {
          body: { email: 'me@example.com', password: 'correct horse battery' },
        })
      ).json.token;

      // They are in.
      expect((await call(env, 'GET', '/v1/me', { token: theirToken })).status).toBe(200);

      const row = raw.prepare('SELECT profile_id FROM email_credentials').get() as { profile_id: string };
      const link = newToken();
      raw
        .prepare('UPDATE email_credentials SET reset_hash = ?, reset_expires = ? WHERE profile_id = ?')
        .run(await hashToken(link), new Date(Date.now() + 60_000).toISOString(), row.profile_id);
      await call(env, 'POST', '/v1/auth/email/reset', { body: { token: link, password: 'a brand new secret' } });

      // And now they are out.
      expect((await call(env, 'GET', '/v1/me', { token: theirToken })).status).toBe(401);
    });

    it('and the owner can sign in again immediately afterwards', async () => {
      // The trap: a token minted after a revocation must carry the NEW epoch,
      // or it is older than the revocation and refused on its first use — the
      // new password would appear not to work at all.
      await register('me@example.com');
      const row = raw.prepare('SELECT profile_id FROM email_credentials').get() as { profile_id: string };
      const link = newToken();
      raw
        .prepare('UPDATE email_credentials SET reset_hash = ?, reset_expires = ? WHERE profile_id = ?')
        .run(await hashToken(link), new Date(Date.now() + 60_000).toISOString(), row.profile_id);
      await call(env, 'POST', '/v1/auth/email/reset', { body: { token: link, password: 'a brand new secret' } });

      const fresh = await call(env, 'POST', '/v1/auth/email/login', {
        body: { email: 'me@example.com', password: 'a brand new secret' },
      });
      expect(fresh.status).toBe(200);
      expect((await call(env, 'GET', '/v1/me', { token: fresh.json.token })).status).toBe(200);
    });

    it('"sign out my other devices" keeps the caller signed in on the new token', async () => {
      const first = await register('me@example.com');
      const row = raw.prepare('SELECT profile_id FROM email_credentials').get() as { profile_id: string };
      raw.prepare('UPDATE email_credentials SET verified_at = ? WHERE profile_id = ?').run(new Date().toISOString(), row.profile_id);
      const mine = (
        await call(env, 'POST', '/v1/auth/email/login', {
          body: { email: 'me@example.com', password: 'correct horse battery' },
        })
      ).json.token;

      const res = await call(env, 'POST', '/v1/me/sessions/revoke', { token: mine });
      expect(res.status).toBe(200);
      expect(res.json.token).toBeTruthy();

      // The old ones — including the registration token — are dead.
      expect((await call(env, 'GET', '/v1/me', { token: mine })).status).toBe(401);
      expect((await call(env, 'GET', '/v1/me', { token: first.json.token })).status).toBe(401);
      // The one just handed back is not.
      expect((await call(env, 'GET', '/v1/me', { token: res.json.token })).status).toBe(200);
    });
  });

  it('never stores the password or a plain token', async () => {
    await register('me@example.com', 'correct horse battery');
    const row = raw.prepare('SELECT * FROM email_credentials').get() as Record<string, unknown>;
    const dump = JSON.stringify(row);
    expect(dump).not.toContain('correct horse battery');
    expect(String(row.password_hash)).toMatch(/^pbkdf2\$\d+\$/);
  });
});
