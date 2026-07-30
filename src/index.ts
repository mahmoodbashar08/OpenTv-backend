import { Hono } from 'hono';

export type Env = {
  DB: D1Database;
  CACHE: KVNamespace;
};

const app = new Hono<{ Bindings: Env }>();

/**
 * Liveness. Touches D1 as well as the Worker, because "the Worker is up" and
 * "the database is reachable" fail independently and the difference is the
 * first thing worth knowing at 2am.
 */
app.get('/health', async (c) => {
  try {
    await c.env.DB.prepare('SELECT 1').first();
    return c.json({ ok: true, db: true });
  } catch {
    return c.json({ ok: true, db: false }, 503);
  }
});

export default app;
