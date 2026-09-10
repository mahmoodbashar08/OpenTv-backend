import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { MAX_BACKUP_BYTES } from '@/routes/backup';
import { call, callBytes, fakeBucket, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * Cloud backup — the third destination, after iCloud and Drive.
 *
 * What can be wrong here in a way nobody would notice:
 *
 *  1. PLUS GATING THE WRONG DIRECTION. Upload needs a subscription; download
 *     and delete must not. A backup that locks when a card expires is a
 *     hostage, and the failure is invisible until somebody's card expires.
 *  2. ONE KEY PER PROFILE. If the key carried anything but the session's own
 *     profile id, one user could read another's library — the worst bug this
 *     server could have.
 *  3. NO BINDING MEANS OFF. A deployment without the bucket must answer
 *     "no backup", not 500.
 */

let raw: Database.Database;
let env: Env;
let bucket: ReturnType<typeof fakeBucket>;
let token: string;

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

const makePlus = (id: string) =>
  raw.prepare('UPDATE profiles SET is_plus = 1 WHERE id = ?').run(id);

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  bucket = fakeBucket();
  env = makeEnv(fresh.db, undefined, bucket);
  insertProfile(raw, 'p1', 'mahmood');
  insertProfile(raw, 'p2', 'sara');
  token = await tokenFor(env, 'p1');
});

describe('uploading', () => {
  it('refuses without Plus, and says so in a code the app can answer with the paywall', async () => {
    const res = await callBytes(env, 'PUT', '/v1/backup', ZIP, { token });
    expect(res.status).toBe(402);
    expect(res.json.error.code).toBe('plus_required');
    expect(bucket.stored.size).toBe(0);
  });

  it('stores one object, keyed to the profile, once Plus is on', async () => {
    makePlus('p1');
    const res = await callBytes(env, 'PUT', '/v1/backup', ZIP, { token });
    expect(res.status).toBe(200);
    expect(res.json.size).toBe(ZIP.length);
    expect([...bucket.stored.keys()]).toEqual(['backups/p1.zip']);
  });

  it('overwrites in place, so pressing backup twice cannot fill a bucket', async () => {
    makePlus('p1');
    await callBytes(env, 'PUT', '/v1/backup', ZIP, { token });
    await callBytes(env, 'PUT', '/v1/backup', new Uint8Array(20), { token });
    expect(bucket.stored.size).toBe(1);
    expect(bucket.stored.get('backups/p1.zip')?.size).toBe(20);
  });

  it('refuses an empty body and one over the cap', async () => {
    makePlus('p1');
    expect((await callBytes(env, 'PUT', '/v1/backup', new Uint8Array(0), { token })).status).toBe(400);
    const huge = new Uint8Array(MAX_BACKUP_BYTES + 1);
    expect((await callBytes(env, 'PUT', '/v1/backup', huge, { token })).status).toBe(413);
    expect(bucket.stored.size).toBe(0);
  });

  it('needs a token at all', async () => {
    expect((await callBytes(env, 'PUT', '/v1/backup', ZIP)).status).toBe(401);
  });
});

describe('the label beside the ZIP', () => {
  it('round-trips the counts the welcome screen greets somebody with', async () => {
    makePlus('p1');
    // Encoded exactly as the phone does it: UTF-8 first, then base64. A handle
    // outside Latin-1 is the case that catches a server decoding it wrong.
    const payload = JSON.stringify({ username: 'محمود', shows: 12, episodes: 340, movies: 88 });
    const utf8 = new TextEncoder().encode(payload);
    const info = btoa(String.fromCharCode(...utf8));
    await callBytes(env, 'PUT', '/v1/backup', ZIP, {
      token,
      headers: { 'X-OpenTV-Backup-Info': info },
    });

    const res = await call(env, 'GET', '/v1/backup/info', { token });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      exists: true,
      size: ZIP.length,
      username: 'محمود',
      shows: 12,
      episodes: 340,
      movies: 88,
    });
  });

  it('a mangled header does not fail an upload that is otherwise fine', async () => {
    makePlus('p1');
    const res = await callBytes(env, 'PUT', '/v1/backup', ZIP, {
      token,
      headers: { 'X-OpenTV-Backup-Info': 'not base64 at all !!' },
    });
    expect(res.status).toBe(200);
    expect((await call(env, 'GET', '/v1/backup/info', { token })).json.exists).toBe(true);
  });

  it('says so plainly when there is nothing up there', async () => {
    const res = await call(env, 'GET', '/v1/backup/info', { token });
    expect(res.json).toEqual({ exists: false });
  });
});

describe('getting it back', () => {
  it('returns the exact bytes that went up', async () => {
    makePlus('p1');
    await callBytes(env, 'PUT', '/v1/backup', ZIP, { token });
    const res = await callBytes(env, 'GET', '/v1/backup', undefined, { token });
    expect(res.status).toBe(200);
    expect([...res.bytes]).toEqual([...ZIP]);
  });

  /** The whole point of the gate being one-directional. */
  it('still returns it after Plus lapses', async () => {
    makePlus('p1');
    await callBytes(env, 'PUT', '/v1/backup', ZIP, { token });
    raw.prepare('UPDATE profiles SET is_plus = 0, plus_until = NULL WHERE id = ?').run('p1');

    const res = await callBytes(env, 'GET', '/v1/backup', undefined, { token });
    expect(res.status).toBe(200);
    expect([...res.bytes]).toEqual([...ZIP]);
  });

  it('404s when this account never uploaded one', async () => {
    expect((await callBytes(env, 'GET', '/v1/backup', undefined, { token })).status).toBe(404);
  });

  /** The worst bug this server could have. */
  it('never hands one profile another profile’s library', async () => {
    makePlus('p1');
    await callBytes(env, 'PUT', '/v1/backup', ZIP, { token });

    const other = await tokenFor(env, 'p2');
    const res = await callBytes(env, 'GET', '/v1/backup', undefined, { token: other });
    expect(res.status).toBe(404);
    expect((await call(env, 'GET', '/v1/backup/info', { token: other })).json).toEqual({ exists: false });
  });
});

describe('deleting it', () => {
  it('removes it without needing Plus, and is idempotent', async () => {
    makePlus('p1');
    await callBytes(env, 'PUT', '/v1/backup', ZIP, { token });
    raw.prepare('UPDATE profiles SET is_plus = 0 WHERE id = ?').run('p1');

    expect((await call(env, 'DELETE', '/v1/backup', { token })).status).toBe(200);
    expect(bucket.stored.size).toBe(0);
    // again, on a bucket that no longer has it
    expect((await call(env, 'DELETE', '/v1/backup', { token })).status).toBe(200);
  });
});

describe('a deployment without the bucket', () => {
  beforeEach(() => {
    env = { ...env, BACKUPS: undefined };
  });

  it('is off rather than broken', async () => {
    makePlus('p1');
    expect((await callBytes(env, 'PUT', '/v1/backup', ZIP, { token })).status).toBe(503);
    expect((await call(env, 'GET', '/v1/backup/info', { token })).json).toEqual({ exists: false });
    expect((await callBytes(env, 'GET', '/v1/backup', undefined, { token })).status).toBe(503);
    expect((await call(env, 'DELETE', '/v1/backup', { token })).status).toBe(200);
  });
});
