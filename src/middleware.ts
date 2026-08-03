import { createMiddleware } from 'hono/factory';
import type { App } from '@/env';
import { fail } from '@/http';
import { verifyScoped } from '@/session';

/**
 * `Authorization: Bearer <session-jwt>`. Nothing else — no cookies, because
 * there is no browser client and cookies would drag CSRF into a design with no
 * need of it.
 *
 * Zero I/O by design (docs/IMPLEMENTATION.md §1c/§1e): the token is verified
 * inside the isolate. Whether the profile still exists is settled by the
 * handler's own statement, which filters `deleted_at IS NULL`.
 */
export const requireAuth = createMiddleware<App>(async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (!match) return fail(c, 401, 'unauthenticated', 'Missing bearer token.');

  const session = await verifyScoped(c.env, match[1]!, Date.now());
  if (!session) return fail(c, 401, 'unauthenticated', 'Invalid or expired session.');

  c.set('profileId', session.profileId);
  c.set('scope', session.scope);
  await next();
  return;
});

/**
 * NOTHING UNTIL THE EMAIL IS CONFIRMED.
 *
 * An account created with an address nobody has proved they can read is an
 * anonymous account with a display name. It must not be able to comment, rate,
 * follow, publish a profile, upload a picture, or LOOK AT ANYBODY — the last
 * one matters because a throwaway address would otherwise be a free window onto
 * every profile and everything they watch.
 *
 * What stays reachable while unverified, and why each has to:
 *   GET  /v1/me                  — the app must be able to draw its own state
 *   POST /v1/me/email/verify     — the way out of this state
 *   POST /v1/me/email/resend     — the way out when the first mail did not come
 *   DELETE /v1/me                — nobody is trapped in an account they regret
 *
 * Zero I/O, like the middleware above: the claim is in the token, and the only
 * way to get a token without it is to enter the code.
 */
export const requireVerified = createMiddleware<App>(async (c, next) => {
  if (c.get('scope') === 'unverified') {
    return fail(c, 403, 'email_unverified', 'Confirm your email address first.');
  }
  await next();
  return;
});
