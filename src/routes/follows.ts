import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import { FOLLOW_PAGE, makeCursor, parseCursor, shouldNotify } from '@/pure';
import { newNotificationId } from '@/routes/comments';

/**
 * Follow and unfollow, and the two lists that hang off them.
 * docs/IMPLEMENTATION.md Step 4, "Follow".
 *
 * Two rules that are not obvious from the endpoints:
 *
 *  1. A block REFUSES a follow, in either direction — 403 `blocked`. Removing
 *     the existing edges is `routes/blocks.ts`'s job and is not repeated here;
 *     this is the other half, which stops the blocked party from simply
 *     following again a second later.
 *  2. The notification is written only when a row was actually created. A
 *     re-tapped follow button must not re-notify.
 */

export const follows = new Hono<App>();

/** A block in EITHER direction, as a fragment. Bound with (me, other, other, me). */
const BLOCK_EXISTS = `SELECT 1 AS one FROM blocks
   WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`;

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
    .prepare('SELECT 1 AS one FROM profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(other)
    .first();
  if (!target) return fail(c, 404, 'not_found', 'No such profile.');

  const blocked = await db.prepare(BLOCK_EXISTS).bind(me, other, other, me).first();
  if (blocked) return fail(c, 403, 'blocked', 'You cannot follow this profile.');

  // INSERT alone, not in the batch: the notification depends on `meta.changes`,
  // and a batch cannot branch on a result.
  let inserted;
  try {
    inserted = await db
      .prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)')
      .bind(me, other, nowIso)
      .run();
  } catch {
    // The CHECK constraint, reached only by a race the guard above lost.
    return fail(c, 400, 'invalid_body', 'You cannot follow yourself.');
  }

  if (inserted.meta.changes > 0 && shouldNotify(me, other)) {
    await db
      .prepare(
        `INSERT INTO notifications (id, recipient_id, actor_id, kind, subject_type, subject_id, created_at)
         VALUES (?, ?, ?, 'follow', 'profile', ?, ?)`,
      )
      .bind(newNotificationId(), other, me, me, nowIso)
      .run();
  }

  return c.json({ following: true });
});

// ── DELETE /v1/follows/:profileId ───────────────────────────────────────────

follows.delete('/follows/:profileId', requireAuth, async (c) => {
  // Idempotent: unfollowing someone you do not follow is not an error, it is
  // the state the caller asked for. The `follow` notification already sent is
  // deliberately left alone — it happened.
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
  created_at: string;
};

function shapeEdge(row: EdgeRow) {
  return {
    id: row.id,
    handle: row.handle,
    display_name: row.display_name,
    avatar_key: row.avatar_key,
    followed_at: row.created_at,
  };
}

/**
 * One query for both directions. `side` names the column holding the OTHER
 * person — `followee_id` when listing who I follow, `follower_id` when listing
 * who follows someone. That id is also the cursor's tie-breaker, exactly as
 * the plan's `created_at|follower_id` intends: the pair is a total order, and
 * a seeded import can write many edges inside one second.
 */
export async function edgePage(
  db: D1Database,
  ownerColumn: 'follower_id' | 'followee_id',
  side: 'follower_id' | 'followee_id',
  ownerId: string,
  cursorRaw: string | null,
) {
  const cursor = parseCursor(cursorRaw);
  const where = [`f.${ownerColumn} = ?`, 'p.deleted_at IS NULL'];
  const binds: (string | number)[] = [ownerId];
  if (cursor) {
    where.push(`(f.created_at, f.${side}) < (?, ?)`);
    binds.push(cursor.createdAt, cursor.id);
  }

  const res = await db
    .prepare(
      `SELECT p.id, p.handle, p.display_name, p.avatar_key, f.created_at
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
    items: page.map(shapeEdge),
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
