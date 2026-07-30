import { createMiddleware } from 'hono/factory';
import type { App } from '@/env';
import { fail } from '@/http';
import { verify } from '@/session';

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

  const profileId = await verify(c.env, match[1]!, Date.now());
  if (!profileId) return fail(c, 401, 'unauthenticated', 'Invalid or expired session.');

  c.set('profileId', profileId);
  await next();
  return;
});
