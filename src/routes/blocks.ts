import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';

/**
 * Block and unblock. docs/IMPLEMENTATION.md Step 3, "Blocks".
 *
 * A block that leaves a follow edge in place is not a block, so the follow
 * rows go in the SAME batch as the block row — both directions. Reads filter
 * blocks both ways too (see `routes/comments.ts`): I do not see them, and they
 * do not see me.
 */

export const blocks = new Hono<App>();

blocks.post('/blocks/:profileId', requireAuth, async (c) => {
  const me = c.get('profileId');
  const other = c.req.param('profileId');

  // The table's CHECK would refuse this anyway; refusing it here turns a
  // constraint error into an answer.
  if (other === me) return fail(c, 400, 'invalid_body', 'You cannot block yourself.');

  const db = c.env.DB;
  const exists = await db
    .prepare('SELECT 1 AS one FROM profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(other)
    .first();
  if (!exists) return fail(c, 404, 'not_found', 'No such profile.');

  await db.batch([
    db
      .prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)')
      .bind(me, other, new Date().toISOString()),
    db
      .prepare(
        'DELETE FROM follows WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)',
      )
      .bind(me, other, other, me),
  ]);

  return c.body(null, 204);
});

blocks.delete('/blocks/:profileId', requireAuth, async (c) => {
  // Unblocking does NOT restore the follows the block removed. Re-following is
  // a decision, and making it again is the point.
  await c.env.DB.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?')
    .bind(c.get('profileId'), c.req.param('profileId'))
    .run();
  return c.body(null, 204);
});
