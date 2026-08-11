import type { Env } from '@/env';

/**
 * A fixed-window counter per IP, in KV.
 *
 * FIXED, NOT SLIDING, so the window cannot be reset by hammering it — a sliding
 * one recomputed from "now" lets a caller who never stops keep pushing the
 * boundary ahead of themselves.
 *
 * The IP is HASHED before it becomes a key. A KV namespace listing every
 * address that has touched the API is a log of who uses OpenTV, which is the
 * one thing this server is built not to keep.
 *
 * Shared by every endpoint that can create something for free. Sign-in got one
 * early because it is the obvious target; registration did not, and that is the
 * hole this module exists to close — an unauthenticated endpoint that writes
 * three rows and can be called in a loop.
 */
export type Budget = { limit: number; windowSeconds: number };

/** Apple/Google sign-in. Generous: a real person retries, and each attempt
 *  costs a token verification and nothing durable. */
export const SESSION_BUDGET: Budget = { limit: 20, windowSeconds: 3600 };

/**
 * Creating accounts. Deliberately much tighter than signing in, because each
 * success is permanent: a profile, an identity, a credential row, and a licence
 * to upload a library's worth of comments and ratings. Five an hour is beyond
 * any honest use — a household behind one address making five accounts in an
 * hour is not a thing that happens — while a script asking for a hundred gets
 * ninety-five refusals.
 */
export const REGISTER_BUDGET: Budget = { limit: 5, windowSeconds: 3600 };

type Window = { n: number; reset: number };

async function ipHash(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** True when this caller is over budget. Counts the attempt when it is not. */
export async function overBudget(env: Env, bucket: string, ip: string, budget: Budget, nowMs: number): Promise<boolean> {
  const key = `rl:${bucket}:${await ipHash(ip)}`;
  const raw = await env.CACHE.get(key, 'json');
  const w =
    raw && typeof raw === 'object' && typeof (raw as Window).n === 'number' && (raw as Window).reset > nowMs
      ? (raw as Window)
      : { n: 0, reset: nowMs + budget.windowSeconds * 1000 };

  if (w.n >= budget.limit) return true;

  w.n += 1;
  // KV's floor for expirationTtl is 60s; a window with less than that left is
  // about to lapse anyway.
  const ttl = Math.max(60, Math.ceil((w.reset - nowMs) / 1000));
  await env.CACHE.put(key, JSON.stringify(w), { expirationTtl: ttl });
  return false;
}
