import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import { makeCursor, pageSize, parseCursor, plusOn } from '@/pure';

/**
 * The inbox. docs/IMPLEMENTATION.md Step 4, "Notification write paths".
 *
 * Nothing here WRITES a notification: every one of them is written by the
 * handler that caused it, in the same batch, never by a job. This file only
 * reads them back and marks them read.
 */

export const notifications = new Hono<App>();

type NotificationRow = {
  id: string;
  kind: string;
  subject_type: string | null;
  subject_id: string | null;
  read_at: string | null;
  created_at: string;
  actor_id: string | null;
  handle: string | null;
  display_name: string | null;
  avatar_key: string | null;
  is_plus: number | null;
  plus_until: string | null;
};

function shape(row: NotificationRow) {
  return {
    id: row.id,
    kind: row.kind,
    // `actor_id` is ON DELETE SET NULL, so a notification outlives its actor.
    // The client renders those as "someone", which is better than hiding a
    // like that really did happen.
    actor:
      row.actor_id && row.handle
        ? {
            id: row.actor_id,
            handle: row.handle,
            display_name: row.display_name,
            avatar_key: row.avatar_key,
            is_plus: plusOn(row, new Date().toISOString()),
          }
        : null,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    read_at: row.read_at,
    created_at: row.created_at,
  };
}

// ── GET /v1/notifications ───────────────────────────────────────────────────

notifications.get('/notifications', requireAuth, async (c) => {
  const url = new URL(c.req.url);
  const limit = pageSize(url.searchParams.get('limit'));
  const cursor = parseCursor(url.searchParams.get('cursor'));
  const me = c.get('profileId');

  const where = ['n.recipient_id = ?'];
  const cursorBinds: string[] = [];
  if (cursor) {
    // (created_at, id) again: a reconcile writes a burst of rows in one second.
    where.push('(n.created_at, n.id) < (?, ?)');
    cursorBinds.push(cursor.createdAt, cursor.id);
  }

  // LEFT JOIN, because `actor_id` may be NULL. The filter that follows says:
  // keep actorless rows; drop rows whose actor has deleted their account or is
  // on either side of a block. Blocks filter BOTH directions here for the same
  // reason they do in a thread — a block that leaves the notification behind
  // is a mute with a back door.
  const res = await c.env.DB.prepare(
    `SELECT n.id, n.kind, n.subject_type, n.subject_id, n.read_at, n.created_at,
            n.actor_id, a.handle, a.display_name, a.avatar_key, a.is_plus, a.plus_until
     FROM notifications n
     LEFT JOIN profiles a ON a.id = n.actor_id
     WHERE ${where.join(' AND ')}
       AND (n.actor_id IS NULL OR (a.id IS NOT NULL AND a.deleted_at IS NULL))
       AND NOT EXISTS (SELECT 1 FROM blocks b
                       WHERE (b.blocker_id = ? AND b.blocked_id = n.actor_id)
                          OR (b.blocker_id = n.actor_id AND b.blocked_id = ?))
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT ?`,
  )
    .bind(me, ...cursorBinds, me, me, limit + 1)
    .all<NotificationRow>();

  const rows = res.results ?? [];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  return c.json({
    items: page.map(shape),
    next_cursor: rows.length > limit && last ? makeCursor(last.created_at, last.id) : null,
  });
});

// ── POST /v1/notifications/read ─────────────────────────────────────────────

notifications.post('/notifications/read', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const upTo = (body as { up_to?: unknown } | null)?.up_to;
  if (typeof upTo !== 'string' || Number.isNaN(Date.parse(upTo))) {
    return fail(c, 400, 'invalid_body', 'up_to must be an ISO timestamp.');
  }

  // A WATERMARK, not a list of ids: the badge clears in one request no matter
  // how many rows are behind it. `<=` and not `<` — the timestamp a client
  // sends back is the newest row it has seen, and excluding it would leave
  // that row unread forever.
  const res = await c.env.DB.prepare(
    'UPDATE notifications SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL AND created_at <= ?',
  )
    .bind(new Date().toISOString(), c.get('profileId'), upTo)
    .run();

  return c.json({ marked: res.meta.changes });
});
