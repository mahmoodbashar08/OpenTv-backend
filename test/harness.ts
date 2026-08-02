import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { Env } from '@/env';
import worker from '@/index';
import { D1_MAX_BOUND_PARAMS } from '@/pure';
import { sign } from '@/session';

/**
 * The in-memory database every test that touches SQL runs against.
 *
 * The schema is READ FROM THE MIGRATION FILES, never restated here. A copied
 * schema drifts from the real one the first time a migration lands, and a test
 * that passes against a schema production does not have is worse than no test.
 * **Every new migration goes in this list.**
 */
const MIGRATION_FILES = [
  '../migrations/0001_initial.sql',
  '../migrations/0002_comment_hidden.sql',
  '../migrations/0003_character_votes.sql',
  '../migrations/0004_score_distribution.sql',
  '../migrations/0005_emotion_votes.sql',
  '../migrations/0006_published_profile.sql',
  '../migrations/0007_profile_movie_stats.sql',
  '../migrations/0008_profile_title_fav_rank.sql',
  '../migrations/0009_push_tokens.sql',
];

export const MIGRATIONS = MIGRATION_FILES.map((p) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'),
);

/**
 * The smallest honest D1 shim: `prepare().bind().run()/all()/first()` with
 * `meta.changes`. Synchronous underneath, async on the outside, exactly as D1
 * presents itself.
 *
 * `batch()` executes in order and does not roll back — the ordering is the half
 * the import endpoints actually depend on (the rollup statement's
 * `WHERE NOT EXISTS` guard must run before that item's insert), and atomicity
 * is D1's to provide.
 *
 * It also returns `results` for a SELECT, which D1 does and an earlier version
 * of this shim did not: it called `run()` on every statement and threw the rows
 * away. A batch of SELECTs would have come back as a row of empty envelopes,
 * and the first route to read a list through `batch()` would have been tested
 * against a lie.
 */
export function d1(db: Database.Database): D1Database {
  const prepare = (sql: string, binds: unknown[] = []): D1PreparedStatement => {
    // THE LIMIT SQLITE DOES NOT HAVE AND D1 DOES.
    //
    // better-sqlite3 will happily bind a thousand parameters, so a shim without
    // this line reports green for a statement production answers with a 500.
    // That is exactly how the aggregate list form shipped: its tests only ever
    // asked for one or two targets, and would have passed at a hundred.
    if (binds.length > D1_MAX_BOUND_PARAMS) {
      throw new Error(
        `D1 binds at most ${D1_MAX_BOUND_PARAMS} parameters per query; this one has ${binds.length}.`,
      );
    }
    const stmt = () => db.prepare(sql);
    const api = {
      bind: (...values: unknown[]) => prepare(sql, values),
      async run() {
        const info = stmt().run(...(binds as never[]));
        return { success: true, meta: { changes: info.changes } };
      },
      async all() {
        return { success: true, results: stmt().all(...(binds as never[])), meta: {} };
      },
      async first(col?: string) {
        const row = stmt().get(...(binds as never[])) as Record<string, unknown> | undefined;
        if (!row) return null;
        return col === undefined ? row : (row[col] ?? null);
      },
      async raw() {
        return [];
      },
      /**
       * What one member of a `batch()` returns: rows when it reads, `changes`
       * when it writes. better-sqlite3 refuses `all()` on a non-reader and
       * `run()` discards rows, so the two are told apart by `stmt.reader`.
       */
      async batchRun() {
        const st = stmt();
        if (st.reader) {
          return { success: true, results: st.all(...(binds as never[])), meta: { changes: 0 } };
        }
        const info = st.run(...(binds as never[]));
        return { success: true, results: [], meta: { changes: info.changes } };
      },
    };
    return api as unknown as D1PreparedStatement;
  };

  const api = {
    prepare: (sql: string) => prepare(sql),
    async batch(stmts: D1PreparedStatement[]) {
      const out: unknown[] = [];
      for (const s of stmts) out.push(await (s as unknown as { batchRun(): Promise<unknown> }).batchRun());
      return out;
    },
  };
  return api as unknown as D1Database;
}

export function freshDatabase(): { raw: Database.Database; db: D1Database } {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  for (const sql of MIGRATIONS) raw.exec(sql);
  return { raw, db: d1(raw) };
}

// ── the Worker, driven end to end ────────────────────────────────────────────

/**
 * `caches.default` does not exist outside workerd, and the edge-cached reads
 * (`GET /v1/aggregates`, `GET /v1/character-votes`) reach for it on every call.
 * A permanent MISS is the honest stand-in: it exercises the D1 path, which is
 * the half a test can be wrong about.
 */
const noCache = {
  async match() {
    return undefined;
  },
  async put() {
    /* the response is consumed and dropped */
  },
};
(globalThis as unknown as { caches: unknown }).caches = { default: noCache };

/**
 * An R2 bucket that keeps what it is given, in a Map.
 *
 * Only `put` is implemented because only `put` is called: nothing in the API
 * reads an image back out yet, by design (see `routes/images.ts`). `stored`
 * is exposed so a test can assert the bytes and the content type actually
 * reached storage rather than trusting the 200.
 */
export function fakeBucket(): R2Bucket & { stored: Map<string, { size: number; type?: string }> } {
  const stored = new Map<string, { size: number; type?: string }>();
  return {
    stored,
    async put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
      stored.set(key, { size: value.byteLength, type: opts?.httpMetadata?.contentType });
      return {} as never;
    },
  } as unknown as R2Bucket & { stored: Map<string, { size: number; type?: string }> };
}

export function makeEnv(db: D1Database, bucket?: R2Bucket): Env {
  return {
    DB: db,
    CACHE: {} as KVNamespace,
    SESSION_SECRET: 'test-secret-not-a-real-one',
    APPLE_BUNDLE_ID: 'com.insightfy.opentv',
    GOOGLE_CLIENT_IDS: '',
    // Absent unless a suite asks for it, so every other suite keeps proving the
    // guard: no binding must mean "off", never a crash.
    COMMENT_IMAGES: bucket,
  };
}

/** A multipart request — the shape `POST /v1/comments/image` takes. */
export async function callForm(
  env: Env,
  path: string,
  form: FormData,
  token?: string,
): Promise<{ status: number; json: any }> {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  // Content-Type is deliberately NOT set: fetch derives it from the FormData,
  // including the multipart boundary, which a hand-written header would omit.
  const res = await worker.fetch(
    new Request(`https://api.opentv.test${path}`, { method: 'POST', headers, body: form }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
  const text = await res.text();
  return { status: res.status, json: text.length === 0 ? null : JSON.parse(text) };
}

/** A real session token for a profile id — signed by the same code the Worker verifies with. */
export async function tokenFor(env: Env, profileId: string): Promise<string> {
  return (await sign(env, profileId, Date.now())).token;
}

export type CallOptions = { token?: string; body?: unknown; headers?: Record<string, string> };

/** One request through the actual Worker: routing, middleware, error envelope and all. */
export async function call(
  env: Env,
  method: string,
  path: string,
  opts: CallOptions = {},
): Promise<{ status: number; json: any }> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`);
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json');

  const res = await worker.fetch(
    new Request(`https://api.opentv.test${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );

  const text = await res.text();
  return { status: res.status, json: text.length === 0 ? null : JSON.parse(text) };
}

// ── row helpers, shared by every SQL-backed suite ────────────────────────────

export function insertProfile(
  raw: Database.Database,
  id: string,
  handle: string,
  deletedAt: string | null = null,
): void {
  raw
    .prepare(
      `INSERT INTO profiles (id, handle, handle_lower, created_at, deleted_at)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(id, handle, handle.toLowerCase(), deletedAt);
}

export function insertBlock(raw: Database.Database, blocker: string, blocked: string): void {
  raw
    .prepare(
      `INSERT INTO blocks (blocker_id, blocked_id, created_at)
       VALUES (?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    .run(blocker, blocked);
}
