import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import { newNotificationId } from '@/routes/comments';
import { sendPush } from '@/push';
import {
  FREE_SHARED_LISTS,
  SHARED_LIST_MAX_ITEMS,
  SHARED_LIST_MAX_MEMBERS,
  newInviteCode,
  normaliseInviteCode,
  plusOn,
  validSharedListName,
  validSharedTarget,
} from '@/pure';

/**
 * Lists two people build together.
 *
 * THE ONE PLACE THE SERVER IS THE SOURCE OF TRUTH, and migration 0022 explains
 * why at length: two phones write to one list, so neither copy can win without
 * quietly eating the other's edits. Everything else on this server still
 * mirrors a phone.
 *
 * THE PAYWALL IS ON THE DOOR HANDLE, NOT THE DOOR. Creating a shared list needs
 * Plus past the first one; JOINING one never does, at any tier, for ever. That
 * is not generosity, it is the only arrangement that works: a list whose
 * invitees must pay to accept is a list of one person, and the paying member
 * has bought an empty room. This way one subscription pulls three people into
 * the app, and they meet the feature by using it rather than by reading about
 * it on a paywall.
 *
 * WHAT THIS DOES NOT STORE. No watch history. `shared_list_watched` records that
 * a member ticked an item off THIS list, which is a thing they did here, on
 * purpose, in front of the other members. Nothing else reads that table and no
 * screen anywhere derives a library from it.
 */

export const sharedLists = new Hono<App>();

const newListId = () => `sl_${crypto.randomUUID().replace(/-/g, '')}`;
const newItemId = () => `si_${crypto.randomUUID().replace(/-/g, '')}`;

type ListRow = { id: string; owner_id: string; name: string; invite_code: string; created_at: string };
type MemberRow = { role: string };

/** The caller's membership, or null. Every route below starts here. */
async function membership(db: D1Database, listId: string, me: string): Promise<MemberRow | null> {
  return db
    .prepare(
      `SELECT m.role FROM shared_list_members m
         JOIN shared_lists l ON l.id = m.list_id
        WHERE m.list_id = ? AND m.member_id = ? AND l.deleted_at IS NULL`,
    )
    .bind(listId, me)
    .first<MemberRow>();
}

async function isPlus(db: D1Database, me: string, nowIso: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT is_plus, plus_until FROM profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(me)
    .first<{ is_plus: number; plus_until: string | null }>();
  return row ? plusOn(row, nowIso) : false;
}

/**
 * Tell the OTHER members that something happened. Never the actor -- being
 * notified about your own tap is the fastest way to make somebody mute an app.
 */
async function notifyOthers(
  env: App['Bindings'],
  listId: string,
  actor: string,
  kind: string,
  nowIso: string,
): Promise<void> {
  const others = await env.DB.prepare(
    'SELECT member_id FROM shared_list_members WHERE list_id = ? AND member_id <> ?',
  )
    .bind(listId, actor)
    .all<{ member_id: string }>();
  const rows = others.results ?? [];
  if (rows.length === 0) return;

  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare(
        `INSERT INTO notifications (id, recipient_id, actor_id, kind, subject_type, subject_id, created_at)
         VALUES (?, ?, ?, ?, 'shared_list', ?, ?)`,
      ).bind(newNotificationId(), r.member_id, actor, kind, listId, nowIso),
    ),
  );
}

// ── POST /v1/shared-lists ───────────────────────────────────────────────────

sharedLists.post('/shared-lists', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('profileId');
  const nowIso = new Date().toISOString();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const name = validSharedListName((body as Record<string, unknown>)?.name);
  if (!name) return fail(c, 400, 'invalid_body', 'A list needs a name.');

  // COUNTED OVER LISTS THIS PERSON OWNS, not lists they are in. Somebody in
  // eleven of their friends' lists has cost nothing and is exactly the person
  // most likely to start one.
  const owned = await db
    .prepare('SELECT COUNT(*) AS n FROM shared_lists WHERE owner_id = ? AND deleted_at IS NULL')
    .bind(me)
    .first<{ n: number }>();
  if ((owned?.n ?? 0) >= FREE_SHARED_LISTS && !(await isPlus(db, me, nowIso))) {
    return fail(c, 403, 'plus_required', 'Starting another shared list needs OpenTV Plus.');
  }

  const id = newListId();
  const code = newInviteCode(crypto.getRandomValues(new Uint8Array(10)));

  await db.batch([
    db
      .prepare('INSERT INTO shared_lists (id, owner_id, name, invite_code, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, me, name, code, nowIso),
    db
      .prepare("INSERT INTO shared_list_members (list_id, member_id, role, joined_at) VALUES (?, ?, 'owner', ?)")
      .bind(id, me, nowIso),
  ]);

  return c.json({ id, name, invite_code: code, created_at: nowIso }, 201);
});

// ── GET /v1/shared-lists ────────────────────────────────────────────────────

/** Every list I am in, mine and other people's, newest activity first. */
sharedLists.get('/shared-lists', requireAuth, async (c) => {
  const me = c.get('profileId');
  const rows = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.owner_id, m.role,
            (SELECT COUNT(*) FROM shared_list_members x WHERE x.list_id = l.id) AS members,
            (SELECT COUNT(*) FROM shared_list_items i WHERE i.list_id = l.id)   AS items,
            (SELECT MAX(i.created_at) FROM shared_list_items i WHERE i.list_id = l.id) AS last_add
       FROM shared_list_members m
       JOIN shared_lists l ON l.id = m.list_id
      WHERE m.member_id = ? AND l.deleted_at IS NULL
      ORDER BY COALESCE(last_add, l.created_at) DESC`,
  )
    .bind(me)
    .all<{ id: string; name: string; owner_id: string; role: string; members: number; items: number; last_add: string | null }>();

  return c.json({
    lists: (rows.results ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      is_owner: r.owner_id === me,
      members: r.members,
      items: r.items,
      last_activity: r.last_add ?? null,
    })),
  });
});

// ── GET /v1/shared-lists/:id ────────────────────────────────────────────────

sharedLists.get('/shared-lists/:id', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('profileId');
  const id = c.req.param('id');

  const mine = await membership(db, id, me);
  // NOT FOUND, NOT FORBIDDEN. A 403 would confirm that a list with this id
  // exists, which is a fact about other people's business.
  if (!mine) return fail(c, 404, 'not_found', 'No such list.');

  const list = await db
    .prepare('SELECT id, owner_id, name, invite_code, created_at FROM shared_lists WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<ListRow>();
  if (!list) return fail(c, 404, 'not_found', 'No such list.');

  const [members, items, watched] = await Promise.all([
    db
      .prepare(
        `SELECT p.id, p.handle, p.display_name, p.avatar_key, p.is_plus, p.plus_until, m.role
           FROM shared_list_members m JOIN profiles p ON p.id = m.member_id
          WHERE m.list_id = ? AND p.deleted_at IS NULL
          ORDER BY m.joined_at`,
      )
      .bind(id)
      .all<{ id: string; handle: string; display_name: string | null; avatar_key: string | null; is_plus: number; plus_until: string | null; role: string }>(),
    db
      .prepare(
        `SELECT id, added_by, target_source, target_key, title, poster, created_at
           FROM shared_list_items WHERE list_id = ? ORDER BY created_at DESC`,
      )
      .bind(id)
      .all<{ id: string; added_by: string | null; target_source: string; target_key: string; title: string | null; poster: string | null; created_at: string }>(),
    db
      .prepare(
        `SELECT w.item_id, w.member_id FROM shared_list_watched w
           JOIN shared_list_items i ON i.id = w.item_id WHERE i.list_id = ?`,
      )
      .bind(id)
      .all<{ item_id: string; member_id: string }>(),
  ]);

  const ticks = watched.results ?? [];
  const nowIso = new Date().toISOString();

  return c.json({
    id: list.id,
    name: list.name,
    is_owner: list.owner_id === me,
    // ONLY THE OWNER SEES THE CODE. Anybody holding it can put a stranger in
    // the room, so it is not handed to every member as a matter of course.
    invite_code: list.owner_id === me ? list.invite_code : null,
    created_at: list.created_at,
    members: (members.results ?? []).map((m) => ({
      id: m.id,
      handle: m.handle,
      display_name: m.display_name,
      avatar_key: m.avatar_key,
      is_plus: plusOn(m, nowIso),
      role: m.role,
      is_me: m.id === me,
      watched: ticks.filter((t) => t.member_id === m.id).length,
    })),
    items: (items.results ?? []).map((i) => ({
      id: i.id,
      added_by: i.added_by,
      target_source: i.target_source,
      target_key: i.target_key,
      title: i.title,
      poster: i.poster,
      created_at: i.created_at,
      watched_by: ticks.filter((t) => t.item_id === i.id).map((t) => t.member_id),
    })),
  });
});

// ── POST /v1/shared-lists/join ──────────────────────────────────────────────

/** FREE, AT EVERY TIER, DELIBERATELY. See the note at the top of this file. */
sharedLists.post('/shared-lists/join', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('profileId');
  const nowIso = new Date().toISOString();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const code = normaliseInviteCode((body as Record<string, unknown>)?.code);
  if (!code) return fail(c, 400, 'invalid_body', 'That invite code is not valid.');

  const list = await db
    .prepare('SELECT id, owner_id, name FROM shared_lists WHERE invite_code = ? AND deleted_at IS NULL')
    .bind(code)
    .first<{ id: string; owner_id: string; name: string }>();
  if (!list) return fail(c, 404, 'not_found', 'That invite has expired or the list is gone.');

  const already = await membership(db, list.id, me);
  // NOT AN ERROR. Tapping a link twice, or a link somebody already accepted,
  // should land them in the list rather than tell them off.
  if (already) return c.json({ id: list.id, name: list.name, joined: false });

  const count = await db
    .prepare('SELECT COUNT(*) AS n FROM shared_list_members WHERE list_id = ?')
    .bind(list.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= SHARED_LIST_MAX_MEMBERS) {
    return fail(c, 409, 'list_full', 'This list is full.');
  }

  // A block in either direction stops this, the same way it stops a follow.
  const blocked = await db
    .prepare(
      `SELECT 1 AS one FROM blocks
        WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
    )
    .bind(me, list.owner_id, list.owner_id, me)
    .first<{ one: number }>();
  if (blocked) return fail(c, 403, 'blocked', 'You cannot join this list.');

  await db
    .prepare("INSERT INTO shared_list_members (list_id, member_id, role, joined_at) VALUES (?, ?, 'member', ?)")
    .bind(list.id, me, nowIso)
    .run();

  await notifyOthers(c.env, list.id, me, 'shared_list_join', nowIso);
  c.executionCtx.waitUntil(sendPush(c.env, list.owner_id, me, 'shared_list_join', list.id).catch(() => {}));

  return c.json({ id: list.id, name: list.name, joined: true }, 201);
});

// ── POST /v1/shared-lists/:id/items ─────────────────────────────────────────

sharedLists.post('/shared-lists/:id/items', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('profileId');
  const id = c.req.param('id');
  const nowIso = new Date().toISOString();

  if (!(await membership(db, id, me))) return fail(c, 404, 'not_found', 'No such list.');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const target = validSharedTarget(b.target_source, b.target_key);
  if (!target) return fail(c, 400, 'invalid_body', 'A show needs a TheTVDB id; a film needs a name.');

  const title = typeof b.title === 'string' ? b.title.trim().slice(0, 200) || null : null;
  const poster = typeof b.poster === 'string' ? b.poster.trim().slice(0, 500) || null : null;

  const count = await db
    .prepare('SELECT COUNT(*) AS n FROM shared_list_items WHERE list_id = ?')
    .bind(id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= SHARED_LIST_MAX_ITEMS) {
    return fail(c, 413, 'too_large', `A list holds at most ${SHARED_LIST_MAX_ITEMS} titles.`);
  }

  const itemId = newItemId();
  try {
    await db
      .prepare(
        `INSERT INTO shared_list_items
           (id, list_id, added_by, target_source, target_key, title, poster, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(itemId, id, me, target.source, target.key, title, poster, nowIso)
      .run();
  } catch {
    // The UNIQUE (list_id, source, key) constraint. Somebody adding a title
    // that is already there meant "this should be in the list", and it is.
    return c.json({ added: false, reason: 'already_here' });
  }

  await notifyOthers(c.env, id, me, 'shared_list_add', nowIso);

  return c.json({ added: true, id: itemId, created_at: nowIso }, 201);
});

// ── DELETE /v1/shared-lists/:id/items/:itemId ───────────────────────────────

sharedLists.delete('/shared-lists/:id/items/:itemId', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('profileId');
  const id = c.req.param('id');
  const itemId = c.req.param('itemId');

  const mine = await membership(db, id, me);
  if (!mine) return fail(c, 404, 'not_found', 'No such list.');

  // YOUR OWN, OR ANY OF THEM IF YOU OWN THE LIST. A member who could delete
  // everybody's suggestions is a member who can quietly empty the room.
  const res =
    mine.role === 'owner'
      ? await db.prepare('DELETE FROM shared_list_items WHERE id = ? AND list_id = ?').bind(itemId, id).run()
      : await db
          .prepare('DELETE FROM shared_list_items WHERE id = ? AND list_id = ? AND added_by = ?')
          .bind(itemId, id, me)
          .run();

  if (res.meta.changes === 0) return fail(c, 404, 'not_found', 'That is not yours to remove.');
  return c.json({ removed: true });
});

// ── POST/DELETE /v1/shared-lists/:id/items/:itemId/watched ──────────────────

sharedLists.post('/shared-lists/:id/items/:itemId/watched', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('profileId');
  const id = c.req.param('id');
  const itemId = c.req.param('itemId');
  const nowIso = new Date().toISOString();

  if (!(await membership(db, id, me))) return fail(c, 404, 'not_found', 'No such list.');

  const item = await db
    .prepare('SELECT id FROM shared_list_items WHERE id = ? AND list_id = ?')
    .bind(itemId, id)
    .first<{ id: string }>();
  if (!item) return fail(c, 404, 'not_found', 'No such item.');

  await db
    .prepare('INSERT OR IGNORE INTO shared_list_watched (item_id, member_id, watched_at) VALUES (?, ?, ?)')
    .bind(itemId, me, nowIso)
    .run();

  return c.json({ watched: true });
});

sharedLists.delete('/shared-lists/:id/items/:itemId/watched', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('profileId');
  const id = c.req.param('id');

  if (!(await membership(db, id, me))) return fail(c, 404, 'not_found', 'No such list.');

  await db
    .prepare('DELETE FROM shared_list_watched WHERE item_id = ? AND member_id = ?')
    .bind(c.req.param('itemId'), me)
    .run();

  return c.json({ watched: false });
});

// ── PATCH /v1/shared-lists/:id ──────────────────────────────────────────────

sharedLists.patch('/shared-lists/:id', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('profileId');
  const id = c.req.param('id');

  const mine = await membership(db, id, me);
  if (!mine) return fail(c, 404, 'not_found', 'No such list.');
  if (mine.role !== 'owner') return fail(c, 403, 'forbidden', 'Only the owner can change this list.');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;

  if ('name' in b) {
    const name = validSharedListName(b.name);
    if (!name) return fail(c, 400, 'invalid_body', 'A list needs a name.');
    await db.prepare('UPDATE shared_lists SET name = ? WHERE id = ?').bind(name, id).run();
  }

  // THE ONLY WAY BACK once a link has been forwarded to somebody it was not
  // meant for. Rotating kills every outstanding link at once, which is blunt
  // and is the point: there is no way to un-send a code.
  let code: string | null = null;
  if (b.rotate_invite === true) {
    code = newInviteCode(crypto.getRandomValues(new Uint8Array(10)));
    await db.prepare('UPDATE shared_lists SET invite_code = ? WHERE id = ?').bind(code, id).run();
  }

  return c.json({ ok: true, ...(code ? { invite_code: code } : {}) });
});

// ── DELETE /v1/shared-lists/:id ─────────────────────────────────────────────

/** The owner deletes the list; anybody else leaves it. One verb, because from
 *  the member's side both mean "this is no longer on my screen". */
sharedLists.delete('/shared-lists/:id', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('profileId');
  const id = c.req.param('id');
  const nowIso = new Date().toISOString();

  const mine = await membership(db, id, me);
  if (!mine) return fail(c, 404, 'not_found', 'No such list.');

  if (mine.role === 'owner') {
    // Soft, like profiles: a list is other people's memory too, and a hard
    // delete on a shared object cannot be undone for any of them.
    await db.prepare('UPDATE shared_lists SET deleted_at = ? WHERE id = ?').bind(nowIso, id).run();
    return c.json({ deleted: true });
  }

  await db
    .prepare('DELETE FROM shared_list_members WHERE list_id = ? AND member_id = ?')
    .bind(id, me)
    .run();
  // Their suggestions stay. A list that loses half its titles because somebody
  // left is a list that punishes the people still in it.
  return c.json({ left: true });
});
