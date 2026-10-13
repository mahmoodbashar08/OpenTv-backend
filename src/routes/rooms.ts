import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import { plusOn } from '@/pure';
import { parseRoomKey, roomWindow, type DoorPass } from '@/rooms';

/**
 * The door to the live room (2.0.0, feature 3; DESIGN-community.md §3.4).
 *
 * The room itself is the `EpisodeRoom` Durable Object in `src/rooms.ts`. This
 * file is everything that happens BEFORE it: the key is checked, the window is
 * checked against the clock, and for the socket the caller's profile and block
 * lists are read once and handed in. The DO never touches D1.
 *
 * WHAT THE DOOR DOES NOT CHECK: whether the caller watched the episode. The
 * server holds no watch history (§0), so it has nothing to check it against;
 * the phone asks `hasWatchedTarget` before it offers the room and says so in
 * its first message. That is a courtesy lock, and this file does not dress it
 * up as anything more.
 *
 * NO BINDING, NO ROOM. `ROOMS` is optional like every capability here: a
 * self-hosted instance (Node, no Durable Object runtime) answers
 * `not_configured`, and the app never draws the pill.
 */
export const rooms = new Hono<App>();

/**
 * The count teaser — "Live room · 12 watching" on the episode page (D14: every
 * member sees it; entering is what needs Plus). Zero D1 rows: `requireAuth`
 * verifies the token in the isolate, and outside the window the DO is not even
 * woken.
 */
rooms.get('/rooms/:key', requireAuth, async (c) => {
  if (!c.env.ROOMS) return fail(c, 503, 'not_configured', 'This server has no live rooms.');
  const key = parseRoomKey(c.req.param('key'));
  if (!key) return fail(c, 400, 'invalid_body', 'Not a room key.');
  const w = roomWindow(key.air, Date.now());
  if (!w.open) return c.json({ open: false, watching: 0, opens_at: w.opens_at, closes_at: w.closes_at });

  const stub = c.env.ROOMS.get(c.env.ROOMS.idFromName(c.req.param('key')));
  const { watching } = await (await stub.fetch('https://room/count')).json<{ watching: number }>();
  return c.json({ open: true, watching, opens_at: w.opens_at, closes_at: w.closes_at });
});

/**
 * The socket. Every refusal that needs no database comes first, so a phone
 * knocking on a closed room costs nothing.
 */
rooms.get('/rooms/:key/ws', requireAuth, async (c) => {
  if (!c.env.ROOMS) return fail(c, 503, 'not_configured', 'This server has no live rooms.');
  const raw = c.req.param('key');
  const key = parseRoomKey(raw);
  if (!key) return fail(c, 400, 'invalid_body', 'Not a room key.');
  const w = roomWindow(key.air, Date.now());
  if (!w.open) return fail(c, 410, 'room_closed', 'This room is not open.');
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return fail(c, 426, 'upgrade_required', 'Open this as a WebSocket.');
  }

  const me = c.get('profileId');
  const db = c.env.DB;
  /*
   * TWO STATEMENTS, and that is the whole D1 bill of a night in the room.
   *
   * One profile row carries the shell, the "joined" mark and both halves of
   * Plus, rather than calling `hasPlus()` and reading the same row twice.
   *
   * Blocks both ways. `blocker_id = ?` is the primary key's prefix; the other
   * direction has no index of its own (the room has no migration to add one)
   * and scans `blocks`, which is a table of a few dozen rows. If it ever grows,
   * `CREATE INDEX blocks_blocked ON blocks (blocked_id)` is the fix.
   */
  const [profile, blocked] = await db.batch([
    db
      .prepare(
        `SELECT handle, display_name, avatar_key, joined_at, is_plus, plus_until
           FROM profiles WHERE id = ? AND deleted_at IS NULL`,
      )
      .bind(me),
    db
      .prepare(
        `SELECT blocked_id AS id FROM blocks WHERE blocker_id = ?
         UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id = ?`,
      )
      .bind(me, me),
  ]);
  const row = profile?.results[0] as
    | { handle: string; display_name: string | null; avatar_key: string | null; joined_at: string | null; is_plus: number | null; plus_until: string | null }
    | undefined;
  // A deleted account and one that never joined the community get the same
  // answer: the room is part of the community, and they are not in it.
  if (!row || !row.joined_at) return fail(c, 403, 'forbidden', 'Join the community first.');
  if (!c.env.SELF_HOSTED && !plusOn(row, new Date().toISOString())) {
    return fail(c, 403, 'plus_required', 'The live room is part of OpenTV Plus.');
  }

  const pass: DoorPass = {
    who: { id: me, handle: row.handle, display_name: row.display_name, avatar_key: row.avatar_key },
    blocked: (blocked?.results as { id: string }[] | undefined ?? []).map((r) => r.id),
    closes_at: w.closes_at,
  };
  // A FRESH request, never the caller's with a header added: whatever the
  // phone sent is dropped, so nobody can hand the room a pass of their own.
  // URI-encoded because a display name is Unicode and a header is bytes.
  const stub = c.env.ROOMS.get(c.env.ROOMS.idFromName(raw));
  return stub.fetch('https://room/ws', {
    headers: { Upgrade: 'websocket', 'X-Room-Pass': encodeURIComponent(JSON.stringify(pass)) },
  });
});
