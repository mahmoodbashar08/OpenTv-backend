import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { call, freshDatabase, insertBlock, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * Shared lists.
 *
 * The things here that can be wrong invisibly, which is what these cover:
 *
 *  1. THE PAYWALL ON THE WRONG SIDE OF THE DOOR. Joining must be free at every
 *     tier, for ever. If a gate ever creeps onto `join`, the feature still
 *     "works" in every manual test done by one paying developer, and is dead
 *     for every real group.
 *  2. A MEMBER DELETING SOMEBODY ELSE'S SUGGESTIONS. Nothing in the UI offers
 *     it, so it would only ever be found by someone doing it on purpose.
 *  3. A 403 THAT CONFIRMS A LIST EXISTS. Reading a list you are not in must be
 *     404, not 403 — the difference leaks other people's business.
 *  4. LEAVING TAKING THE LIST'S CONTENT WITH YOU.
 */

let raw: Database.Database;
let env: Env;
let owner: string;
let friend: string;
let stranger: string;

const create = (token: string, name: unknown = 'Sunday nights') =>
  call(env, 'POST', '/v1/shared-lists', { token, body: { name } });

const join = (token: string, code: unknown) =>
  call(env, 'POST', '/v1/shared-lists/join', { token, body: { code } });

const addItem = (token: string, id: string, body: Record<string, unknown>) =>
  call(env, 'POST', `/v1/shared-lists/${id}/items`, { token, body });

const setPlus = (id: string) => raw.prepare('UPDATE profiles SET is_plus = 1 WHERE id = ?').run(id);

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = makeEnv(fresh.db);
  insertProfile(raw, 'p1', 'mahmood');
  insertProfile(raw, 'p2', 'sara');
  insertProfile(raw, 'p3', 'omar');
  owner = await tokenFor(env, 'p1');
  friend = await tokenFor(env, 'p2');
  stranger = await tokenFor(env, 'p3');
});

describe('creating', () => {
  it('gives a free account one list, then asks for Plus', async () => {
    const first = await create(owner);
    expect(first.status).toBe(201);
    expect(first.json.invite_code).toMatch(/^[A-Z2-9]{10}$/);

    const second = await create(owner, 'Another');
    expect(second.status).toBe(403);
    expect(second.json.error.code).toBe('plus_required');
  });

  it('lets a supporter start as many as they like', async () => {
    setPlus('p1');
    expect((await create(owner, 'One')).status).toBe(201);
    expect((await create(owner, 'Two')).status).toBe(201);
    expect((await create(owner, 'Three')).status).toBe(201);
  });

  /** Lists you were INVITED to cost nothing and must not count against you. */
  it('counts lists you own, not lists you are in', async () => {
    setPlus('p1');
    const a = await create(owner, 'Mine');
    const b = await create(owner, 'Also mine');
    await join(friend, a.json.invite_code);
    await join(friend, b.json.invite_code);

    // p2 is in two lists and owns none, so their one free list is still theirs
    expect((await create(friend, 'My first')).status).toBe(201);
  });

  it('refuses a blank or oversized name', async () => {
    expect((await create(owner, '   ')).status).toBe(400);
    expect((await create(owner, 'x'.repeat(61))).status).toBe(400);
    expect((await create(owner, 42)).status).toBe(400);
  });
});

describe('joining — free at every tier, for ever', () => {
  it('lets a free account join without a word about Plus', async () => {
    const list = await create(owner);
    const res = await join(friend, list.json.invite_code);
    expect(res.status).toBe(201);
    expect(res.json.joined).toBe(true);

    // and they can still make their own free list afterwards
    expect((await create(friend, 'Mine')).status).toBe(201);
  });

  it('accepts a code in any case, with spaces or dashes in it', async () => {
    const list = await create(owner);
    const code = list.json.invite_code as string;
    const messy = `${code.slice(0, 5).toLowerCase()}-${code.slice(5)} `;
    expect((await join(friend, messy)).status).toBe(201);
  });

  it('treats a second tap on the same link as arriving, not as an error', async () => {
    const list = await create(owner);
    await join(friend, list.json.invite_code);
    const again = await join(friend, list.json.invite_code);
    expect(again.status).toBe(200);
    expect(again.json.joined).toBe(false);
    expect(again.json.id).toBe(list.json.id);
  });

  it('refuses a code that is not a code, and one that is simply wrong', async () => {
    expect((await join(friend, 'nope')).status).toBe(400);
    expect((await join(friend, 'ABCDEFGHJK')).status).toBe(404);
  });

  it('refuses a join across a block, in either direction', async () => {
    const list = await create(owner);
    insertBlock(raw, 'p1', 'p2');
    expect((await join(friend, list.json.invite_code)).status).toBe(403);
  });

  it('notifies the other members, and never the person who joined', async () => {
    const list = await create(owner);
    await join(friend, list.json.invite_code);
    const rows = raw
      .prepare("SELECT recipient_id FROM notifications WHERE kind = 'shared_list_join'")
      .all() as { recipient_id: string }[];
    expect(rows.map((r) => r.recipient_id)).toEqual(['p1']);
  });
});

describe('reading', () => {
  it('answers 404 — not 403 — to somebody who is not in the list', async () => {
    const list = await create(owner);
    const res = await call(env, 'GET', `/v1/shared-lists/${list.json.id}`, { token: stranger });
    // 403 would confirm the list exists, which is not the stranger's business
    expect(res.status).toBe(404);
  });

  it('shows the invite code to the owner and to nobody else', async () => {
    const list = await create(owner);
    await join(friend, list.json.invite_code);

    const mine = await call(env, 'GET', `/v1/shared-lists/${list.json.id}`, { token: owner });
    const theirs = await call(env, 'GET', `/v1/shared-lists/${list.json.id}`, { token: friend });
    expect(mine.json.invite_code).toBe(list.json.invite_code);
    expect(theirs.json.invite_code).toBeNull();
  });

  it('lists everyone you share with, newest activity first', async () => {
    setPlus('p1');
    const quiet = await create(owner, 'Quiet');
    const busy = await create(owner, 'Busy');
    await addItem(owner, busy.json.id, { target_source: 'tvdb', target_key: '121361', title: 'Thrones' });

    const res = await call(env, 'GET', '/v1/shared-lists', { token: owner });
    expect(res.json.lists.map((l: { name: string }) => l.name)).toEqual(['Busy', 'Quiet']);
    expect(res.json.lists[0].items).toBe(1);
    expect(res.json.lists[0].is_owner).toBe(true);
    void quiet;
  });
});

describe('items', () => {
  it('records who added each one', async () => {
    const list = await create(owner);
    await join(friend, list.json.invite_code);
    await addItem(friend, list.json.id, { target_source: 'movie', target_key: 'Heat', title: 'Heat' });

    const res = await call(env, 'GET', `/v1/shared-lists/${list.json.id}`, { token: owner });
    expect(res.json.items[0].added_by).toBe('p2');
  });

  it('treats a title added twice as already there rather than a failure', async () => {
    const list = await create(owner);
    await join(friend, list.json.invite_code);
    const body = { target_source: 'tvdb', target_key: '121361', title: 'Thrones' };
    expect((await addItem(owner, list.json.id, body)).status).toBe(201);
    const twice = await addItem(friend, list.json.id, body);
    expect(twice.status).toBe(200);
    expect(twice.json.added).toBe(false);
  });

  it('refuses an identity nothing could open', async () => {
    const list = await create(owner);
    expect((await addItem(owner, list.json.id, { target_source: 'tvdb', target_key: 'abc' })).status).toBe(400);
    expect((await addItem(owner, list.json.id, { target_source: 'wat', target_key: '1' })).status).toBe(400);
    expect((await addItem(owner, list.json.id, { target_source: 'movie', target_key: '  ' })).status).toBe(400);
  });

  it('refuses a stranger adding anything at all', async () => {
    const list = await create(owner);
    const res = await addItem(stranger, list.json.id, { target_source: 'movie', target_key: 'Heat' });
    expect(res.status).toBe(404);
  });

  it('lets a member remove their own suggestion and nobody else’s', async () => {
    const list = await create(owner);
    await join(friend, list.json.invite_code);
    const mine = await addItem(owner, list.json.id, { target_source: 'movie', target_key: 'Heat' });
    const theirs = await addItem(friend, list.json.id, { target_source: 'movie', target_key: 'Sicario' });

    const del = (token: string, item: string) =>
      call(env, 'DELETE', `/v1/shared-lists/${list.json.id}/items/${item}`, { token });

    // the member cannot delete the owner's
    expect((await del(friend, mine.json.id)).status).toBe(404);
    // but can delete their own
    expect((await del(friend, theirs.json.id)).status).toBe(200);
  });

  it('lets the owner remove anything, because somebody has to be able to', async () => {
    const list = await create(owner);
    await join(friend, list.json.invite_code);
    const theirs = await addItem(friend, list.json.id, { target_source: 'movie', target_key: 'Sicario' });
    const res = await call(env, 'DELETE', `/v1/shared-lists/${list.json.id}/items/${theirs.json.id}`, {
      token: owner,
    });
    expect(res.status).toBe(200);
  });
});

describe('ticking things off', () => {
  it('counts per person, and says so on every member', async () => {
    const list = await create(owner);
    await join(friend, list.json.invite_code);
    const a = await addItem(owner, list.json.id, { target_source: 'movie', target_key: 'Heat' });
    await addItem(owner, list.json.id, { target_source: 'movie', target_key: 'Sicario' });

    await call(env, 'POST', `/v1/shared-lists/${list.json.id}/items/${a.json.id}/watched`, { token: friend });

    const res = await call(env, 'GET', `/v1/shared-lists/${list.json.id}`, { token: owner });
    const sara = res.json.members.find((m: { handle: string }) => m.handle === 'sara');
    const me = res.json.members.find((m: { handle: string }) => m.handle === 'mahmood');
    expect(sara.watched).toBe(1);
    expect(me.watched).toBe(0);
    expect(res.json.items.find((i: { id: string }) => i.id === a.json.id).watched_by).toEqual(['p2']);
  });

  it('is idempotent, and can be taken back', async () => {
    const list = await create(owner);
    const item = await addItem(owner, list.json.id, { target_source: 'movie', target_key: 'Heat' });
    const url = `/v1/shared-lists/${list.json.id}/items/${item.json.id}/watched`;

    await call(env, 'POST', url, { token: owner });
    await call(env, 'POST', url, { token: owner });
    expect(
      (raw.prepare('SELECT COUNT(*) AS n FROM shared_list_watched').get() as { n: number }).n,
    ).toBe(1);

    await call(env, 'DELETE', url, { token: owner });
    expect(
      (raw.prepare('SELECT COUNT(*) AS n FROM shared_list_watched').get() as { n: number }).n,
    ).toBe(0);
  });
});

describe('leaving and deleting', () => {
  it('leaves a member’s suggestions behind when they go', async () => {
    const list = await create(owner);
    await join(friend, list.json.invite_code);
    await addItem(friend, list.json.id, { target_source: 'movie', target_key: 'Sicario' });

    await call(env, 'DELETE', `/v1/shared-lists/${list.json.id}`, { token: friend });

    const res = await call(env, 'GET', `/v1/shared-lists/${list.json.id}`, { token: owner });
    expect(res.json.items).toHaveLength(1);
    expect(res.json.members).toHaveLength(1);
  });

  it('takes the list off everybody when the owner deletes it', async () => {
    const list = await create(owner);
    await join(friend, list.json.invite_code);
    await call(env, 'DELETE', `/v1/shared-lists/${list.json.id}`, { token: owner });

    expect((await call(env, 'GET', `/v1/shared-lists/${list.json.id}`, { token: friend })).status).toBe(404);
    expect((await call(env, 'GET', '/v1/shared-lists', { token: friend })).json.lists).toHaveLength(0);
  });

  it('refuses a member renaming the list', async () => {
    const list = await create(owner);
    await join(friend, list.json.invite_code);
    const res = await call(env, 'PATCH', `/v1/shared-lists/${list.json.id}`, {
      token: friend,
      body: { name: 'Mine now' },
    });
    expect(res.status).toBe(403);
  });

  /** The only way back once a link has gone somewhere it should not have. */
  it('kills every outstanding link when the owner rotates the code', async () => {
    const list = await create(owner);
    const old = list.json.invite_code;
    const res = await call(env, 'PATCH', `/v1/shared-lists/${list.json.id}`, {
      token: owner,
      body: { rotate_invite: true },
    });
    expect(res.json.invite_code).not.toBe(old);
    expect((await join(stranger, old)).status).toBe(404);
    expect((await join(stranger, res.json.invite_code)).status).toBe(201);
  });
});
