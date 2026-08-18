import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import { plusOn } from '@/pure';

/**
 * Lists two people build together.
 *
 * THE PAYWALL IS ON THE DOOR HANDLE, NOT THE DOOR. Past the first list,
 * STARTING one needs Plus. JOINING never does, at any tier, for ever — and that
 * is the design rather than a kindness: a list whose invitees must pay to
 * accept is a list of one person, and the member who paid has bought an empty
 * room. One subscription pulls three people into the app and they meet the
 * feature by using it.
 *
 * THE SERVER HOLDS THE TRUTH HERE, uniquely. Everywhere else it mirrors a
 * phone; two devices writing to one list means neither copy can be
 * authoritative without eating the other's edits. That stays inside the rule
 * the project rests on — a list two friends build together was never one
 * person's private history — and no route here touches anybody's library.
 */

export const sharedLists = new Hono<App>();

/** Past this, starting a new one is Plus. Joining is never capped. */
const FREE_OWNED_LISTS = 1;

const MAX_NAME = 60;
const MAX_ITEMS = 500;
const MAX_MEMBERS = 20;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * An invite code, and it is deliberately not a UUID.
 *
 * It gets read aloud, typed by hand, and put in a message. So: ten characters
 * from an alphabet with no 0/O and no 1/I/l, which are the pairs people
 * actually mistype. `crypto.getRandomValues` rather than Math.random because a
 * guessable code is a way into somebody's list.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** The caller's role on a list, or null when they are not in it at all. */
async function roleOf(db: D1Database, listId: string, me: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT m.role AS role FROM shared_list_members m
         JOIN shared_lists l ON l.id = m.list_id AND l.deleted_at IS NULL
        WHERE m.list_id = ? AND m.member_id = ?`,
    )
    .bind(listId, me)
    .first<{ role: string }>();
  return row?.role ?? null;
}

// ── GET /v1/shared-lists ────────────────────────────────────────────────────

sharedLists.get('/shared-lists', requireAuth, async (c) => {
  const me = c.get('profileId');
  const rows = await c.env.DB.prepare(
    `SELECT l.id, l.name, m.role,
            (SELECT COUNT(*) FROM shared_list_members x WHERE x.list_id = l.id) AS members,
            (SELECT COUNT(*) FROM shared_list_items i WHERE i.list_id = l.id) AS items,
            (SELECT MAX(i.created_at) FROM shared_list_items i WHERE i.list_id = l.id) AS last_activity
       FROM shared_list_members m
       JOIN shared_lists l ON l.id = m.list_id
      WHERE m.member_id = ? AND l.deleted_at IS NULL
      ORDER BY COALESCE(last_activity, l.created_at) DESC`,
  )
    .bind(me)
    .all<{ id: string; name: string; role: string; members: number; items: number; last_activity: string | null }>();

  return c.json({
    lists: (rows.results ?? []).map((r) => ({ ...r, is_owner: r.role === 'owner' })),
  });
});

// ── POST /v1/shared-lists ───────────────────────────────────────────────────

sharedLists.post('/shared-lists', requireAuth, async (c) => {
  const me = c.get('profileId');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const name = String((body as { name?: unknown })?.name ?? '').trim();
  if (!name || name.length > MAX_NAME) return fail(c, 400, 'invalid_body', 'A name is required.');

  /*
   * THE CAP IS ON LISTS THIS PERSON STARTED, never on lists they are in. A
   * member of nine lists who has started none is not near any limit.
   */
  const owned = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM shared_lists WHERE owner_id = ? AND deleted_at IS NULL",
  )
    .bind(me)
    .first<{ n: number }>();

  if ((owned?.n ?? 0) >= FREE_OWNED_LISTS) {
    const owner = await c.env.DB.prepare(
      'SELECT is_plus, plus_until FROM profiles WHERE id = ? AND deleted_at IS NULL',
    )
      .bind(me)
      .first<{ is_plus: number; plus_until: string | null }>();
    if (!owner) return fail(c, 401, 'unauthenticated', 'No such profile.');
    if (!plusOn(owner, new Date().toISOString())) {
      return fail(c, 403, 'plus_required', 'Starting another shared list needs OpenTV Plus.');
    }
  }

  const id = newId('sl');
  const code = newInviteCode();
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO shared_lists (id, owner_id, name, invite_code, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(id, me, name, code, now),
    // The owner is a MEMBER with role 'owner', so "who is in this list" is one
    // question with one answer everywhere it is asked.
    c.env.DB.prepare(
      "INSERT INTO shared_list_members (list_id, member_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
    ).bind(id, me, now),
  ]);

  return c.json({ id, invite_code: code });
});

// ── POST /v1/shared-lists/join ──────────────────────────────────────────────

sharedLists.post('/shared-lists/join', requireAuth, async (c) => {
  const me = c.get('profileId');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const code = String((body as { invite_code?: unknown })?.invite_code ?? '')
    .trim()
    .toUpperCase();
  if (!code) return fail(c, 400, 'invalid_body', 'An invite code is required.');

  const list = await c.env.DB.prepare(
    'SELECT id, name FROM shared_lists WHERE invite_code = ? AND deleted_at IS NULL',
  )
    .bind(code)
    .first<{ id: string; name: string }>();
  if (!list) return fail(c, 404, 'not_found', 'No list with that code.');

  const already = await roleOf(c.env.DB, list.id, me);
  // JOINING TWICE IS NOT AN ERROR. Somebody tapping a link they are already in
  // should land in the list, not on a message about it.
  if (already) return c.json({ id: list.id, name: list.name, joined: false });

  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM shared_list_members WHERE list_id = ?')
    .bind(list.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_MEMBERS) return fail(c, 403, 'forbidden', 'This list is full.');

  /*
   * NO PLUS CHECK, AND THERE NEVER WILL BE ONE. Charging to accept an invite
   * makes the paid feature a room with one person in it.
   */
  await c.env.DB.prepare(
    "INSERT INTO shared_list_members (list_id, member_id, role, joined_at) VALUES (?, ?, 'member', ?)",
  )
    .bind(list.id, me, new Date().toISOString())
    .run();

  return c.json({ id: list.id, name: list.name, joined: true });
});

// ── GET /v1/shared-lists/:id ────────────────────────────────────────────────

sharedLists.get('/shared-lists/:id', requireAuth, async (c) => {
  const me = c.get('profileId');
  const id = c.req.param('id');
  const role = await roleOf(c.env.DB, id, me);
  // A NON-MEMBER GETS 404, not 403: "you may not see this list" confirms the
  // list exists, and an invite code is the only thing that should reveal that.
  if (!role) return fail(c, 404, 'not_found', 'No such list.');

  const list = await c.env.DB.prepare('SELECT id, name, invite_code, created_at FROM shared_lists WHERE id = ?')
    .bind(id)
    .first<{ id: string; name: string; invite_code: string; created_at: string }>();
  if (!list) return fail(c, 404, 'not_found', 'No such list.');

  const members = await c.env.DB.prepare(
    `SELECT p.id, p.handle, p.display_name, p.avatar_key, p.is_plus, p.plus_until, m.role,
            (SELECT COUNT(*) FROM shared_list_watched w
               JOIN shared_list_items i ON i.id = w.item_id
              WHERE w.member_id = p.id AND i.list_id = ?) AS watched
       FROM shared_list_members m JOIN profiles p ON p.id = m.member_id
      WHERE m.list_id = ? AND p.deleted_at IS NULL
      ORDER BY m.joined_at ASC`,
  )
    .bind(id, id)
    .all<{
      id: string;
      handle: string;
      display_name: string | null;
      avatar_key: string | null;
      is_plus: number;
      plus_until: string | null;
      role: string;
      watched: number;
    }>();

  const items = await c.env.DB.prepare(
    `SELECT i.id, i.added_by, i.target_source, i.target_key, i.title, i.poster, i.created_at,
            (SELECT GROUP_CONCAT(w.member_id) FROM shared_list_watched w WHERE w.item_id = i.id) AS watched_by
       FROM shared_list_items i
      WHERE i.list_id = ?
      ORDER BY i.created_at DESC`,
  )
    .bind(id)
    .all<{
      id: string;
      added_by: string | null;
      target_source: string;
      target_key: string;
      title: string | null;
      poster: string | null;
      created_at: string;
      watched_by: string | null;
    }>();

  const nowIso = new Date().toISOString();
  return c.json({
    id: list.id,
    name: list.name,
    is_owner: role === 'owner',
    // THE CODE IS THE OWNER'S ALONE. It lets a stranger in, so a member who
    // was invited cannot hand that power on without the owner knowing.
    invite_code: role === 'owner' ? list.invite_code : null,
    created_at: list.created_at,
    members: (members.results ?? []).map((m) => ({
      id: m.id,
      handle: m.handle,
      display_name: m.display_name,
      avatar_key: m.avatar_key,
      is_plus: plusOn(m, nowIso),
      role: m.role,
      is_me: m.id === me,
      watched: m.watched,
    })),
    items: (items.results ?? []).map((i) => ({
      id: i.id,
      added_by: i.added_by,
      target_source: i.target_source,
      target_key: i.target_key,
      title: i.title,
      poster: i.poster,
      created_at: i.created_at,
      watched_by: i.watched_by ? i.watched_by.split(',') : [],
    })),
  });
});

// ── POST /v1/shared-lists/:id/items ─────────────────────────────────────────

sharedLists.post('/shared-lists/:id/items', requireAuth, async (c) => {
  const me = c.get('profileId');
  const id = c.req.param('id');
  // EVERY MEMBER ADDS. A shared list where only the owner may write is a
  // published list with extra steps.
  if (!(await roleOf(c.env.DB, id, me))) return fail(c, 404, 'not_found', 'No such list.');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const source = String(b.target_source ?? '');
  const key = String(b.target_key ?? '').trim();
  if (!['tvdb', 'tmdb', 'title', 'movie'].includes(source) || !key) {
    return fail(c, 400, 'target_invalid', 'target_source and target_key are required.');
  }

  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM shared_list_items WHERE list_id = ?')
    .bind(id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_ITEMS) return fail(c, 403, 'forbidden', 'This list is full.');

  /*
   * INSERT OR IGNORE against the (list, source, key) unique index. Two people
   * adding the same film within a second of each other is a thing that
   * happens, and it must not be an error for either of them — `added` says
   * which one actually put it there.
   */
  const res = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO shared_list_items (id, list_id, added_by, target_source, target_key, title, poster, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId('si'),
      id,
      me,
      source,
      key,
      typeof b.title === 'string' ? b.title.slice(0, 200) : null,
      typeof b.poster === 'string' ? b.poster.slice(0, 300) : null,
      new Date().toISOString(),
    )
    .run();

  return c.json({ added: (res.meta.changes ?? 0) > 0 });
});

// ── DELETE /v1/shared-lists/:id/items/:itemId ───────────────────────────────

sharedLists.delete('/shared-lists/:id/items/:itemId', requireAuth, async (c) => {
  const me = c.get('profileId');
  const id = c.req.param('id');
  const role = await roleOf(c.env.DB, id, me);
  if (!role) return fail(c, 404, 'not_found', 'No such list.');

  /*
   * REMOVE YOUR OWN, OR ANYTHING IF YOU OWN THE LIST. A member deleting
   * somebody else's suggestion is the argument this feature does not need;
   * the owner clearing up their own list is housekeeping.
   */
  const item = await c.env.DB.prepare('SELECT added_by FROM shared_list_items WHERE id = ? AND list_id = ?')
    .bind(c.req.param('itemId'), id)
    .first<{ added_by: string | null }>();
  if (!item) return fail(c, 404, 'not_found', 'No such item.');
  if (role !== 'owner' && item.added_by !== me) {
    return fail(c, 403, 'forbidden', 'Only the person who added this, or the list owner, can remove it.');
  }

  await c.env.DB.prepare('DELETE FROM shared_list_items WHERE id = ? AND list_id = ?')
    .bind(c.req.param('itemId'), id)
    .run();
  return c.json({ ok: true });
});

// ── POST/DELETE /v1/shared-lists/:id/items/:itemId/watched ──────────────────

sharedLists.post('/shared-lists/:id/items/:itemId/watched', requireAuth, async (c) => {
  const me = c.get('profileId');
  const id = c.req.param('id');
  if (!(await roleOf(c.env.DB, id, me))) return fail(c, 404, 'not_found', 'No such list.');

  const item = await c.env.DB.prepare('SELECT id FROM shared_list_items WHERE id = ? AND list_id = ?')
    .bind(c.req.param('itemId'), id)
    .first<{ id: string }>();
  if (!item) return fail(c, 404, 'not_found', 'No such item.');

  // Ticking twice is not an error; it is two taps with one meaning.
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO shared_list_watched (item_id, member_id, marked_at) VALUES (?, ?, ?)',
  )
    .bind(item.id, me, new Date().toISOString())
    .run();
  return c.json({ ok: true });
});

sharedLists.delete('/shared-lists/:id/items/:itemId/watched', requireAuth, async (c) => {
  const me = c.get('profileId');
  const id = c.req.param('id');
  if (!(await roleOf(c.env.DB, id, me))) return fail(c, 404, 'not_found', 'No such list.');
  // ONLY YOUR OWN TICK. There is no route by which one member unticks another,
  // because "have you seen this" is not a question anybody else may answer.
  await c.env.DB.prepare(
    `DELETE FROM shared_list_watched
      WHERE member_id = ? AND item_id IN (SELECT id FROM shared_list_items WHERE id = ? AND list_id = ?)`,
  )
    .bind(me, c.req.param('itemId'), id)
    .run();
  return c.json({ ok: true });
});

// ── PATCH /v1/shared-lists/:id ──────────────────────────────────────────────

sharedLists.patch('/shared-lists/:id', requireAuth, async (c) => {
  const me = c.get('profileId');
  const id = c.req.param('id');
  // OWNER ONLY. Renaming a list under the people in it, or invalidating an
  // invite they are holding, are both the owner's to do.
  if ((await roleOf(c.env.DB, id, me)) !== 'owner') return fail(c, 404, 'not_found', 'No such list.');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;

  if (b.rotate_invite === true) {
    const code = newInviteCode();
    await c.env.DB.prepare('UPDATE shared_lists SET invite_code = ? WHERE id = ?').bind(code, id).run();
    return c.json({ invite_code: code });
  }

  if (typeof b.name === 'string') {
    const name = b.name.trim();
    if (!name || name.length > MAX_NAME) return fail(c, 400, 'invalid_body', 'A name is required.');
    await c.env.DB.prepare('UPDATE shared_lists SET name = ? WHERE id = ?').bind(name, id).run();
    return c.json({ ok: true });
  }

  return fail(c, 400, 'invalid_body', 'Nothing to change.');
});

// ── DELETE /v1/shared-lists/:id ─────────────────────────────────────────────

sharedLists.delete('/shared-lists/:id', requireAuth, async (c) => {
  const me = c.get('profileId');
  const id = c.req.param('id');
  const role = await roleOf(c.env.DB, id, me);
  if (!role) return fail(c, 404, 'not_found', 'No such list.');

  /*
   * ONE ROUTE, TWO MEANINGS, because from the caller's side both are "this is
   * off my screen now". The owner deletes the list; everybody else leaves it.
   *
   * Soft delete for the owner: the rows stay, so a list is recoverable by hand
   * if somebody deletes one in the wrong moment. Leaving is a hard delete of
   * one membership row — there is nothing to recover and nothing shared about
   * it.
   */
  if (role === 'owner') {
    await c.env.DB.prepare('UPDATE shared_lists SET deleted_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), id)
      .run();
  } else {
    await c.env.DB.prepare('DELETE FROM shared_list_members WHERE list_id = ? AND member_id = ?')
      .bind(id, me)
      .run();
  }
  return c.json({ ok: true });
});
