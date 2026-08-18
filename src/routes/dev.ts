import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';

/**
 * The development Plus switch, and the server half of it.
 *
 * WHY IT HAS TO EXIST. Plus is checked in two places on purpose: the app asks
 * `isPlus()` for what it draws, and the server checks `is_plus` before it will
 * store anything a visitor would see. That is the right design — a client can
 * lie about entitlement, so the entitlement check belongs where the data lives.
 *
 * But it means a debug build with the Plus switch on believes something the
 * server denies, and the first thing that happens is a real feature failing
 * with a real refusal: "A profile theme needs OpenTV Plus", on a phone showing
 * every Plus screen. Testing the tier before it can be BOUGHT means the two
 * halves have to be switchable together.
 *
 * THREE THINGS KEEP THIS FROM BEING A HOLE:
 *
 *   - ABSENT SECRET IS OFF. `DEV_PLUS_SECRET` is unset in production, and
 *     without it this route 404s exactly like the admin surface does. A
 *     deployment that never sets it does not have this feature at all.
 *   - IT ONLY EVER TOUCHES THE CALLER'S OWN PROFILE. There is no handle
 *     parameter. Even a leaked secret cannot grant, revoke or inspect anybody
 *     else's tier.
 *   - IT NEEDS A REAL SESSION as well as the secret, so it is not an anonymous
 *     endpoint that hands out entitlement.
 *
 * It writes the same column a purchase would, so what is being tested is the
 * real path and not a simulation of it.
 */

export const dev = new Hono<App>();

/**
 * THE SECRET IS CHECKED BEFORE THE SESSION IS, and the order is the point.
 *
 * With `requireAuth` first, a caller holding no token got 401 — which is an
 * admission that the route is there. The gate has to answer identically to a
 * route that does not exist, for everybody, before anything else looks at the
 * request. 404 rather than 403 for the same reason: "wrong secret" is a
 * confirmation.
 */
const secretGate = createMiddleware<App>(async (c, next) => {
  const secret = c.env.DEV_PLUS_SECRET;
  if (!secret || c.req.header('X-Dev-Secret') !== secret) {
    return fail(c, 404, 'not_found', 'No such route.');
  }
  await next();
});

dev.post('/dev/plus', secretGate, requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const on = (body as { on?: unknown })?.on;
  if (typeof on !== 'boolean') return fail(c, 400, 'invalid_body', 'on must be a boolean.');

  const me = c.get('profileId');
  await c.env.DB.prepare('UPDATE profiles SET is_plus = ? WHERE id = ? AND deleted_at IS NULL')
    .bind(on ? 1 : 0, me)
    .run();

  /*
   * `plus_until` is cleared when switching OFF, and left alone otherwise.
   * `plusOn` reads both, so a stale future date would keep the tier alive
   * after the switch said to end it — which is precisely the state this route
   * exists to be able to reproduce.
   */
  if (!on) {
    await c.env.DB.prepare('UPDATE profiles SET plus_until = NULL WHERE id = ?').bind(me).run();
  }

  return c.json({ is_plus: on });
});
