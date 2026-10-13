/**
 * THE LIVE ROOM — one Durable Object per episode-night (2.0.0, feature 3).
 *
 * On the night an episode airs, the people who have just watched it sit in one
 * room and tap the twelve feelings at each other. That is the whole feature: no
 * text, no history, nothing kept. DESIGN-community.md §3 is the spec; D13–D20
 * settle its choices.
 *
 * WHAT IT HOLDS, and for how long:
 *   - presence: the WebSockets themselves, each carrying its member's public
 *     shell as a hibernation-safe attachment. Gone when the socket goes.
 *   - `recent`: the last 50 reactions, so somebody who walks in late sees the
 *     room was alive (D16). In this object's own storage, never D1.
 *   - `blocks:<profileId>`: the block list the Worker read at the door. In
 *     storage rather than in the attachment because an attachment is capped at
 *     2 KB, and a person with a long block list must not be refused a seat — or
 *     worse, have the list silently cut.
 *   - `closes_at`: the end of the 48 h window (D17). The alarm fires there,
 *     closes every socket with `closed` and `deleteAll()`s. After that the
 *     object holds nothing and costs nothing.
 *
 * WHAT IT NEVER DOES: touch D1. Who was in a room is not written anywhere
 * durable, and a reaction here is not a feeling on the episode (D18) — one tap,
 * one meaning, and the meaning is "right now".
 *
 * WHAT IT COSTS. D1: ~2 statements at the door, in the Worker (`routes/rooms.ts`)
 * — the caller's profile row (shell + joined + Plus) and their blocks both ways —
 * and nothing after that, however long the night. Durable Objects: one request
 * per join and per count, and incoming WebSocket messages billed 20:1 under the
 * hibernation API. A busy premiere (200 people, 50 reactions each) is ~10k
 * messages ≈ 500 DO requests and zero D1 rows. Between reactions a hibernated
 * object is billed nothing.
 *
 * WHY A PLAIN CLASS rather than `extends DurableObject` from `cloudflare:workers`:
 * `index.ts` must export this class for wrangler, and `selfhost/server.ts` and
 * the vitest suite import `index.ts` under Node, where `cloudflare:workers` does
 * not resolve. A fetch-only object needs nothing the base class adds, and every
 * Workers-only global (`WebSocketPair`, `WebSocketRequestResponsePair`) is
 * touched only inside methods that never run outside workerd.
 *
 * THE LOGIC IS A PURE REDUCER (`step`, below) so vitest can drive it without a
 * runtime (D20). The class is plumbing: it rebuilds the state from its sockets
 * and storage, calls `step`, and carries out the effects.
 */
import { isEmotion, type Emotion } from '@/pure';

// ── the key and the window ───────────────────────────────────────────────────

/**
 * `tvdb:<id>:<season>:<episode>:<YYYY-MM-DD>`, the air date as TheTVDB writes
 * it in the phone's metadata. Every phone derives the same string from what it
 * already has, so there is no registry to look a room up in — and the server,
 * which keeps no catalogue, never has to know what aired when.
 *
 * Season 0 is allowed: specials get rooms like any episode.
 */
const ROOM_KEY = /^tvdb:([1-9][0-9]{0,9}):([0-9]{1,4}):([0-9]{1,5}):([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

export const ROOM_HOURS = 48;
export const RECENT_MAX = 50;
export const FACES_MAX = 12;
export const REACT_GAP_MS = 1000;
/** Two phones on one account is the real case; five matches the devices cap. */
export const SEATS_PER_PROFILE = 5;
export const SEATS_PER_ROOM = 2000;

export type RoomKey = { tvdbId: number; season: number; episode: number; air: string };

export function parseRoomKey(key: string): RoomKey | null {
  const m = ROOM_KEY.exec(key);
  if (!m) return null;
  const air = `${m[4]}-${m[5]}-${m[6]}`;
  // A regex accepts 2026-02-31; Date does not round-trip it, and a room keyed
  // on a day that never existed would simply never open — refuse it instead.
  const d = new Date(`${air}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== air) return null;
  return { tvdbId: Number(m[1]), season: Number(m[2]), episode: Number(m[3]), air };
}

/**
 * Open from the air date's midnight UTC for 48 hours (D17). Wide on purpose:
 * a US late-night show airs on the 14th in New York and the 15th in Baghdad,
 * and next-day viewers are most viewers. The phone mirrors this in its own
 * `roomWindow` so it never asks about a room that cannot be open.
 */
export function roomWindow(air: string, nowMs: number): { open: boolean; opens_at: string; closes_at: string } {
  const opens = Date.parse(`${air}T00:00:00.000Z`);
  const closes = opens + ROOM_HOURS * 3600_000;
  return {
    open: nowMs >= opens && nowMs < closes,
    opens_at: new Date(opens).toISOString(),
    closes_at: new Date(closes).toISOString(),
  };
}

// ── the reducer ──────────────────────────────────────────────────────────────

/** The public shell — what every thread already shows of a person. The id is
 *  here because Report and Block on a long-press need it. */
export type Shell = { id: string; handle: string; display_name: string | null; avatar_key: string | null };

/**
 * One socket. `joined` stays false until the phone sends `join` — before that
 * the socket is neither counted nor sent anything, because what it would be
 * sent (the last 50 reactions) is exactly what a phone that has not watched
 * the episode must not see.
 */
export type Seat = { sid: string; who: Shell; joined: boolean; lastAt: number };
export type Reaction = { who: Shell; emotion: Emotion; at: string };

export type RoomState = {
  seats: Seat[];
  recent: Reaction[];
  /** profileId → ids hidden from them, BOTH directions, as read at their door. */
  blocks: Record<string, string[]>;
};

export type Presence = { watching: number; faces: Shell[] };

export type ServerMessage =
  | ({ t: 'hello'; recent: Reaction[] } & Presence)
  | ({ t: 'presence' } & Presence)
  | ({ t: 'react' } & Reaction)
  | { t: 'pong' }
  | { t: 'error'; code: 'invalid_body' | 'rate_limited' };

export type RoomEvent =
  | { type: 'message'; sid: string; data: string; now: number }
  | { type: 'leave'; sid: string }
  | { type: 'close' };

export type Effect =
  | { kind: 'send'; to: string; msg: ServerMessage }
  | { kind: 'close'; to: string; code: number; reason: string };

/** Close codes the phone switches on. 1000 is the night ending normally. */
export const CLOSE = {
  closed: { code: 1000, reason: 'closed' },
  joinFirst: { code: 4001, reason: 'join_first' },
  notWatched: { code: 4003, reason: 'not_watched' },
} as const;

/**
 * Either one blocked the other. Checked both ways because the two lists were
 * read at two different doors: if A blocked B after B sat down, only A's list
 * knows — and a block must hide both people from each other (routes/blocks.ts).
 */
export function hidden(blocks: RoomState['blocks'], a: string, b: string): boolean {
  return a !== b && ((blocks[a]?.includes(b) ?? false) || (blocks[b]?.includes(a) ?? false));
}

/**
 * Who is here, as one viewer sees it: distinct profiles (two phones on one
 * account count once), minus anybody either side blocked. `viewer` null is the
 * door's count teaser — a number for a member outside, nobody's face.
 */
export function presenceFor(state: RoomState, viewer: string | null): Presence {
  const seen = new Map<string, Shell>();
  for (const s of state.seats) {
    if (!s.joined || seen.has(s.who.id)) continue;
    if (viewer && hidden(state.blocks, viewer, s.who.id)) continue;
    seen.set(s.who.id, s.who);
  }
  return { watching: seen.size, faces: [...seen.values()].slice(0, FACES_MAX) };
}

function presenceToAll(state: RoomState): Effect[] {
  return state.seats
    .filter((s) => s.joined)
    .map((s) => ({ kind: 'send', to: s.sid, msg: { t: 'presence', ...presenceFor(state, s.who.id) } }));
}

function parse(data: string): { t?: unknown; watched?: unknown; emotion?: unknown } | null {
  // Every real message is a few dozen bytes. Anything large is not ours, and
  // refusing it before JSON.parse is the cheap place to refuse it.
  if (data.length > 256) return null;
  try {
    const v: unknown = JSON.parse(data);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as { t?: unknown }) : null;
  } catch {
    return null;
  }
}

/**
 * The whole room, as a function. Returns the next state and what to do about
 * it; never mutates its input, so a test can hold two states side by side.
 */
export function step(state: RoomState, ev: RoomEvent): { state: RoomState; effects: Effect[] } {
  if (ev.type === 'close') {
    // The night is over. Everyone out, nothing kept.
    return {
      state: { seats: [], recent: [], blocks: {} },
      effects: state.seats.map((s) => ({ kind: 'close', to: s.sid, ...CLOSE.closed })),
    };
  }

  if (ev.type === 'leave') {
    const gone = state.seats.find((s) => s.sid === ev.sid);
    const next = { ...state, seats: state.seats.filter((s) => s.sid !== ev.sid) };
    // A socket that never joined was never counted, so nobody needs telling.
    return { state: next, effects: gone?.joined ? presenceToAll(next) : [] };
  }

  const seat = state.seats.find((s) => s.sid === ev.sid);
  if (!seat) return { state, effects: [] };
  const msg = parse(ev.data);
  const replace = (s: Seat) => state.seats.map((x) => (x.sid === s.sid ? s : x));

  if (!seat.joined) {
    /*
     * `join` FIRST, and only with `watched: true`. The phone sends it only when
     * `hasWatchedTarget` says this episode is marked watched — a courtesy lock,
     * not a proof: the server holds no watch history to prove it against, by
     * design (§0), and pretending otherwise would mean keeping one.
     */
    if (msg?.t !== 'join') return { state, effects: [{ kind: 'close', to: seat.sid, ...CLOSE.joinFirst }] };
    if (msg.watched !== true) return { state, effects: [{ kind: 'close', to: seat.sid, ...CLOSE.notWatched }] };
    const next = { ...state, seats: replace({ ...seat, joined: true }) };
    const me = seat.who.id;
    const hello: Effect = {
      kind: 'send',
      to: seat.sid,
      msg: {
        t: 'hello',
        ...presenceFor(next, me),
        recent: next.recent.filter((r) => !hidden(next.blocks, me, r.who.id)),
      },
    };
    return { state: next, effects: [hello, ...presenceToAll(next).filter((e) => e.to !== seat.sid)] };
  }

  if (msg?.t === 'ping') return { state, effects: [{ kind: 'send', to: seat.sid, msg: { t: 'pong' } }] };

  if (msg?.t === 'react') {
    if (!isEmotion(msg.emotion)) {
      return { state, effects: [{ kind: 'send', to: seat.sid, msg: { t: 'error', code: 'invalid_body' } }] };
    }
    // One a second per socket — twelve faces cannot carry abuse, only noise,
    // and this is the ceiling on the noise.
    if (ev.now - seat.lastAt < REACT_GAP_MS) {
      return { state, effects: [{ kind: 'send', to: seat.sid, msg: { t: 'error', code: 'rate_limited' } }] };
    }
    const reaction: Reaction = { who: seat.who, emotion: msg.emotion, at: new Date(ev.now).toISOString() };
    const next: RoomState = {
      ...state,
      seats: replace({ ...seat, lastAt: ev.now }),
      recent: [...state.recent, reaction].slice(-RECENT_MAX),
    };
    // To the sender too: the echo is the phone's confirmation that it landed.
    const effects: Effect[] = next.seats
      .filter((s) => s.joined && !hidden(next.blocks, s.who.id, seat.who.id))
      .map((s) => ({ kind: 'send', to: s.sid, msg: { t: 'react', ...reaction } }));
    return { state: next, effects };
  }

  // A joined socket sending something this build does not know: ignored rather
  // than closed, so a newer phone talking to an older server degrades quietly.
  if (msg) return { state, effects: [] };
  return { state, effects: [{ kind: 'send', to: seat.sid, msg: { t: 'error', code: 'invalid_body' } }] };
}

// ── the Durable Object ───────────────────────────────────────────────────────

/** What the Worker writes at the door. The DO trusts this and nothing else —
 *  it is reachable only through the Worker's binding, never from outside. */
export type DoorPass = { who: Shell; blocked: string[]; closes_at: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export class EpisodeRoom {
  /** Loaded lazily from storage after a hibernation wake; null = not loaded. */
  private blocks: Record<string, string[]> | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    _env: unknown,
  ) {
    // A ping answered by the runtime itself, without waking the object — the
    // phone's keep-alive should cost nothing. Other spellings reach `step`.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  private seats(): { seats: Seat[]; sockets: Map<string, WebSocket> } {
    const sockets = new Map<string, WebSocket>();
    const seats: Seat[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const seat = ws.deserializeAttachment() as Seat | null;
      if (!seat) continue;
      seats.push(seat);
      sockets.set(seat.sid, ws);
    }
    return { seats, sockets };
  }

  private async loadBlocks(): Promise<Record<string, string[]>> {
    if (!this.blocks) {
      const out: Record<string, string[]> = {};
      for (const [k, v] of await this.ctx.storage.list<string[]>({ prefix: 'blocks:' })) out[k.slice(7)] = v;
      this.blocks = out;
    }
    return this.blocks;
  }

  private async state(): Promise<{ state: RoomState; sockets: Map<string, WebSocket> }> {
    const { seats, sockets } = this.seats();
    const recent = (await this.ctx.storage.get<Reaction[]>('recent')) ?? [];
    return { state: { seats, recent, blocks: await this.loadBlocks() }, sockets };
  }

  /** Carry out what `step` decided, and persist only what it changed. */
  private async apply(before: RoomState, out: ReturnType<typeof step>, sockets: Map<string, WebSocket>) {
    for (const seat of out.state.seats) {
      const old = before.seats.find((s) => s.sid === seat.sid);
      if (old !== seat) sockets.get(seat.sid)?.serializeAttachment(seat);
    }
    if (out.state.recent !== before.recent) await this.ctx.storage.put('recent', out.state.recent);
    for (const e of out.effects) {
      const ws = sockets.get(e.to);
      if (!ws) continue;
      try {
        if (e.kind === 'send') ws.send(JSON.stringify(e.msg));
        else ws.close(e.code, e.reason);
      } catch {
        // Already closing. Its own close event will tidy up.
      }
    }
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;

    if (path === '/count') {
      const { seats } = this.seats();
      return json({ watching: presenceFor({ seats, recent: [], blocks: {} }, null).watching });
    }

    if (path !== '/ws' || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: { code: 'not_found', message: 'No such room route.' } }, 404);
    }

    const pass = JSON.parse(decodeURIComponent(req.headers.get('X-Room-Pass') ?? '')) as DoorPass;
    const { seats } = this.seats();
    if (seats.length >= SEATS_PER_ROOM || seats.filter((s) => s.who.id === pass.who.id).length >= SEATS_PER_PROFILE) {
      return json({ error: { code: 'room_full', message: 'This room is full.' } }, 429);
    }

    // The block list is refreshed at every join, so a block made during the
    // night takes effect for the blocker on their next join — and for the
    // blocked person at once, because `hidden` reads both lists.
    await this.ctx.storage.put(`blocks:${pass.who.id}`, pass.blocked);
    (await this.loadBlocks())[pass.who.id] = pass.blocked;

    // The first seat of the night sets the alarm; later ones find it set.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.put('closes_at', pass.closes_at);
      await this.ctx.storage.setAlarm(Date.parse(pass.closes_at));
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [pass.who.id]);
    const seat: Seat = { sid: crypto.randomUUID(), who: pass.who, joined: false, lastAt: 0 };
    server.serializeAttachment(seat);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const seat = ws.deserializeAttachment() as Seat | null;
    if (!seat) return;
    const { state, sockets } = await this.state();
    const text = typeof data === 'string' ? data : '';
    await this.apply(state, step(state, { type: 'message', sid: seat.sid, data: text, now: Date.now() }), sockets);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Auto-replied already (compat date ≥ 2026-04-07). Nothing to do.
    }
    await this.leave(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  private async leave(ws: WebSocket): Promise<void> {
    const seat = ws.deserializeAttachment() as Seat | null;
    if (!seat) return;
    const { state, sockets } = await this.state();
    // The closing socket may or may not still be listed; `step` removes it by
    // id either way, and nothing is sent to it.
    sockets.delete(seat.sid);
    await this.apply(state, step(state, { type: 'leave', sid: seat.sid }), sockets);
  }

  async alarm(): Promise<void> {
    const { state, sockets } = await this.state();
    const out = step(state, { type: 'close' });
    for (const e of out.effects) {
      if (e.kind === 'close') {
        try {
          sockets.get(e.to)?.close(e.code, e.reason);
        } catch {
          // already gone
        }
      }
    }
    await this.ctx.storage.deleteAll();
    this.blocks = null;
  }
}
