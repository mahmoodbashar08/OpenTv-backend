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

export async function sign(
  env: Env,
  profileId: string,
  nowMs: number,
): Promise<{ token: string; expiresAt: string }> {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + SESSION_TTL_SECONDS;
  const data = `${b64url(JSON.stringify(HEADER))}.${b64url(JSON.stringify({ sub: profileId, iat, exp }))}`;
  const token = `${data}.${await signingInput(env, data)}`;
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
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
