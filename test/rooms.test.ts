import { describe, expect, it } from 'vitest';
import { call, freshDatabase, insertBlock, insertProfile, makeEnv, tokenFor } from './harness';
import {
  parseRoomKey,
  presenceFor,
  RECENT_MAX,
  roomWindow,
  step,
  type DoorPass,
  type Effect,
  type RoomState,
  type Seat,
} from '@/rooms';

/**
 * The live room (D20): the Durable Object's logic as a pure reducer, and the
 * Worker's door end to end. The DO's own plumbing — sockets, hibernation, the
 * alarm — is covered by the `wrangler dev` smoke recipe in the room's API.md,
 * because Node has no Durable Object runtime and D20 chose not to add one.
 */

const shell = (id: string) => ({ id, handle: id, display_name: null, avatar_key: null });
const seat = (sid: string, id: string, joined = true): Seat => ({ sid, who: shell(id), joined, lastAt: 0 });
const room = (seats: Seat[], blocks: RoomState['blocks'] = {}): RoomState => ({ seats, recent: [], blocks });
const msg = (sid: string, body: unknown, now = 10_000) =>
  ({ type: 'message', sid, data: JSON.stringify(body), now }) as const;
const sentTo = (effects: Effect[], sid: string) =>
  effects.filter((e) => e.kind === 'send' && e.to === sid).map((e) => (e.kind === 'send' ? e.msg : null));

describe('the room key and its window', () => {
  it('reads the key every phone derives from its metadata', () => {
    expect(parseRoomKey('tvdb:81189:5:16:2013-09-29')).toEqual({ tvdbId: 81189, season: 5, episode: 16, air: '2013-09-29' });
    expect(parseRoomKey('tvdb:81189:0:1:2013-09-29')?.season).toBe(0); // specials get rooms too
  });

  it('refuses anything else, including a day that never existed', () => {
    for (const k of ['tvdb:81189:5:16', 'tmdb:1:1:1:2026-01-01', 'tvdb:0:1:1:2026-01-01', 'tvdb:1:1:1:2026-02-31', 'tvdb:1:1:1:2026-1-01']) {
      expect(parseRoomKey(k)).toBeNull();
    }
  });

  it('is open from midnight UTC on the air date for 48 hours', () => {
    const at = (iso: string) => roomWindow('2026-10-14', Date.parse(iso)).open;
    expect(at('2026-10-13T23:59:59Z')).toBe(false);
    expect(at('2026-10-14T00:00:00Z')).toBe(true);
    expect(at('2026-10-15T23:59:59Z')).toBe(true);
    expect(at('2026-10-16T00:00:00Z')).toBe(false);
    expect(roomWindow('2026-10-14', 0).closes_at).toBe('2026-10-16T00:00:00.000Z');
  });
});

describe('joining', () => {
  it('sends nothing, and counts nobody, until the phone says join', () => {
    const s = room([seat('a', 'p_a', false)]);
    expect(presenceFor(s, null).watching).toBe(0);
    const out = step(s, msg('a', { t: 'react', emotion: 'shocked' }));
    expect(out.effects).toEqual([{ kind: 'close', to: 'a', code: 4001, reason: 'join_first' }]);
  });

  it('closes a join that does not claim the episode was watched', () => {
    const out = step(room([seat('a', 'p_a', false)]), msg('a', { t: 'join', watched: false }));
    expect(out.effects).toEqual([{ kind: 'close', to: 'a', code: 4003, reason: 'not_watched' }]);
  });

  it('greets the joiner with presence and the recent reactions, and tells everyone else', () => {
    const before = { ...room([seat('a', 'p_a'), seat('b', 'p_b', false)]), recent: [{ who: shell('p_a'), emotion: 'sad' as const, at: 'x' }] };
    const out = step(before, msg('b', { t: 'join', watched: true }));
    expect(sentTo(out.effects, 'b')).toEqual([
      { t: 'hello', watching: 2, faces: [shell('p_a'), shell('p_b')], recent: before.recent },
    ]);
    expect(sentTo(out.effects, 'a')).toEqual([{ t: 'presence', watching: 2, faces: [shell('p_a'), shell('p_b')] }]);
    expect(before.seats[1]!.joined).toBe(false); // the input is never mutated
  });

  it('counts two phones on one account once', () => {
    expect(presenceFor(room([seat('a1', 'p_a'), seat('a2', 'p_a'), seat('b', 'p_b')]), null).watching).toBe(2);
  });
});

describe('reacting', () => {
  it('reaches every joined seat, the sender included, and nobody who has not joined', () => {
    const s = room([seat('a', 'p_a'), seat('b', 'p_b'), seat('c', 'p_c', false)]);
    const out = step(s, msg('a', { t: 'react', emotion: 'thrilled' }));
    expect(out.effects.map((e) => e.to).sort()).toEqual(['a', 'b']);
    expect(out.state.recent).toHaveLength(1);
  });

  it('refuses a feeling that is not one of the twelve', () => {
    const out = step(room([seat('a', 'p_a')]), msg('a', { t: 'react', emotion: 'angry' }));
    expect(sentTo(out.effects, 'a')).toEqual([{ t: 'error', code: 'invalid_body' }]);
    expect(out.state.recent).toEqual([]);
  });

  it('allows one a second per socket', () => {
    let s = room([seat('a', 'p_a')]);
    s = step(s, msg('a', { t: 'react', emotion: 'sad' }, 10_000)).state;
    const fast = step(s, msg('a', { t: 'react', emotion: 'sad' }, 10_500));
    expect(sentTo(fast.effects, 'a')).toEqual([{ t: 'error', code: 'rate_limited' }]);
    expect(step(s, msg('a', { t: 'react', emotion: 'sad' }, 11_000)).state.recent).toHaveLength(2);
  });

  it('keeps only the last 50', () => {
    let s = room([seat('a', 'p_a')]);
    for (let i = 0; i < RECENT_MAX + 5; i++) s = step(s, msg('a', { t: 'react', emotion: 'sad' }, 10_000 + i * 1000)).state;
    expect(s.recent).toHaveLength(RECENT_MAX);
    expect(s.recent[0]!.at).toBe(new Date(10_000 + 5 * 1000).toISOString());
  });

  it('answers a ping and ignores a message type it does not know', () => {
    expect(sentTo(step(room([seat('a', 'p_a')]), msg('a', { t: 'ping' })).effects, 'a')).toEqual([{ t: 'pong' }]);
    expect(step(room([seat('a', 'p_a')]), msg('a', { t: 'future' })).effects).toEqual([]);
  });
});

describe('blocks, applied per recipient', () => {
  // Only p_a's list knows: p_a blocked p_b after p_b sat down.
  const blocks = { p_a: ['p_b'] };

  it('hides each from the other, both directions, whichever list knows', () => {
    const s = room([seat('a', 'p_a'), seat('b', 'p_b'), seat('c', 'p_c')], blocks);
    expect(step(s, msg('b', { t: 'react', emotion: 'sad' })).effects.map((e) => e.to).sort()).toEqual(['b', 'c']);
    expect(step(s, msg('a', { t: 'react', emotion: 'sad' })).effects.map((e) => e.to).sort()).toEqual(['a', 'c']);
    expect(presenceFor(s, 'p_b').faces.map((f) => f.id)).toEqual(['p_b', 'p_c']);
    expect(presenceFor(s, 'p_c').watching).toBe(3);
  });

  it('keeps a blocked person out of the recent reactions a late joiner is shown', () => {
    const s = { ...room([seat('b', 'p_b'), seat('a', 'p_a', false)], blocks), recent: [{ who: shell('p_b'), emotion: 'sad' as const, at: 'x' }] };
    const hello = sentTo(step(s, msg('a', { t: 'join', watched: true })).effects, 'a')[0];
    expect(hello).toMatchObject({ t: 'hello', recent: [], watching: 1 });
  });
});

describe('leaving and the end of the night', () => {
  it('tells the others when a joined seat leaves, and nobody when a stranger does', () => {
    const s = room([seat('a', 'p_a'), seat('b', 'p_b'), seat('c', 'p_c', false)]);
    expect(sentTo(step(s, { type: 'leave', sid: 'b' }).effects, 'a')).toEqual([{ t: 'presence', watching: 1, faces: [shell('p_a')] }]);
    expect(step(s, { type: 'leave', sid: 'c' }).effects).toEqual([]);
  });

  it('closes every socket with "closed" and keeps nothing', () => {
    const s = { ...room([seat('a', 'p_a'), seat('b', 'p_b', false)], { p_a: ['p_x'] }), recent: [{ who: shell('p_a'), emotion: 'sad' as const, at: 'x' }] };
    const out = step(s, { type: 'close' });
    expect(out.effects).toEqual([
      { kind: 'close', to: 'a', code: 1000, reason: 'closed' },
      { kind: 'close', to: 'b', code: 1000, reason: 'closed' },
    ]);
    expect(out.state).toEqual({ seats: [], recent: [], blocks: {} });
  });
});

// ── the Worker's door ────────────────────────────────────────────────────────

/** A namespace that records what the door forwarded. Node cannot answer 101,
 *  so the fake answers 200 and the test reads the pass it was handed. */
function fakeRooms() {
  const seen: { name: string; path: string; headers: Headers }[] = [];
  const ns = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: async (url: string, init?: RequestInit) => {
        seen.push({ name, path: new URL(url).pathname, headers: new Headers(init?.headers) });
        return Response.json({ watching: 3 });
      },
    }),
  };
  return { ns: ns as unknown as DurableObjectNamespace, seen };
}

const today = new Date().toISOString().slice(0, 10);
const OPEN = `tvdb:81189:5:16:${today}`;
const CLOSED = 'tvdb:81189:5:16:2013-09-29';
const WS = { Upgrade: 'websocket' };

async function world() {
  const { raw, db } = freshDatabase();
  insertProfile(raw, 'p_me', 'me');
  insertProfile(raw, 'p_x', 'x');
  insertProfile(raw, 'p_y', 'y');
  const rooms = fakeRooms();
  const env = { ...makeEnv(db), ROOMS: rooms.ns };
  return { raw, env, rooms, token: await tokenFor(env, 'p_me') };
}

describe('the door', () => {
  it('answers not_configured where there is no Durable Object runtime (self-hosted)', async () => {
    const { env, token } = await world();
    const bare = { ...env, ROOMS: undefined };
    expect((await call(bare, 'GET', `/v1/rooms/${OPEN}`, { token })).json.error.code).toBe('not_configured');
    expect((await call(bare, 'GET', `/v1/rooms/${OPEN}/ws`, { token, headers: WS })).json.error.code).toBe('not_configured');
  });

  it('gives any member the count inside the window, and does not wake the room outside it', async () => {
    const { env, rooms, token } = await world();
    const open = await call(env, 'GET', `/v1/rooms/${OPEN}`, { token });
    expect(open.json).toMatchObject({ open: true, watching: 3 });
    const closed = await call(env, 'GET', `/v1/rooms/${CLOSED}`, { token });
    expect(closed.json).toMatchObject({ open: false, watching: 0, closes_at: '2013-10-01T00:00:00.000Z' });
    expect(rooms.seen.map((s) => s.path)).toEqual(['/count']);
  });

  it('refuses a bad key, a closed room, and a request that is not an upgrade — before any read', async () => {
    const { env, token } = await world();
    expect((await call(env, 'GET', '/v1/rooms/nonsense/ws', { token, headers: WS })).status).toBe(400);
    const closed = await call(env, 'GET', `/v1/rooms/${CLOSED}/ws`, { token, headers: WS });
    expect([closed.status, closed.json.error.code]).toEqual([410, 'room_closed']);
    const plain = await call(env, 'GET', `/v1/rooms/${OPEN}/ws`, { token });
    expect([plain.status, plain.json.error.code]).toEqual([426, 'upgrade_required']);
  });

  it('needs a member who joined the community, and then Plus', async () => {
    const { raw, env, token } = await world();
    raw.prepare('UPDATE profiles SET joined_at = NULL WHERE id = ?').run('p_me');
    expect((await call(env, 'GET', `/v1/rooms/${OPEN}/ws`, { token, headers: WS })).json.error.code).toBe('forbidden');
    raw.prepare("UPDATE profiles SET joined_at = '2026-01-01' WHERE id = ?").run('p_me');
    const free = await call(env, 'GET', `/v1/rooms/${OPEN}/ws`, { token, headers: WS });
    expect([free.status, free.json.error.code]).toEqual([403, 'plus_required']);
  });

  it('hands the room a pass with the shell and blocks both ways, and drops any pass the caller sent', async () => {
    const { raw, env, rooms, token } = await world();
    raw.prepare("UPDATE profiles SET is_plus = 1, display_name = 'Mé ✓' WHERE id = ?").run('p_me');
    insertBlock(raw, 'p_me', 'p_x');
    insertBlock(raw, 'p_y', 'p_me');
    const forged = encodeURIComponent(JSON.stringify({ who: { id: 'p_y' } }));
    const res = await call(env, 'GET', `/v1/rooms/${OPEN}/ws`, { token, headers: { ...WS, 'X-Room-Pass': forged } });
    expect(res.status).toBe(200);
    const fwd = rooms.seen[0]!;
    expect(fwd.name).toBe(OPEN);
    expect(fwd.path).toBe('/ws');
    const pass = JSON.parse(decodeURIComponent(fwd.headers.get('X-Room-Pass')!)) as DoorPass;
    expect(pass.who).toEqual({ id: 'p_me', handle: 'me', display_name: 'Mé ✓', avatar_key: null });
    expect(pass.blocked.sort()).toEqual(['p_x', 'p_y']);
    expect(pass.closes_at).toBe(roomWindow(today, Date.now()).closes_at);
  });
});
