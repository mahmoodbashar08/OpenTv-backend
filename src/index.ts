import { Hono } from 'hono';
import type { App } from '@/env';
import { auth } from '@/routes/auth';

export type { Env } from '@/env';

const app = new Hono<App>();

/**
 * Liveness. Touches D1 as well as the Worker, because "the Worker is up" and
 * "the database is reachable" fail independently and the difference is the
 * first thing worth knowing at 2am.
 *
 * The only route outside /v1: it is infrastructure, not API.
 */
app.get('/health', async (c) => {
  try {
    await c.env.DB.prepare('SELECT 1').first();
    return c.json({ ok: true, db: true });
  } catch {
    return c.json({ ok: true, db: false }, 503);
  }
});

/**
 * Every API route is mounted under /v1 from day one. Adding a prefix later
 * means a client-side flag day, and this ships to phones that update slowly
 * and to phones that never update.
 */
const v1 = new Hono<App>();

v1.route('/', auth);

app.route('/v1', v1);

export default app;
