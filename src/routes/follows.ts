import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { sendPush } from '@/push';
import { requireAuth } from '@/middleware';
import { FOLLOW_PAGE, makeCursor, parseCursor, plusOn, shouldNotify } from '@/pure';
import { newNotificationId } from '@/routes/comments';

/**
 * Follow and unfollow, and the two lists that hang off them.
 * docs/IMPLEMENTATION.md Step 4, "Follow".
 *
 * Three rules that are not obvious from the endpoints:
 *
 *  1. A block REFUSES a follow, in either direction — 403 `blocked`. Removing
 *     the existing edges is `routes/blocks.ts`'s job and is not repeated here;
 *     this is the other half, which stops the blocked party from simply
 *     following again a second later.
 *  2. The notification is written only when a row was actually created. A
 *     re-tapped follow button must not re-notify.
 *  3. A FOLLOW OF A PRIVATE PROFILE IS A REQUEST, not a follow. It writes the
 *     same row with `state = 'pending'`, which grants nothing until the owner
 *     accepts — so every read of `follows` that counts or lists people must say
 *     `state = 'accepted'`. A read that forgets it hands a stranger the counts
 *     of a profile they were never let into.
 */

export const follows = new Hono<App>();

/** A block in EITHER direction, as a fragment. Bound with (me, other, other, me). */
const BLOCK_EXISTS = `SELECT 1 AS one FROM blocks
   WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`;

/** The `follow` notification a granted follow writes — a public one, or an accepted request. */
function followNotification(db: D1Database, owner: string, follower: string, nowIso: string) {
  return db
    .prepare(
      `INSERT INTO notifications (id, recipient_id, actor_id, kind, subject_type, subject_id, created_at)
       VALUES (?, ?, ?, 'follow', 'profile', ?, ?)`,
    )
    .bind(newNotificationId(), owner, follower, follower, nowIso);
}

// ── POST /v1/follows/:profileId ─────────────────────────────────────────────

follows.post('/follows/:profileId', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('profileId');
  const other = c.req.param('profileId');
  const nowIso = new Date().toISOString();

  // The table's CHECK (follower_id <> followee_id) would refuse this anyway,
  // and the catch below still covers the race; answering here turns a
  // constraint error into a sentence.
  if (other === me) return fail(c, 400, 'invalid_body', 'You cannot follow yourself.');

  const target = await db
    .prepare('SELECT is_private FROM profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(other)
    .first<{ is_private: number }>();
  if (!target) return fail(c, 404, 'not_found', 'No such profile.');

  const blocked = await db.prepare(BLOCK_EXISTS).bind(me, other, other, me).first();
  if (blocked) return fail(c, 403, 'blocked', 'You cannot follow this profile.');

  const existing = await db
    .prepare('SELECT state FROM follows WHERE follower_id = ? AND followee_id = ?')
    .bind(me, other)
    .first<{ state: string }>();

  // ALREADY ACCEPTED — including an old edge on a profile that has since gone
  // private. Turning the switch on must not demote the followers somebody
  // already has; it only decides who may become one from now on.
  if (existing?.state === 'accepted') return c.json({ ok: true, following: true, requested: false });

  const wantsPending = target.is_private === 1;

  if (existing) {
    // A pending request. Re-tapping is idempotent and must NOT re-notify — the
    // owner would otherwise get one row per tap from somebody they have not
    // answered yet, which is the shape of harassment the request flow exists to
    // prevent.
    if (wantsPending) return c.json({ ok: true, following: false, requested: true });

    // The profile went PUBLIC while the request sat unanswered. There is
    // nothing left to ask for, so it becomes the follow it was asking to be,
    // and the owner gets the notification a public follow always writes.
    await db
      .prepare("UPDATE follows SET state = 'accepted' WHERE follower_id = ? AND followee_id = ?")
      .bind(me, other)
      .run();
    if (shouldNotify(me, other)) {
      await followNotification(db, other, me, nowIso).run();
      c.executionCtx.waitUntil(sendPush(c.env, other, me, 'follow', me));
    }
    return c.json({ ok: true, following: true, requested: false });
  }

  // INSERT alone, not in the batch: the notification depends on `meta.changes`,
  // and a batch cannot branch on a result.
  let inserted;
  try {
    inserted = await db
      .prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at, state) VALUES (?, ?, ?, ?)')
      .bind(me, other, nowIso, wantsPending ? 'pending' : 'accepted')
      .run();
  } catch {
    // The CHECK constraint, reached only by a race the guard above lost.
    return fail(c, 400, 'invalid_body', 'You cannot follow yourself.');
  }

  if (inserted.meta.changes > 0 && shouldNotify(me, other)) {
    if (wantsPending) {
      // NO PUSH for a request. A push is a doorbell for something that has
      // happened; a request is a question, and the answer lives on a screen the
      // owner opens. The row is what makes it findable.
      await db
        .prepare(
          `INSERT INTO notifications (id, recipient_id, actor_id, kind, subject_type, subject_id, created_at)
           VALUES (?, ?, ?, 'follow_request', 'profile', ?, ?)`,
        )
        .bind(newNotificationId(), other, me, me, nowIso)
        .run();
    } else {
      await followNotification(db, other, me, nowIso).run();
      // Not awaited: the row is written, and a follow that waits on Expo is a
      // follow that feels slow. `waitUntil` keeps the Worker alive for it.
      c.executionCtx.waitUntil(sendPush(c.env, other, me, 'follow', me));
    }
  }

  return c.json({ ok: true, following: !wantsPending, requested: wantsPending });
});

// ── DELETE /v1/follows/:profileId ───────────────────────────────────────────

follows.delete('/follows/:profileId', requireAuth, async (c) => {
  // Idempotent: unfollowing someone you do not follow is not an error, it is
  // the state the caller asked for. The `follow` notification already sent is
  // deliberately left alone — it happened.
  //
  // WHATEVER THE STATE, deliberately unfiltered: this is both "unfollow" and
  // "cancel my request", and a caller who has changed their mind about asking
  // has no other way to take the question back.
  await c.env.DB.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?')
    .bind(c.get('profileId'), c.req.param('profileId'))
    .run();
  return c.body(null, 204);
});

// ── the two lists ───────────────────────────────────────────────────────────

type EdgeRow = {
  id: string;
  handle: string;
  display_name: string | null;
  avatar_key: string | null;
  is_plus: number;
  plus_until: string | null;
  created_at: string;
};

/** The same shell a search result carries, badge included — see the note in
 *  `routes/profiles.ts`: a badge that appears on the profile and not in the
 *  follower list it was opened from reads as a bug. */
function shapeEdge(row: EdgeRow, nowIso: string) {
  return {
    id: row.id,
    handle: row.handle,
    display_name: row.display_name,
    avatar_key: row.avatar_key,
    is_plus: plusOn(row, nowIso),
    followed_at: row.created_at,
    // The same instant under the name a REQUEST row wants it: "asked 3 days
    // ago" is the only detail the requests screen has to sort or explain
    // itself by, and one shaper for both lists is how they cannot drift.
    created_at: row.created_at,
  };
}

/**
 * One query for both directions. `side` names the column holding the OTHER
 * person — `followee_id` when listing who I follow, `follower_id` when listing
 * who follows someone. That id is also the cursor's tie-breaker, exactly as
 * the plan's `created_at|follower_id` intends: the pair is a total order, and
 * a seeded import can write many edges inside one second.
 *
 * `state` defaults to 'accepted' so no caller can forget it: a follower list
 * that quietly included the people who have merely asked would publish exactly
 * what a private profile withholds.
 */
export async function edgePage(
  db: D1Database,
  ownerColumn: 'follower_id' | 'followee_id',
  side: 'follower_id' | 'followee_id',
  ownerId: string,
  cursorRaw: string | null,
  state: 'accepted' | 'pending' = 'accepted',
) {
  const cursor = parseCursor(cursorRaw);
  const where = [`f.${ownerColumn} = ?`, 'f.state = ?', 'p.deleted_at IS NULL'];
  const binds: (string | number)[] = [ownerId, state];
  if (cursor) {
    where.push(`(f.created_at, f.${side}) < (?, ?)`);
    binds.push(cursor.createdAt, cursor.id);
  }

  const res = await db
    .prepare(
      `SELECT p.id, p.handle, p.display_name, p.avatar_key, p.is_plus, p.plus_until, f.created_at
       FROM follows f JOIN profiles p ON p.id = f.${side}
       WHERE ${where.join(' AND ')}
       ORDER BY f.created_at DESC, f.${side} DESC
       LIMIT ?`,
    )
    // limit + 1: the extra row is how `next_cursor` knows this is not the last
    // page, without a second count.
    .bind(...binds, FOLLOW_PAGE + 1)
    .all<EdgeRow>();

  const rows = res.results ?? [];
  const page = rows.slice(0, FOLLOW_PAGE);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => shapeEdge(r, new Date().toISOString())),
    next_cursor: rows.length > FOLLOW_PAGE && last ? makeCursor(last.created_at, last.id) : null,
  };
}

follows.get('/me/following', requireAuth, async (c) =>
  c.json(
    await edgePage(
      c.env.DB,
      'follower_id',
      'followee_id',
      c.get('profileId'),
      new URL(c.req.url).searchParams.get('cursor'),
    ),
  ),
);

// ── GET /v1/me/follow-requests ──────────────────────────────────────────────

/**
 * Who has asked to follow me and has not been answered.
 *
 * The same rows the followers list returns, from the same helper and with the
 * same cursor, because they end up in the same list on the phone the moment one
 * is accepted — two shapers would mean the person's avatar arriving in a
 * different field depending on which screen drew them.
 */
follows.get('/me/follow-requests', requireAuth, async (c) =>
  c.json(
    await edgePage(
      c.env.DB,
      'followee_id',
      'follower_id',
      c.get('profileId'),
      new URL(c.req.url).searchParams.get('cursor'),
      'pending',
    ),
  ),
);

// ── POST /v1/me/follow-requests/:profileId ──────────────────────────────────

/**
 * The answer. `accept` grants the follow, `deny` removes the question.
 *
 * DENY WRITES NOTHING AND SAYS NOTHING. The requester is never told they were
 * refused — they see the button fall back to "Follow", which is
 * indistinguishable from having cancelled it themselves. Announcing a refusal
 * would make declining somebody an act with a social cost, and nobody would do
 * it.
 *
 * ACCEPT WRITES THE ORDINARY `follow` NOTIFICATION, the identical row a public
 * follow writes: from this moment the two relationships are the same thing, and
 * the owner's inbox should read the same either way rather than have a gap
 * where every private follow happened.
 */
follows.post('/me/follow-requests/:profileId', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const action = (body as { action?: unknown } | null)?.action;
  if (action !== 'accept' && action !== 'deny') {
    return fail(c, 400, 'invalid_body', 'action must be "accept" or "deny".');
  }

  const db = c.env.DB;
  const me = c.get('profileId');
  const other = c.req.param('profileId');
  const nowIso = new Date().toISOString();

  // The state is in the predicate, so answering the same request twice — two
  // taps, or two devices — cannot re-notify: the second UPDATE matches nothing.
  const res = await db
    .prepare(
      action === 'accept'
        ? "UPDATE follows SET state = 'accepted' WHERE follower_id = ? AND followee_id = ? AND state = 'pending'"
        : "DELETE FROM follows WHERE follower_id = ? AND followee_id = ? AND state = 'pending'",
    )
    .bind(other, me)
    .run();

  if (res.meta.changes === 0) return fail(c, 404, 'not_found', 'No such follow request.');

  // NO PUSH. The recipient of this row is the person who just tapped Accept —
  // buzzing their own phone to tell them what they have this second done is
  // noise. The row exists for the inbox's consistency, not to announce.
  if (action === 'accept' && shouldNotify(other, me)) {
    await followNotification(db, me, other, nowIso).run();
  }

  return c.json({ ok: true, following: action === 'accept' });
});
