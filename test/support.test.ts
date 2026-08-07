import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * Support bundles.
 *
 * The two properties that make this feature legitimate rather than a back door
 * are the ones under test: the developer can only ASK (the phone does the
 * sending), and the admin surface is invisible without the secret. If either
 * regresses, this feature becomes covert data collection, so these assertions
 * are the guard on that line — not niceties.
 */

const ADMIN = 'test-admin-secret';

/** A bucket that also lists and gets, which the admin download needs. */
function bucket() {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    async put(key: string, value: ArrayBuffer) {
      store.set(key, new Uint8Array(value));
    },
    async get(key: string) {
      const v = store.get(key);
      return v ? { body: v, async arrayBuffer() { return v.buffer; } } : null;
    },
    async list({ prefix }: { prefix: string }) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  } as unknown as R2Bucket;
}

function env(db: D1Database): Env {
  return { ...makeEnv(db), AVATARS: bucket(), ADMIN_SECRET: ADMIN };
}

let raw: Database.Database;
let e: Env;

beforeEach(() => {
  const f = freshDatabase();
  raw = f.raw;
  e = env(f.db);
  insertProfile(raw, 'p1', 'loverank');
});

describe('admin surface is invisible without the secret', () => {
  it('404s a request with no secret — not 401, which would confirm it exists', async () => {
    const r = await call(e, 'POST', '/v1/admin/support/request', { body: { handle: 'loverank' } });
    expect(r.status).toBe(404);
  });

  it('404s a wrong secret', async () => {
    const r = await call(e, 'POST', '/v1/admin/support/request', {
      body: { handle: 'loverank' },
      headers: { 'X-Admin-Secret': 'wrong' },
    });
    expect(r.status).toBe(404);
  });

  it('is off entirely when ADMIN_SECRET is unset', async () => {
    const noAdmin = { ...e, ADMIN_SECRET: undefined };
    const r = await call(noAdmin, 'POST', '/v1/admin/support/request', {
      body: { handle: 'loverank' },
      headers: { 'X-Admin-Secret': ADMIN },
    });
    expect(r.status).toBe(404);
  });
});

describe('the phone gives; the developer only asks', () => {
  it('a request sets pending, and the user sees it', async () => {
    const req = await call(e, 'POST', '/v1/admin/support/request', {
      body: { handle: 'loverank' },
      headers: { 'X-Admin-Secret': ADMIN },
    });
    expect(req.status).toBe(200);

    const token = await tokenFor(e, 'p1');
    const pending = await call(e, 'GET', '/v1/me/support/pending', { token });
    expect(pending.json.pending).toBe(true);
  });

  it('no request means nothing pending — a signed-in user is never nagged by default', async () => {
    const token = await tokenFor(e, 'p1');
    const pending = await call(e, 'GET', '/v1/me/support/pending', { token });
    expect(pending.json.pending).toBe(false);
  });

  it('requesting an unknown handle 404s rather than arming nothing', async () => {
    const r = await call(e, 'POST', '/v1/admin/support/request', {
      body: { handle: 'ghost' },
      headers: { 'X-Admin-Secret': ADMIN },
    });
    expect(r.status).toBe(404);
  });
});

describe('sending and refusing', () => {
  async function request() {
    await call(e, 'POST', '/v1/admin/support/request', {
      body: { handle: 'loverank' },
      headers: { 'X-Admin-Secret': ADMIN },
    });
  }

  it('an upload stores the bundle and clears the request', async () => {
    await request();
    const token = await tokenFor(e, 'p1');
    const res = await workerUpload(e, token, new Uint8Array([1, 2, 3, 4]));
    expect(res.status).toBe(200);

    // clears — the banner will not come back
    const pending = await call(e, 'GET', '/v1/me/support/pending', { token });
    expect(pending.json.pending).toBe(false);

    // the developer can pull it back — a zip, byte-for-byte
    const dl = await adminDownload(e, 'loverank');
    expect(dl.status).toBe(200);
    expect(dl.contentType).toBe('application/zip');
    expect([...dl.bytes]).toEqual([1, 2, 3, 4]);
  });

  it('decline clears the request and stores nothing', async () => {
    await request();
    const token = await tokenFor(e, 'p1');
    const dec = await call(e, 'POST', '/v1/me/support/decline', { token });
    expect(dec.status).toBe(200);

    const pending = await call(e, 'GET', '/v1/me/support/pending', { token });
    expect(pending.json.pending).toBe(false);

    const dl = await adminDownload(e, 'loverank');
    expect(dl.status).toBe(404); // nothing was ever sent
  });

  it('an empty bundle is rejected', async () => {
    await request();
    const token = await tokenFor(e, 'p1');
    const res = await workerUpload(e, token, new Uint8Array([]));
    expect(res.status).toBe(400);
  });
});

/** Admin download returns a zip body, not JSON — read it raw. */
async function adminDownload(e: Env, handle: string) {
  const { default: worker } = await import('@/index');
  const res = await worker.fetch(
    new Request(`https://api.opentv.test/v1/admin/support/bundle/${handle}`, {
      headers: { 'X-Admin-Secret': ADMIN },
    }),
    e,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
  return {
    status: res.status,
    contentType: res.headers.get('Content-Type'),
    bytes: new Uint8Array(await res.arrayBuffer()),
  };
}

/** Raw-body POST — the bundle upload is not JSON. */
async function workerUpload(e: Env, token: string, bytes: Uint8Array) {
  const { default: worker } = await import('@/index');
  const res = await worker.fetch(
    new Request('https://api.opentv.test/v1/me/support/bundle', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip' },
      body: bytes,
    }),
    e,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
  const text = await res.text();
  return { status: res.status, json: text.length === 0 ? null : JSON.parse(text) };
}
