import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import { chunk, RECONCILE_IDS_PER_QUERY, RECONCILE_MAX_IDS, validateFriendIds } from '@/pure';
import { newNotificationId } from '@/routes/comments';

/**
 * Reconnection. docs/IMPLEMENTATION.md Step 4, "Reconnection".
 *
 * `friend.csv` in a TV Time export lists friendships as numeric id pairs and
 * carries no usernames at all, so the match is on `tvtime_user_id` and can
 * only be. Two people who were friends in 2019 find each other without typing
 * anything.
 */

export const reconcile = new Hono<App>();

type MatchRow = {
  id: string;
  handle: string;
  display_name: string | null;
  avatar_key: string | null;
  /** Which of the caller's OWN friend ids this profile answers to. */
  tvtime_user_id: number | null;
};

reconcile.post('/me/friends/reconcile', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const friends = validateFriendIds(b.friend_ids);
  if (!friends.ok) {
    return friends.reason === 'too_many'
      ? fail(c, 400, 'invalid_body', `friend_ids holds at most ${RECONCILE_MAX_IDS} ids per call.`)
      : fail(c, 400, 'invalid_body', 'friend_ids must be an array of positive integers.');
  }

  let ownId: number | null = null;
  if (b.tvtime_user_id !== undefined && b.tvtime_user_id !== null) {
    if (typeof b.tvtime_user_id !== 'number' || !Number.isInteger(b.tvtime_user_id) || b.tvtime_user_id <= 0) {
      return fail(c, 400, 'invalid_body', 'tvtime_user_id must be a positive integer.');
    }
    ownId = b.tvtime_user_id;
  }

  const db = c.env.DB;
  const me = c.get('profileId');
  const nowIso = new Date().toISOString();

  // WRITE-ONCE, enforced by the predicate rather than by a read-then-write.
  // A mutable field here would let one account re-point at id after id and
  // harvest `friend_found` notifications across the entire user base. The
  // residual risk — that the first claimant of an id might not own it — is
  // accepted and recorded in the plan: the id grants nothing but a mutual
  // "you were friends" hint, and the export it comes from is the user's own
  // GDPR download.
  //
  // SEMANTICS when it is already set to a DIFFERENT id: zero rows change and
  // matching proceeds anyway. The caller is not told, and nothing is
  // overwritten. Refusing the whole call would break the ordinary case of a
  // user reconciling from a second device whose export names the same person;
  // overwriting would be exactly the harvesting hole write-once exists to
  // close. Matching still works, because matching reads the OTHER side's ids.
  if (ownId !== null) {
    await db
      .prepare(
        'UPDATE profiles SET tvtime_user_id = ? WHERE id = ? AND tvtime_user_id IS NULL AND deleted_at IS NULL',
      )
      .bind(ownId, me)
      .run();
  }

  const mine = await db
    .prepare('SELECT tvtime_user_id FROM profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(me)
    .first<{ tvtime_user_id: number | null }>();
  if (!mine) return fail(c, 401, 'unauthenticated', 'No such profile.');

  if (friends.ids.length === 0) return c.json({ matched: [] });

  // The `idx_profiles_tvtime` partial index makes this `IN` cheap. Self is
  // excluded — an export lists the exporter among its own friendships often
  // enough — and so is anyone on either side of a block: they are neither
  // notified nor returned, because a block predates any nostalgia.
  //
  // CHUNKED, because `RECONCILE_MAX_IDS` is 500 and a D1 statement binds at most
  // 100 parameters. One placeholder per id plus the three fixed binds below made
  // this a 500 from the 98th friend onward — the same arithmetic that broke the
  // aggregate list form, at a different threshold. See `RECONCILE_IDS_PER_QUERY`.
  //
  // The groups go in one `db.batch()`, so this is still a single round trip, and
  // an id appears in exactly one group, so no profile can come back twice.
  const found = await db.batch<MatchRow>(
    chunk(friends.ids, RECONCILE_IDS_PER_QUERY).map((ids) =>
      db
        .prepare(
          `SELECT id, handle, display_name, avatar_key, tvtime_user_id
       FROM profiles p
       WHERE p.tvtime_user_id IN (${ids.map(() => '?').join(',')})
         AND p.deleted_at IS NULL
         AND p.id <> ?
         AND NOT EXISTS (SELECT 1 FROM blocks b
                         WHERE (b.blocker_id = ? AND b.blocked_id = p.id)
                            OR (b.blocker_id = p.id AND b.blocked_id = ?))`,
        )
        .bind(...ids, me, me, me),
    ),
  );

  const matches = found.flatMap((r) => r.results ?? []);

  // BOTH sides, because the other person's app may never ask again — and a
  // one-sided "you were friends" is a hint only one of them can act on.
  //
  // The NOT EXISTS guard is what makes the call idempotent: the app fires it
  // after every sign-in whose friend list changed, and a second run must not
  // re-notify anybody. It is written INSIDE the INSERT rather than checked
  // first, so two concurrent calls cannot both pass a read and both write.
  const statements = matches.flatMap((m) => [
    notifyOnce(db, m.id, me, me, nowIso),
    notifyOnce(db, me, m.id, m.id, nowIso),
  ]);
  if (statements.length > 0) await db.batch(statements);

  return c.json({
    matched: matches.map((m) => ({
      handle: m.handle,
      display_name: m.display_name,
      avatar_key: m.avatar_key,
      // WHICH friend this is. The caller sent these ids and already holds the
      // name and avatar the export gave for each; without the id coming back,
      // a matched handle cannot be tied to the person it belongs to, and the
      // same human appears twice in a merged follow list — once as a TV Time
      // row and once as an OpenTV one. Returning it discloses nothing: it is
      // the caller's own input.
      tvtime_user_id: m.tvtime_user_id,
    })),
  });
});

/** One `friend_found` row, written only if this pair has never had one. */
function notifyOnce(
  db: D1Database,
  recipient: string,
  actor: string,
  subject: string,
  nowIso: string,
) {
  return db
    .prepare(
      `INSERT INTO notifications (id, recipient_id, actor_id, kind, subject_type, subject_id, created_at)
       SELECT ?, ?, ?, 'friend_found', 'profile', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM notifications
                         WHERE recipient_id = ? AND actor_id = ? AND kind = 'friend_found')`,
    )
    .bind(newNotificationId(), recipient, actor, subject, nowIso, recipient, actor);
}
