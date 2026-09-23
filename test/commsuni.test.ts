import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * The CommsUni consent record.
 *
 * What can be wrong here in a way nobody would notice until somebody's words
 * are on a public board under their name:
 *
 *  1. PENDING STORED AS A DECISION. A dismissed prompt is not a refusal and
 *     not permission. If "never asked" is written as a row, the app can never
 *     ask again honestly, and a later reader of the record cannot tell an
 *     answer from a silence.
 *  2. BACKFILL AUTHORISED BY THE WRONG CONSENT. Agreeing to share new
 *     comments does not authorise publishing years of history unless the
 *     prompt said so. Get this backwards and the first release quietly
 *     publishes everything everybody ever wrote.
 *  3. A WITHDRAWAL THAT ERASES ITS OWN EVIDENCE. Overwriting one row destroys
 *     the proof that consent was ever given — which is the one thing a
 *     consent record exists to hold.
 */
let raw: Database.Database;
let env: Env;
let token: string;

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = makeEnv(fresh.db);
  insertProfile(raw, 'p1', 'mahmood');
  insertProfile(raw, 'p2', 'sara');
  token = await tokenFor(env, 'p1');
});

const post = (body: unknown, tk: string = token) =>
  call(env, 'POST', '/v1/commsuni/consent', { token: tk, body: body as Record<string, unknown> });

const get = (tk: string = token) => call(env, 'GET', '/v1/commsuni/consent', { token: tk });

const rows = () =>
  raw.prepare('SELECT decision, identity, covers_existing FROM commsuni_consent ORDER BY decided_at').all() as {
    decision: string;
    identity: string | null;
    covers_existing: number;
  }[];

describe('recording a decision', () => {
  it('starts as pending with nothing stored at all', async () => {
    // Never asked and asked-then-dismissed must look identical, because the
    // app has to be able to ask again without having recorded an answer
    // nobody gave.
    const res = await get();
    expect(res.json.decision).toBe('pending');
    expect(res.json.backfillAllowed).toBe(false);
    expect(rows()).toHaveLength(0);
  });

  it('refuses to store pending as if it were an answer', async () => {
    expect((await post({ decision: 'pending', promptVersion: 1 })).status).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it('records a share with its identity', async () => {
    const res = await post({ decision: 'share', identity: 'persona', promptVersion: 1, coversExisting: true });
    expect(res.status).toBe(200);
    expect(rows()).toEqual([{ decision: 'share', identity: 'persona', covers_existing: 1 }]);
  });

  it('will not accept sharing without an identity', async () => {
    // A shared comment has to be attributed one way or the other before it is
    // written, so the choice cannot be deferred past this point.
    expect((await post({ decision: 'share', promptVersion: 1 })).status).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it('stores no identity on a refusal', async () => {
    // There is nothing to attribute when nothing is shared, and a value here
    // would imply a choice was offered.
    await post({ decision: 'keep_private', identity: 'profile', promptVersion: 1 });
    expect(rows()[0]!.identity).toBe(null);
  });

  it('demands a prompt version, because a rewrite is a different question', async () => {
    expect((await post({ decision: 'keep_private' })).status).toBe(400);
    expect((await post({ decision: 'keep_private', promptVersion: 0 })).status).toBe(400);
  });

  it('needs a token', async () => {
    expect((await call(env, 'POST', '/v1/commsuni/consent', { body: { decision: 'share' } })).status).toBe(401);
  });
});

describe('what the record authorises', () => {
  it('does NOT allow backfill when the prompt never mentioned existing comments', async () => {
    // The sharpest rule in the guide. Consent to share new comments, given
    // without that disclosure, does not authorise publishing a history.
    await post({ decision: 'share', identity: 'profile', promptVersion: 1, coversExisting: false });
    const res = await get();
    expect(res.json.decision).toBe('share');
    expect(res.json.backfillAllowed).toBe(false);
  });

  it('allows backfill only when sharing AND the copy covered existing comments', async () => {
    await post({ decision: 'share', identity: 'profile', promptVersion: 1, coversExisting: true });
    expect((await get()).json.backfillAllowed).toBe(true);
  });

  it('never allows backfill on a refusal, whatever else is sent', async () => {
    await post({ decision: 'keep_private', promptVersion: 1, coversExisting: true });
    expect((await get()).json.backfillAllowed).toBe(false);
  });
});

describe('changing your mind', () => {
  it('answers with the newest decision', async () => {
    await post({ decision: 'share', identity: 'profile', promptVersion: 1, coversExisting: true });
    await new Promise((r) => setTimeout(r, 2));
    await post({ decision: 'keep_private', promptVersion: 1 });
    const res = await get();
    expect(res.json.decision).toBe('keep_private');
    expect(res.json.backfillAllowed).toBe(false);
  });

  it('keeps every earlier decision, so a withdrawal cannot erase its own evidence', async () => {
    await post({ decision: 'share', identity: 'profile', promptVersion: 1, coversExisting: true });
    await new Promise((r) => setTimeout(r, 2));
    await post({ decision: 'keep_private', promptVersion: 1 });
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.decision).toBe('share');
  });
});

describe('separation between people', () => {
  it('never lets one profile read or affect another-s decision', async () => {
    const other = await tokenFor(env, 'p2');
    await post({ decision: 'share', identity: 'profile', promptVersion: 1, coversExisting: true });
    const res = await get(other);
    expect(res.json.decision).toBe('pending');
    expect(res.json.backfillAllowed).toBe(false);
  });
});
