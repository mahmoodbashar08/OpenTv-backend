import { Hono } from 'hono';
import { verifyIdToken } from '@/auth';
import type { App, Env } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import { isHandleValid, needsHandle, normaliseHandle, placeholderHandle, type Provider } from '@/pure';
import { sign } from '@/session';

/**
 * Sign-in, the session, the handle flow, and account deletion.
 * docs/IMPLEMENTATION.md §1d, endpoint for endpoint.
 */

export const auth = new Hono<App>();

// ── shapes ───────────────────────────────────────────────────────────────────

type ProfileRow = {
  id: string;
  handle: string;
  handle_lower: string;
  display_name: string | null;
  avatar_key: string | null;
  bio: string | null;
  is_private: number;
  tvtime_user_id: number | null;
  tvtime_handle: string | null;
  links: string | null;
  plus_until: string | null;
  created_at: string;
  deleted_at: string | null;
};

function parseLinks(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The own-profile view. `handle_lower` and `deleted_at` are internal. */
function ownProfile(row: ProfileRow) {
  return {
    id: row.id,
    handle: row.handle,
    display_name: row.display_name,
    avatar_key: row.avatar_key,
    bio: row.bio,
    is_private: row.is_private,
    tvtime_user_id: row.tvtime_user_id,
    tvtime_handle: row.tvtime_handle,
    links: parseLinks(row.links),
    plus_until: row.plus_until,
    created_at: row.created_at,
  };
}

/** `p_` + a UUID with the hyphens stripped. Never the provider `sub` — that is the whole reason `identities` is a separate table. */
function newProfileId(): string {
  return `p_${crypto.randomUUID().replace(/-/g, '')}`;
}

// ── rate limiting ────────────────────────────────────────────────────────────
//
// KV-backed, and ONLY here (docs/IMPLEMENTATION.md, "Rate limiting"): this is
// the one endpoint that does expensive work (JWKS fetch + RSA verify) for an
// unauthenticated caller, and it is low volume by nature — once per install
// per week. Everything else is covered by the WAF rule and by per-user limits
// in D1. KV's free tier is 1,000 writes/day; a counter on every route would
// exhaust it before breakfast.

const AUTH_LIMIT = 20;
const AUTH_WINDOW_SECONDS = 3600;

async function ipHash(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

type Window = { n: number; reset: number };

/** True when the caller is over the limit. Fixed window, so the TTL cannot be reset by hammering. */
async function overAuthLimit(env: Env, ip: string, nowMs: number): Promise<boolean> {
  const key = `rl:auth:${await ipHash(ip)}`;
  const raw = await env.CACHE.get(key, 'json');
  const w =
    raw && typeof raw === 'object' && typeof (raw as Window).n === 'number' && (raw as Window).reset > nowMs
      ? (raw as Window)
      : { n: 0, reset: nowMs + AUTH_WINDOW_SECONDS * 1000 };

  if (w.n >= AUTH_LIMIT) return true;

  w.n += 1;
  // KV's floor for expirationTtl is 60s; a window with less than that left is
  // about to lapse anyway.
  const ttl = Math.max(60, Math.ceil((w.reset - nowMs) / 1000));
  await env.CACHE.put(key, JSON.stringify(w), { expirationTtl: ttl });
  return false;
}

/**
 * The profile behind an identity — found, or created together with it.
 *
 * Shared by the real sign-in and the development one below, so the two cannot
 * drift: a test account built even slightly differently from a real one would
 * be testing something the app never does.
 */
async function resolveProfile(
  db: D1Database,
  provider: string,
  subject: string,
  email: string | null,
  nowIso: string,
): Promise<ProfileRow | null> {
  const lookup = db
    .prepare(
      `SELECT p.* FROM identities i JOIN profiles p ON p.id = i.profile_id
       WHERE i.provider = ? AND i.external_id = ?`,
    )
    .bind(provider, subject);

  // 1. The lookup runs first, alone: a batch() cannot branch on a result.
  let row = await lookup.first<ProfileRow>();

  if (row && row.deleted_at) {
    // Defensive only — DELETE /v1/me removes the identity row, so a deleted
    // profile should never still be reachable through one. Treat it as absent
    // and re-point the identity at a fresh profile.
    const id = newProfileId();
    await db.batch([
      db
        .prepare('INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES (?, ?, ?, ?)')
        .bind(id, placeholderHandle(id), placeholderHandle(id), nowIso),
      db
        .prepare(
          'UPDATE identities SET profile_id = ?, email = ?, created_at = ? WHERE provider = ? AND external_id = ?',
        )
        .bind(id, email, nowIso, provider, subject),
    ]);
    return db.prepare('SELECT * FROM profiles WHERE id = ?').bind(id).first<ProfileRow>();
  }

  if (!row) {
    // 2. Not found → one batch, so a crash cannot orphan an identity.
    const id = newProfileId();
    const handle = placeholderHandle(id);
    try {
      await db.batch([
        db
          .prepare('INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES (?, ?, ?, ?)')
          .bind(id, handle, handle, nowIso),
        db
          .prepare(
            'INSERT INTO identities (provider, external_id, profile_id, email, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .bind(provider, subject, id, email, nowIso),
      ]);
      row = await db.prepare('SELECT * FROM profiles WHERE id = ?').bind(id).first<ProfileRow>();
    } catch {
      // The race — two devices, first sign-in, same instant — resolves at the
      // identities primary key. The loser re-runs the lookup and returns the
      // winner's profile.
      row = await lookup.first<ProfileRow>();
    }
  }
  return row;
}

// ── POST /v1/auth/session ────────────────────────────────────────────────────

auth.post('/auth/session', async (c) => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const ip = c.req.header('CF-Connecting-IP') ?? '0.0.0.0';
  if (await overAuthLimit(c.env, ip, now)) {
    return fail(c, 429, 'rate_limited', 'Too many sign-in attempts. Try again later.');
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const provider = b.provider;
  if (provider !== 'apple' && provider !== 'google') {
    return fail(c, 400, 'invalid_body', 'provider must be "apple" or "google".');
  }
  if (typeof b.id_token !== 'string' || b.id_token.length === 0) {
    return fail(c, 400, 'invalid_body', 'id_token is required.');
  }
  // `tvtime_user_id` may appear in the body and is IGNORED here. It is written
  // write-once by POST /v1/me/friends/reconcile (Step 4) and nowhere else.

  const verified = await verifyIdToken(c.env, provider as Provider, b.id_token, now);
  if (!verified.ok) return fail(c, 401, 'unauthenticated', 'ID token rejected.');

  const row = await resolveProfile(c.env.DB, provider, verified.token.sub, verified.token.email ?? null, nowIso);
  if (!row) return fail(c, 500, 'internal', 'Could not establish a profile.');

  const { token, expiresAt } = await sign(c.env, row.id, now);
  return c.json({
    token,
    expires_at: expiresAt,
    profile: ownProfile(row),
    needs_handle: needsHandle(row.handle),
  });
});

// ── POST /v1/auth/dev — exists only where DEV_AUTH_SECRET is set ────────────

/**
 * A sign-in with no Apple or Google account behind it, for testing.
 *
 * WHY. The community cannot be exercised by one person: a percentage needs two
 * opinions, a thread needs two voices, a follow needs somebody to follow.
 * Provider accounts are the honest way to get them and they are slow — a
 * two-factor prompt on a simulator with no phone, an Apple ID per tester — so
 * the multi-account paths kept going untested. This makes a second and third
 * account instant.
 *
 * THIS IS AN AUTHENTICATION BYPASS, and it is written to be impossible to leave
 * on by accident:
 *
 *  - NO SECRET, NO ROUTE. Without a `DEV_AUTH_SECRET` binding it answers 404 —
 *    not 403, which would confirm to a stranger that the endpoint exists and is
 *    merely locked. Production never sets it. `auth.test.ts` asserts the 404.
 *  - ITS OWN NAMESPACE. Every account lands under provider `dev` with a `dev_`
 *    subject, which no Apple or Google identity can collide with, so
 *    `DELETE FROM identities WHERE provider = 'dev'` removes every account it
 *    has ever created and touches nothing real.
 *  - IT GRANTS NOTHING EXTRA. The session it signs is an ordinary one for an
 *    ordinary profile. It cannot reach an existing account: the subject is
 *    derived from the name given, inside a namespace real providers never use.
 *
 * DELETE THE SECRET WHEN THE TEST IS OVER (`wrangler secret delete
 * DEV_AUTH_SECRET`). While it is set, anyone holding it can mint a session for
 * a test account on this server.
 */
auth.post('/auth/dev', async (c) => {
  const secret = c.env.DEV_AUTH_SECRET;
  if (!secret) return c.notFound();

  const offered = c.req.header('X-Dev-Secret') ?? '';
  if (offered.length !== secret.length || offered !== secret) {
    return fail(c, 401, 'unauthenticated', 'Bad dev secret.');
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const who = typeof b.name === 'string' ? b.name.trim().toLowerCase() : '';
  // Constrained so the subject cannot be steered anywhere interesting: the
  // whole identity is `dev_` plus these characters.
  if (!/^[a-z0-9_-]{2,24}$/.test(who)) {
    return fail(c, 400, 'invalid_body', 'name must be 2-24 characters of a-z, 0-9, _ or -.');
  }

  const now = Date.now();
  const row = await resolveProfile(
    c.env.DB,
    'dev',
    `dev_${who}`,
    `${who}@dev.invalid`,
    new Date(now).toISOString(),
  );
  if (!row) return fail(c, 500, 'internal', 'Could not establish a profile.');

  const { token, expiresAt } = await sign(c.env, row.id, now);
  return c.json({
    token,
    expires_at: expiresAt,
    profile: ownProfile(row),
    needs_handle: needsHandle(row.handle),
  });
});

// ── everything below needs a session ─────────────────────────────────────────

auth.use('/me', requireAuth);
auth.use('/me/*', requireAuth);

// ── GET /v1/me ───────────────────────────────────────────────────────────────

auth.get('/me', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM notifications WHERE recipient_id = p.id AND read_at IS NULL) AS unread
     FROM profiles p WHERE p.id = ? AND p.deleted_at IS NULL`,
  )
    .bind(c.get('profileId'))
    .first<ProfileRow & { unread: number }>();

  // A token for a vanished profile is not a valid session.
  if (!row) return fail(c, 401, 'unauthenticated', 'No such profile.');

  return c.json({
    ...ownProfile(row),
    unread_notifications: row.unread,
    needs_handle: needsHandle(row.handle),
  });
});

// ── PATCH /v1/me ─────────────────────────────────────────────────────────────

/** Everything a user may change about themselves. Nothing else, ever. */
const PATCHABLE = ['display_name', 'bio', 'is_private', 'links'] as const;

const MAX_DISPLAY_NAME = 100;
const MAX_BIO = 500;

auth.patch('/me', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(c, 400, 'invalid_body', 'Body must be an object.');
  }
  const b = body as Record<string, unknown>;

  // `plus_until`, `handle` and `tvtime_user_id` are not merely ignored — the
  // whole body is refused, so a client that thinks it is granting itself Plus
  // finds out immediately (docs/IMPLEMENTATION.md §1d).
  const keys = Object.keys(b);
  if (keys.some((k) => !(PATCHABLE as readonly string[]).includes(k))) {
    return fail(c, 400, 'invalid_body', 'Only display_name, bio, is_private and links may be changed.');
  }
  if (keys.length === 0) return fail(c, 400, 'invalid_body', 'Nothing to change.');

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];

  if ('display_name' in b) {
    const v = b.display_name;
    if (v !== null && typeof v !== 'string') return fail(c, 400, 'invalid_body', 'display_name must be a string or null.');
    const s = v === null ? null : v.trim();
    if (s !== null && s.length > MAX_DISPLAY_NAME) return fail(c, 400, 'invalid_body', 'display_name is too long.');
    sets.push('display_name = ?');
    binds.push(s && s.length > 0 ? s : null);
  }
  if ('bio' in b) {
    const v = b.bio;
    if (v !== null && typeof v !== 'string') return fail(c, 400, 'invalid_body', 'bio must be a string or null.');
    const s = v === null ? null : v.trim();
    if (s !== null && s.length > MAX_BIO) return fail(c, 400, 'invalid_body', 'bio is too long.');
    sets.push('bio = ?');
    binds.push(s && s.length > 0 ? s : null);
  }
  if ('is_private' in b) {
    const v = b.is_private;
    const ok = typeof v === 'boolean' || v === 0 || v === 1;
    if (!ok) return fail(c, 400, 'invalid_body', 'is_private must be a boolean.');
    sets.push('is_private = ?');
    binds.push(v === true || v === 1 ? 1 : 0);
  }
  if ('links' in b) {
    const v = b.links;
    const ok = v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
    if (!ok) return fail(c, 400, 'invalid_body', 'links must be an array of strings or null.');
    sets.push('links = ?');
    binds.push(v === null || (v as string[]).length === 0 ? null : JSON.stringify(v));
  }

  const me = c.get('profileId');
  const res = await c.env.DB.prepare(
    `UPDATE profiles SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(...binds, me)
    .run();
  if (res.meta.changes === 0) return fail(c, 401, 'unauthenticated', 'No such profile.');

  const row = await c.env.DB.prepare('SELECT * FROM profiles WHERE id = ?').bind(me).first<ProfileRow>();
  return c.json(ownProfile(row!));
});

// ── POST /v1/me/handle ───────────────────────────────────────────────────────

auth.post('/me/handle', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.handle !== 'string') return fail(c, 400, 'invalid_body', 'handle is required.');
  if ('check_only' in b && typeof b.check_only !== 'boolean') {
    return fail(c, 400, 'invalid_body', 'check_only must be a boolean.');
  }

  const check = isHandleValid(b.handle);
  if (!check.ok) {
    return fail(c, 400, 'handle_invalid', `That handle is not allowed (${check.reason}).`);
  }
  const lower = check.handle;
  // The stored `handle` is the normalised form: what the user typed differing
  // from what everyone sees would be a homograph vector by another name.
  const display = lower;
  const me = c.get('profileId');

  if (b.check_only === true) {
    const taken = await c.env.DB.prepare(
      'SELECT 1 AS one FROM profiles WHERE handle_lower = ? AND id <> ?',
    )
      .bind(lower, me)
      .first();
    if (taken) return fail(c, 409, 'handle_taken', 'That handle is in use.');
    return c.json({ available: true });
  }

  try {
    const res = await c.env.DB.prepare(
      `UPDATE profiles SET handle = ?, handle_lower = ?
       WHERE id = ? AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM profiles WHERE handle_lower = ? AND id <> ?)`,
    )
      .bind(display, lower, me, lower, me)
      .run();
    // Zero rows changed → someone else holds it (or the row is gone).
    if (res.meta.changes === 0) return fail(c, 409, 'handle_taken', 'That handle is in use.');
  } catch {
    // The check above is racy by construction; the UNIQUE index on
    // handle_lower is the real guarantee, so its error means the same thing.
    return fail(c, 409, 'handle_taken', 'That handle is in use.');
  }

  return c.json({ available: true, handle: display });
});

// ── DELETE /v1/me ────────────────────────────────────────────────────────────

auth.delete('/me', async (c) => {
  const me = c.get('profileId');
  const nowIso = new Date().toISOString();
  const db = c.env.DB;

  const row = await db
    .prepare('SELECT id, avatar_key FROM profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(me)
    .first<{ id: string; avatar_key: string | null }>();
  if (!row) return fail(c, 401, 'unauthenticated', 'No such profile.');

  await db.batch([
    // Signing in again must create a NEW profile — that is what "deleted"
    // means to the user.
    db.prepare('DELETE FROM identities WHERE profile_id = ?').bind(me),
    db.prepare('DELETE FROM comment_likes WHERE user_id = ?').bind(me),
    db.prepare('DELETE FROM comments WHERE author_id = ?').bind(me),
    db.prepare('DELETE FROM ratings WHERE author_id = ?').bind(me),
    db.prepare('DELETE FROM follows WHERE follower_id = ? OR followee_id = ?').bind(me, me),
    db.prepare('DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?').bind(me, me),
    db.prepare('DELETE FROM list_items WHERE list_id IN (SELECT id FROM lists WHERE owner_id = ?)').bind(me),
    db.prepare('DELETE FROM lists WHERE owner_id = ?').bind(me),
    db.prepare('DELETE FROM notifications WHERE recipient_id = ?').bind(me),

    // The profiles row is SCRUBBED, not deleted. Hard-deleting would cascade
    // away the reports this person filed — silently defeating the 24-hour
    // moderation clock — and would be refused outright for anyone who has ever
    // moderated, because moderation_actions.moderator_id has no ON DELETE
    // clause. Step 5's job purges the shell after 30 days, by which time the
    // queue is long since resolved. No personal data survives in it.
    db
      .prepare(
        `UPDATE profiles SET
           deleted_at = ?,
           handle = 'deleted_' || substr(id, 3, 8),
           handle_lower = 'deleted_' || substr(id, 3, 8),
           display_name = NULL, bio = NULL, avatar_key = NULL, links = NULL,
           tvtime_user_id = NULL, tvtime_handle = NULL
         WHERE id = ?`,
      )
      .bind(nowIso, me),
  ]);

  // The avatar object. There is no R2 binding yet (avatars ship later, see
  // docs/IMPLEMENTATION.md Step 6), so this is guarded on both sides and
  // becomes live the day `AVATARS` is added to wrangler.jsonc.
  if (row.avatar_key && c.env.AVATARS) {
    try {
      await c.env.AVATARS.delete(row.avatar_key);
    } catch {
      // An orphaned object is swept by the Step 5 job; failing the deletion
      // over it would be the wrong trade.
    }
  }

  // Ratings are removed without correcting rating_aggregates: that drift is
  // expected and is exactly what the Step 5 reconciliation job exists for.
  //
  // Nothing here touches the phone. The app deletes nothing local on account
  // deletion and says so on the confirmation screen.
  return c.body(null, 204);
});
