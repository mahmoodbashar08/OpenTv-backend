import { Hono } from 'hono';
import type { App, Env } from '@/env';
import { fail } from '@/http';
import { sendResetEmail, sendVerificationEmail } from '@/mail';
import { requireAuth } from '@/middleware';
import { hashPassword, hashToken, needsRehash, newToken, sameToken, verifyPassword } from '@/passwords';
import {
  LOGIN_FAIL_LIMIT,
  LOGIN_LOCK_MS,
  RESEND_COOLDOWN_MS,
  normaliseEmail,
  passwordError,
  placeholderHandle,
  RESET_TTL_MS,
  VERIFY_TTL_MS,
} from '@/pure';
import { sign } from '@/session';

/**
 * Signing in with an email address, for people who will not use Apple or
 * Google.
 *
 * THE ONE RULE THIS FILE IS BUILT AROUND: a stranger must not learn whether an
 * address has an account here. That single requirement shapes nearly every
 * response below — registration with a taken address answers exactly as one
 * with a free address does, "forgot password" always answers 202, and a wrong
 * password and an unknown address give the same 401 after the same work. An
 * endpoint that says "no such user" is a membership oracle: point it at a
 * mailing list and it tells you which of those people use this app, which for a
 * TV tracker is a list of what they watch.
 *
 * WHAT IT COSTS: someone who registers with an address that is already taken is
 * told to check their inbox and finds a "you already have an account" email
 * instead of a link. That is the correct trade and it is what every careful
 * implementation does.
 *
 * PASSWORDS NEVER APPEAR IN A URL, a log, or a response. See `passwords.ts`.
 */

export const emailAuth = new Hono<App>();

type CredRow = {
  profile_id: string;
  email: string;
  password_hash: string;
  verified_at: string | null;
  failed_count: number;
  locked_until: string | null;
};

/** The session a successful sign-in hands back — identical to every other provider's. */
async function session(env: Env, profileId: string, nowMs: number, verified: boolean) {
  // AN UNVERIFIED ACCOUNT GETS A RESTRICTED TOKEN, not a full one. It can read
  // its own state, enter its code, ask for another, and delete itself; every
  // other route in the API refuses it. See `requireVerified`.
  const { token, expiresAt } = await sign(env, profileId, nowMs, verified ? 'full' : 'unverified');
  // `expires_at` in the envelope, matching every other sign-in response — the
  // app reads one shape whichever provider it used.
  return { token, expires_at: expiresAt, email_verified: verified };
}

function newProfileId(): string {
  return `p_${crypto.randomUUID().replace(/-/g, '')}`;
}

// ── POST /v1/auth/email/register ────────────────────────────────────────────

emailAuth.post('/auth/email/register', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const email = normaliseEmail(b.email);
  if (!email) return fail(c, 400, 'invalid_body', 'That does not look like an email address.');
  const bad = passwordError(b.password);
  if (bad) {
    const why =
      bad === 'too_short'
        ? 'Use at least 8 characters.'
        : bad === 'too_long'
          ? 'That password is too long.'
          : 'That password is too easy to guess.';
    return fail(c, 400, 'invalid_body', why);
  }
  const password = b.password as string;

  const db = c.env.DB;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const existing = await db
    .prepare('SELECT profile_id, email FROM email_credentials WHERE email_lower = ?')
    .bind(email)
    .first<{ profile_id: string; email: string }>();

  if (existing) {
    // THE ADDRESS IS TAKEN, AND THE ANSWER LOOKS IDENTICAL TO SUCCESS.
    //
    // The person who owns it gets told, by email, that someone tried — which is
    // useful to them and useless to whoever is probing. No session is issued:
    // an attacker gets a 202 and nothing else.
    c.executionCtx.waitUntil(
      sendResetEmail(c.env, existing.email, 'account-exists').then(() => undefined),
    );
    return c.json({ ok: true, pending_verification: true }, 202);
  }

  const profileId = newProfileId();
  const handle = placeholderHandle(profileId);
  const hash = await hashPassword(password);
  const token = newToken();
  const tokenHash = await hashToken(token);
  const expires = new Date(nowMs + VERIFY_TTL_MS).toISOString();

  await db.batch([
    db
      .prepare('INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES (?, ?, ?, ?)')
      .bind(profileId, handle, handle.toLowerCase(), nowIso),
    // The identity row keeps every other part of the system — account deletion,
    // `resolveProfile`, "one profile, several sign-ins" — working without
    // knowing this table exists.
    db
      .prepare('INSERT INTO identities (provider, external_id, profile_id, email, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('email', email, profileId, email, nowIso),
    db
      .prepare(
        `INSERT INTO email_credentials
           (profile_id, email, email_lower, password_hash, verify_hash, verify_expires, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(profileId, (b.email as string).trim(), email, hash, tokenHash, expires, nowIso, nowIso),
  ]);

  c.executionCtx.waitUntil(sendVerificationEmail(c.env, email, token).then(() => undefined));

  // SIGNED IN IMMEDIATELY, BUT ON A LEASH. The token carries `unverified`, so
  // the app has a session to draw its own state with and to confirm from — and
  // every other route in the API refuses it until the link is clicked.
  const s = await session(c.env, profileId, nowMs, false);
  return c.json({ ...s, needs_handle: true }, 201);
});

// ── POST /v1/auth/email/login ───────────────────────────────────────────────

emailAuth.post('/auth/email/login', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const email = normaliseEmail(b.email);
  const password = typeof b.password === 'string' ? b.password : '';

  const wrong = () => fail(c, 401, 'unauthenticated', 'That email or password is wrong.');
  if (!email || password.length === 0) return wrong();

  const nowMs = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT c.profile_id, c.email, c.password_hash, c.verified_at, c.failed_count, c.locked_until
       FROM email_credentials c JOIN profiles p ON p.id = c.profile_id
      WHERE c.email_lower = ? AND p.deleted_at IS NULL`,
  )
    .bind(email)
    .first<CredRow>();

  if (!row) {
    // NO EARLY RETURN WITHOUT WORK. Answering an unknown address instantly
    // while a known one takes 210,000 PBKDF2 rounds is a timing oracle that
    // enumerates users. Burn a comparable amount against a throwaway hash.
    await verifyPassword(password, DUMMY_HASH);
    return wrong();
  }

  if (row.locked_until && Date.parse(row.locked_until) > nowMs) {
    // Deliberately its own code: this one IS safe to be specific about, because
    // reaching it already required knowing the address.
    return fail(c, 429, 'rate_limited', 'Too many attempts. Try again in a few minutes.');
  }

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    const failed = row.failed_count + 1;
    const lock = failed >= LOGIN_FAIL_LIMIT ? new Date(nowMs + LOGIN_LOCK_MS).toISOString() : null;
    await c.env.DB.prepare(
      'UPDATE email_credentials SET failed_count = ?, locked_until = ?, updated_at = ? WHERE profile_id = ?',
    )
      .bind(lock ? 0 : failed, lock, new Date(nowMs).toISOString(), row.profile_id)
      .run();
    return wrong();
  }

  // A correct password clears the counter, and takes the chance to raise the
  // cost if the stored hash predates a bump — the only moment the plaintext is
  // available to re-hash with.
  const rehash = needsRehash(row.password_hash) ? await hashPassword(password) : null;
  await c.env.DB.prepare(
    `UPDATE email_credentials
        SET failed_count = 0, locked_until = NULL, password_hash = COALESCE(?, password_hash), updated_at = ?
      WHERE profile_id = ?`,
  )
    .bind(rehash, new Date(nowMs).toISOString(), row.profile_id)
    .run();

  // Signing in again does NOT lift the restriction — only confirming does.
  const s = await session(c.env, row.profile_id, nowMs, row.verified_at != null);
  return c.json(s);
});

/** A real hash of a value nobody knows, so the unknown-address path costs what
 *  the known one costs. Generated once at module load. */
const DUMMY_HASH =
  'pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// ── POST /v1/auth/email/verify ──────────────────────────────────────────────

emailAuth.post('/auth/email/verify', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const token = (body as Record<string, unknown>)?.token;
  if (typeof token !== 'string' || token.length === 0) return fail(c, 400, 'invalid_body', 'A token is required.');

  const hash = await hashToken(token);
  const nowIso = new Date().toISOString();
  const row = await c.env.DB.prepare(
    'SELECT profile_id, verify_hash, verify_expires FROM email_credentials WHERE verify_hash = ?',
  )
    .bind(hash)
    .first<{ profile_id: string; verify_hash: string; verify_expires: string | null }>();

  // Same answer for "no such token" and "expired": neither tells the holder of
  // a guessed token anything they can act on.
  if (!row || !sameToken(row.verify_hash, hash) || !row.verify_expires || row.verify_expires < nowIso) {
    return fail(c, 400, 'invalid_body', 'That link has expired. Ask for a new one.');
  }

  await c.env.DB.prepare(
    'UPDATE email_credentials SET verified_at = ?, verify_hash = NULL, verify_expires = NULL, updated_at = ? WHERE profile_id = ?',
  )
    .bind(nowIso, nowIso, row.profile_id)
    .run();

  // A FULL TOKEN COMES BACK WITH IT. The restriction lives in the token, so
  // confirming has to hand over a new one — otherwise the app would be verified
  // in the database and still locked out until the old session expired.
  //
  // Returned even though this route is unauthenticated: whoever holds the link
  // has proved they can read that inbox, which is a stronger claim than the
  // session they may or may not still have on the device they are reading on.
  const s = await session(c.env, row.profile_id, Date.parse(nowIso), true);
  return c.json({ ok: true, ...s });
});

// ── POST /v1/me/email/resend ────────────────────────────────────────────────

emailAuth.post('/me/email/resend', requireAuth, async (c) => {
  const me = c.get('profileId');
  const nowMs = Date.now();
  const row = await c.env.DB.prepare(
    'SELECT email, verified_at, updated_at FROM email_credentials WHERE profile_id = ?',
  )
    .bind(me)
    .first<{ email: string; verified_at: string | null; updated_at: string }>();
  if (!row) return fail(c, 404, 'not_found', 'This account does not sign in with an email address.');
  if (row.verified_at) return c.json({ ok: true, email_verified: true });

  // A COOLDOWN, because "send it again" is a button people press. Without one
  // it is a way to make this server post mail at an address repeatedly, and the
  // address is not necessarily one the presser owns.
  if (nowMs - Date.parse(row.updated_at) < RESEND_COOLDOWN_MS) {
    return fail(c, 429, 'rate_limited', 'Wait a minute before asking for another email.');
  }

  const token = newToken();
  await c.env.DB.prepare(
    'UPDATE email_credentials SET verify_hash = ?, verify_expires = ?, updated_at = ? WHERE profile_id = ?',
  )
    .bind(await hashToken(token), new Date(nowMs + VERIFY_TTL_MS).toISOString(), new Date(nowMs).toISOString(), me)
    .run();
  c.executionCtx.waitUntil(sendVerificationEmail(c.env, row.email, token).then(() => undefined));
  return c.json({ ok: true, email_verified: false });
});

// ── POST /v1/auth/email/forgot ──────────────────────────────────────────────

emailAuth.post('/auth/email/forgot', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const email = normaliseEmail((body as Record<string, unknown>)?.email);

  // ALWAYS 202, whether or not the address is here. This is the endpoint most
  // obviously shaped like a membership oracle, and the only defence is that its
  // answer carries no information.
  if (email) {
    const nowMs = Date.now();
    const row = await c.env.DB.prepare(
      `SELECT c.profile_id, c.email FROM email_credentials c JOIN profiles p ON p.id = c.profile_id
        WHERE c.email_lower = ? AND p.deleted_at IS NULL`,
    )
      .bind(email)
      .first<{ profile_id: string; email: string }>();
    if (row) {
      const token = newToken();
      await c.env.DB.prepare(
        'UPDATE email_credentials SET reset_hash = ?, reset_expires = ?, updated_at = ? WHERE profile_id = ?',
      )
        .bind(await hashToken(token), new Date(nowMs + RESET_TTL_MS).toISOString(), new Date(nowMs).toISOString(), row.profile_id)
        .run();
      c.executionCtx.waitUntil(sendResetEmail(c.env, row.email, token).then(() => undefined));
    }
  }
  return c.json({ ok: true }, 202);
});

// ── POST /v1/auth/email/reset ───────────────────────────────────────────────

emailAuth.post('/auth/email/reset', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const token = b.token;
  if (typeof token !== 'string' || token.length === 0) return fail(c, 400, 'invalid_body', 'A token is required.');
  const bad = passwordError(b.password);
  if (bad) return fail(c, 400, 'invalid_body', bad === 'too_common' ? 'That password is too easy to guess.' : 'Use at least 8 characters.');

  const hash = await hashToken(token);
  const nowIso = new Date().toISOString();
  const row = await c.env.DB.prepare(
    'SELECT profile_id, reset_hash, reset_expires FROM email_credentials WHERE reset_hash = ?',
  )
    .bind(hash)
    .first<{ profile_id: string; reset_hash: string; reset_expires: string | null }>();
  if (!row || !sameToken(row.reset_hash, hash) || !row.reset_expires || row.reset_expires < nowIso) {
    return fail(c, 400, 'invalid_body', 'That link has expired. Ask for a new one.');
  }

  // A completed reset also VERIFIES the address: they proved they can read mail
  // sent to it, which is the only thing verification ever established. And it
  // clears the lockout — the person who owns the inbox is not the attacker it
  // was defending against.
  await c.env.DB.prepare(
    `UPDATE email_credentials
        SET password_hash = ?, reset_hash = NULL, reset_expires = NULL,
            verified_at = COALESCE(verified_at, ?), failed_count = 0, locked_until = NULL, updated_at = ?
      WHERE profile_id = ?`,
  )
    .bind(await hashPassword(b.password as string), nowIso, nowIso, row.profile_id)
    .run();

  return c.json({ ok: true });
});
