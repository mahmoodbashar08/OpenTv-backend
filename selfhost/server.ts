/**
 * OpenTV's server, running on Node instead of Cloudflare.
 *
 * WHAT MAKES THIS SHORT. The Worker is Hono, and Hono runs on Node unchanged —
 * so every route, every middleware and every line of `src/` is the same code
 * here as in production. Only the four bindings differ, and each has an adapter
 * beside this file. Nothing in `src/` knows which one it got, which is the
 * property that keeps the two from drifting.
 *
 * ONE CONTAINER, ONE FILE. No Postgres, no Redis, no object store, no reverse
 * proxy required. The data is already SQLite-shaped because D1 is SQLite, and
 * the only bytes are pictures, which a directory holds perfectly well. Put the
 * volume somewhere backed up and that is the whole operational story.
 *
 * WHAT A SELF-HOSTED INSTANCE DOES NOT GET, and says so rather than failing:
 *
 *   - TRANSLATION. `AI` is Workers AI. Absent, and the app hides the Translate
 *     row, exactly as it does on a Worker without the binding.
 *   - PUSH is unaffected; it goes through Expo, not Cloudflare.
 *   - EDGE CACHING. `caches.default` does not exist here, so aggregate reads go
 *     to SQLite every time. On one household's instance that is faster than the
 *     cache would have been.
 *
 * These are all the SAME optional-binding paths production already takes when a
 * binding is missing. Nothing here adds a second way to be degraded.
 */
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';

import { d1 } from '../src/adapters/d1-sqlite';
import { fsBucket } from '../src/adapters/fs-bucket';
import { sqliteKv } from '../src/adapters/kv-sqlite';
import type { Env } from '../src/env';
import worker from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(process.env.DATA_DIR ?? join(here, '..', 'data'));
const PORT = Number(process.env.PORT ?? 8787);

/**
 * `caches.default` is workerd's, and two read paths reach for it on every call.
 * A permanent miss is the honest stand-in — the same one the test suite uses,
 * for the same reason: it exercises the D1 path rather than pretending to be a
 * cache that never returns anything.
 */
(globalThis as unknown as { caches: unknown }).caches = {
  default: {
    async match() {
      return undefined;
    },
    async put() {
      /* consumed and dropped */
    },
  },
};

/**
 * MIGRATIONS ARE THE SCHEMA, read from the same files `wrangler d1 migrations`
 * applies. Restating them here is how a self-hosted instance ends up with a
 * schema production does not have, and the first symptom is a 500 nobody can
 * reproduce.
 *
 * Applied in filename order, every start, each inside `IF NOT EXISTS`-shaped
 * SQL. Re-running is a no-op, which is what makes "start the container" the
 * entire upgrade procedure.
 */
function migrate(db: Database.Database): number {
  const dir = join(here, '..', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) db.exec(readFileSync(join(dir, f), 'utf8'));
  return files.length;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    // Fail at boot, loudly. A server that starts without a signing secret
    // issues tokens anybody can mint, and it would look perfectly healthy.
    console.error(`[opentv] ${name} is not set. Refusing to start.`);
    process.exit(1);
  }
  return v;
}

mkdirSync(DATA, { recursive: true });
const raw = new Database(join(DATA, 'opentv.db'));
raw.pragma('journal_mode = WAL');
raw.pragma('foreign_keys = ON');
const applied = migrate(raw);

const env: Env = {
  DB: d1(raw),
  CACHE: sqliteKv(raw),
  SESSION_SECRET: required('SESSION_SECRET'),
  APPLE_BUNDLE_ID: process.env.APPLE_BUNDLE_ID ?? 'com.insightfy.opentv',
  GOOGLE_CLIENT_IDS: process.env.GOOGLE_CLIENT_IDS ?? '',
  AVATARS: fsBucket(join(DATA, 'avatars')),
  COMMENT_IMAGES: fsBucket(join(DATA, 'comment-images')),
  // Left undefined on purpose where a feature has no local equivalent — the
  // routes already treat a missing binding as "this instance does not do that".
  ...(process.env.ADMIN_EMAIL ? { ADMIN_EMAIL: process.env.ADMIN_EMAIL } : {}),
  ...(process.env.ADMIN_PASSWORD ? { ADMIN_PASSWORD: process.env.ADMIN_PASSWORD } : {}),
  ...(process.env.RC_WEBHOOK_SECRET ? { RC_WEBHOOK_SECRET: process.env.RC_WEBHOOK_SECRET } : {}),
} as Env;

serve({ fetch: (req: Request) => worker.fetch(req, env, ctx()), port: PORT }, (info) => {
  console.log(`[opentv] listening on :${info.port}`);
  console.log(`[opentv] data in ${DATA} — back this directory up, it is everything`);
  console.log(`[opentv] ${applied} migrations applied`);
  if (!process.env.GOOGLE_CLIENT_IDS) console.log('[opentv] no Google client ids — Google sign-in is off');
  console.log('[opentv] no Workers AI — comment translation is off');
});

/**
 * `waitUntil` on a Worker keeps the isolate alive for work started during a
 * request. Node has no isolate to keep alive: the process outlives the
 * response, so simply running the promise is the correct translation. Errors
 * are swallowed for the same reason production swallows them — background work
 * failing must not take the server with it.
 */
function ctx(): ExecutionContext {
  return {
    waitUntil(p: Promise<unknown>) {
      void Promise.resolve(p).catch((e) => console.error('[opentv] background task failed', e));
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}
