import { Hono } from 'hono';
import type { App, Env } from '@/env';
import { fail } from '@/http';
import { runMaintenance } from '@/jobs';
import { auth } from '@/routes/auth';
import { avatars } from '@/routes/avatars';
import { blocks } from '@/routes/blocks';
import { characterVotes } from '@/routes/characters';
import { images } from '@/routes/images';
import { published } from '@/routes/published';
import { comments } from '@/routes/comments';
import { emailAuth } from '@/routes/email-auth';
import { follows } from '@/routes/follows';
import { seeding } from '@/routes/import';
import { notifications } from '@/routes/notifications';
import { push } from '@/routes/push';
import { profiles } from '@/routes/profiles';
import { ratings } from '@/routes/ratings';
import { reconcile } from '@/routes/reconcile';
import { reports } from '@/routes/reports';

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

// BEFORE `auth`, which owns `/me` and `/me/*` and hangs requireAuth off both.
// A router that claims a prefix should not be the one deciding what a path it
// has no handler for means.
v1.route('/', avatars);
// Before `auth` for the same reason avatars is: that router claims `/auth/*`
// shapes and `/me/*`, and should not be the one deciding what a path it has no
// handler for means.
v1.route('/', emailAuth);
v1.route('/', auth);
v1.route('/', ratings);
// Before `comments`, so POST /v1/comments/import is never read as a comment on
// a thread keyed "import" — and before it now also carries POST
// /v1/ratings/import, which for the same reason must precede nothing else.
v1.route('/', seeding);
v1.route('/', characterVotes);
v1.route('/', images);
v1.route('/', published);
v1.route('/', comments);
v1.route('/', reports);
v1.route('/', blocks);
v1.route('/', follows);
v1.route('/', profiles);
v1.route('/', notifications);
v1.route('/', push);
v1.route('/', reconcile);

app.route('/v1', v1);

/**
 * The safety net. Every route builds its failures with `fail()`, but an
 * *unhandled* throw — a D1 error mid-request, an unforeseen bug — would
 * otherwise return Hono's default 500, which is not the `{error:{code,message}}`
 * envelope the app parses and can echo the raw error text (a SQL message, a
 * stack) straight back to the client. So: log the real thing server-side, where
 * Workers observability keeps it, and hand the client a generic, conforming,
 * leak-free 500.
 */
app.onError((err, c) => {
  console.error('[unhandled]', err instanceof Error ? err.stack ?? err.message : String(err));
  return fail(c, 500, 'internal', 'Something went wrong.');
});

/**
 * Unknown routes answer in the same envelope, so the app's error handling —
 * which switches on `error.code` — never meets a shape it cannot read.
 */
app.notFound((c) => fail(c, 404, 'not_found', 'No such route.'));

/**
 * The 04:00 UTC cron (docs/IMPLEMENTATION.md Step 5). All the work lives in
 * `src/jobs.ts`; this is only the wiring. It awaits rather than handing the
 * promise to `waitUntil`: a scheduled handler that returns early can have its
 * remaining I/O cancelled, and `--test-scheduled` would then answer the curl
 * before the night's work had landed.
 */
const scheduled: ExportedHandlerScheduledHandler<Env> = async (event, env) => {
  console.log(`[maintenance] triggered by cron "${event.cron}"`);
  await runMaintenance(env);
};

export default { fetch: app.fetch, scheduled };
