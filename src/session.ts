import { Buffer } from 'node:buffer';
import type { Env } from '@/env';

/**
 * Session tokens: a short-lived HS256 JWT signed with a Worker secret. There
 * is no sessions table, on purpose (docs/IMPLEMENTATION.md §1c) — an opaque
 * token would cost an indexed D1 read on *every* authenticated request, and a
 * signed token verifies inside the isolate with no I/O at all.
 *
 * Revocation does not bite: every write joins `profiles` with
 * `deleted_at IS NULL`, so a deleted or banned account cannot write even while
 * holding a valid token. Seven days is short enough that a stale token dies on
 * its own, and the app silently re-authenticates.
 */

/** Seven days. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export type SessionClaims = { sub: string; iat: number; exp: number };

const HEADER = { alg: 'HS256', typ: 'JWT' };

function b64url(bytes: Uint8Array | string): string {
  return Buffer.from(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes).toString(
    'base64url',
  );
}

async function hmacKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SESSION_SECRET ?? ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function signingInput(env: Env, data: string): Promise<string> {
  const key = await hmacKey(env);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64url(new Uint8Array(mac));
}

/** Length-safe, branch-free comparison. Never `===` on a signature. */
function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  // The length check leaks only the length, which the token format already fixes.
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/**
 * `unverified` — an email account that has not entered its code yet.
 *
 * IT LIVES IN THE TOKEN, not in a database lookup, because `requireAuth` does
 * zero I/O by design and adding a read there would put a D1 round trip in front
 * of every authenticated request in the app. A claim costs nothing, and the
 * only way to change it is to be issued a new token — which is exactly what
 * verifying does.
 */
export type SessionScope = 'full' | 'unverified';

export async function sign(
  env: Env,
  profileId: string,
  nowMs: number,
  scope: SessionScope = 'full',
  epoch = 0,
): Promise<{ token: string; expiresAt: string }> {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + SESSION_TTL_SECONDS;
  // `scp` omitted entirely when full, so every existing token stays valid and
  // every other provider's payload is byte-for-byte what it was.
  // `ep` omitted when 0 — which is every account that has never revoked —
  // so the common token is byte-for-byte what it always was.
  const base = scope === 'full' ? { sub: profileId, iat, exp } : { sub: profileId, iat, exp, scp: scope };
  const claims = epoch > 0 ? { ...base, ep: epoch } : base;
  const data = `${b64url(JSON.stringify(HEADER))}.${b64url(JSON.stringify(claims))}`;
  const token = `${data}.${await signingInput(env, data)}`;
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/** The profile id AND what the token is allowed to do, or null if it is not a
 *  live, intact token. */
/**
 * REVOCATION, and the one piece of I/O in the auth path.
 *
 * The current epoch for a profile lives in KV and is written ONLY when
 * something revokes — a password reset, or "sign out my other devices". For
 * every account that has never done either there is no key, the read misses,
 * and any token is accepted. That is the overwhelmingly common case.
 *
 * MEMOISED PER ISOLATE, because a KV read on every authenticated request would
 * undo the reason `requireAuth` was written to do no I/O at all. Workers reuse
 * an isolate across many requests, so a small map with a short life turns "one
 * read per request" into "one read per minute per colo".
 *
 * THE STALENESS IS DELIBERATE AND BOUNDED. A revoked session can survive up to
 * `EPOCH_CACHE_MS` plus KV's own propagation. Measured against what it replaces
 * — a stolen session living for the full seven days — a minute is the right
 * trade for keeping every request fast.
 */
const EPOCH_CACHE_MS = 60_000;
const epochCache = new Map<string, { epoch: number; readAt: number }>();

async function currentEpoch(env: Env, profileId: string, nowMs: number): Promise<number> {
  const hit = epochCache.get(profileId);
  if (hit && nowMs - hit.readAt < EPOCH_CACHE_MS) return hit.epoch;
  let epoch = 0;
  try {
    const raw = await env.CACHE.get(`ep:${profileId}`);
    epoch = raw ? Number(raw) || 0 : 0;
  } catch {
    // KV unavailable: fail OPEN. A revocation that lands a minute late is a
    // smaller harm than every signed-in user being logged out by an outage.
    epoch = hit?.epoch ?? 0;
  }
  epochCache.set(profileId, { epoch, readAt: nowMs });
  return epoch;
}

/** Raise the epoch: every token issued before now stops working. */
export async function revokeSessions(env: Env, profileId: string, epoch: number): Promise<void> {
  await env.CACHE.put(`ep:${profileId}`, String(epoch));
  epochCache.set(profileId, { epoch, readAt: Date.now() });
}

export async function verifyScoped(
  env: Env,
  token: string,
  nowMs: number,
): Promise<{ profileId: string; scope: SessionScope } | null> {
  const sub = await verify(env, token, nowMs);
  if (!sub) return null;
  // Re-read the payload for the claims. The signature is already proven above,
  // so this is a parse of trusted bytes rather than a second verification.
  let scope: SessionScope = 'full';
  let ep = 0;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as {
      scp?: unknown;
      ep?: unknown;
    };
    if (payload.scp === 'unverified') scope = 'unverified';
    ep = typeof payload.ep === 'number' ? payload.ep : 0;
  } catch {
    /* claims unreadable: treat as a plain, un-revoked, full token */
  }

  if ((await currentEpoch(env, sub, nowMs)) > ep) return null;
  return { profileId: sub, scope };
}

/** The profile id, or null for anything that is not a live, intact token. */
export async function verify(env: Env, token: string, nowMs: number): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];

  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!header || typeof header !== 'object' || (header as { alg?: unknown }).alg !== 'HS256') {
    return null;
  }

  const expected = await signingInput(env, `${h}.${p}`);
  if (!constantTimeEqual(expected, s)) return null;

  const c = payload as Partial<SessionClaims>;
  if (typeof c.sub !== 'string' || c.sub.length === 0) return null;
  if (typeof c.exp !== 'number' || c.exp * 1000 <= nowMs) return null;

  return c.sub;
}
