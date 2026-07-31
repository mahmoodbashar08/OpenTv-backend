import { Hono } from 'hono';
import type { App, Env } from '@/env';
import { fail } from '@/http';
import {
  handlePrefixPattern,
  isPlus,
  normaliseHandle,
  USER_SEARCH_LIMIT,
  visibleProfileFields,
} from '@/pure';
import { optionalViewer } from '@/routes/comments';
import { edgePage } from '@/routes/follows';

/**
 * Public profiles and the lists hanging off them.
 * docs/IMPLEMENTATION.md Step 4, "GET /v1/profiles/:handle".
 *
 * Open routes: `requireAuth` is deliberately not mounted. A bearer, when one
 * is present, buys `followed_by_me`, the private-profile fields the viewer has
 * earned, and the block filter — and a bad token reads as anonymous rather
 * than 401ing a public page, exactly as the thread read does.
 *
 * DEVIATION, recorded because the plan is silent on it: a profile is 404 to
 * anyone it has blocked AND to anyone who has blocked it. 404 rather than 403
 * because 403 confirms the account exists, and a blocked person learning "yes,
 * they are still here, and yes, they blocked you" is precisely the interaction
 * a block is meant to end.
 */

export const profiles = new Hono<App>();

type ProfileReadRow = {
  id: string;
  handle: string;
  display_name: string | null;
  avatar_key: string | null;
  bio: string | null;
  is_private: number;
  links: string | null;
  plus_until: string | null;
  created_at: string;
  followers: number;
  following: number;
  comments: number;
  lists: number;
  followed_by_me: number;
  blocked: number;
};

function parseLinks(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Lookup is on `handle_lower`, ALWAYS — the handle a user types, or a friend
 * pastes into a chat, is not case-correct.
 *
 * The counts, `followed_by_me` and the block test all ride in the same
 * statement: a profile screen is one round trip or it is a spinner.
 */
async function readProfile(env: Env, handle: string, viewer: string): Promise<ProfileReadRow | null> {
  return env.DB.prepare(
    `SELECT p.id, p.handle, p.display_name, p.avatar_key, p.bio, p.is_private, p.links,
            p.plus_until, p.created_at,
            (SELECT COUNT(*) FROM follows f WHERE f.followee_id = p.id) AS followers,
            (SELECT COUNT(*) FROM follows f WHERE f.follower_id = p.id) AS following,
            (SELECT COUNT(*) FROM comments c
              WHERE c.author_id = p.id AND c.deleted_at IS NULL AND c.hidden_at IS NULL) AS comments,
            (SELECT COUNT(*) FROM lists l WHERE l.owner_id = p.id AND l.is_public = 1) AS lists,
            EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.followee_id = p.id) AS followed_by_me,
            EXISTS(SELECT 1 FROM blocks b
                   WHERE (b.blocker_id = ? AND b.blocked_id = p.id)
                      OR (b.blocker_id = p.id AND b.blocked_id = ?)) AS blocked
     FROM profiles p
     WHERE p.handle_lower = ? AND p.deleted_at IS NULL`,
  )
    .bind(viewer, viewer, viewer, normaliseHandle(handle))
    .first<ProfileReadRow>();
}

/** `lists` counts PUBLIC lists only — a private list must not be inferable from a number. */
function shapeProfile(row: ProfileReadRow, viewer: string, nowIso: string) {
  return visibleProfileFields(
    {
      id: row.id,
      handle: row.handle,
      display_name: row.display_name,
      avatar_key: row.avatar_key,
      bio: row.bio,
      is_private: row.is_private === 1,
      links: parseLinks(row.links),
      // A boolean, never the date (docs/IMPLEMENTATION.md Step 4).
      is_plus: isPlus(row.plus_until, nowIso),
      counts: {
        followers: row.followers,
        following: row.following,
        comments: row.comments,
        lists: row.lists,
      },
      followed_by_me: row.followed_by_me === 1,
      created_at: row.created_at,
    },
    row.followed_by_me === 1,
    row.id === viewer,
  );
}

/** Whether this viewer has earned the private side: themselves, or an accepted follower. */
function maySeeDetail(row: ProfileReadRow, viewer: string): boolean {
  return row.is_private === 0 || row.id === viewer || row.followed_by_me === 1;
}

// ── GET /v1/users?q= — find a person by handle ──────────────────────────────
//
// The one endpoint the app needs before anything social is usable: you cannot
// follow someone you cannot find, and until now the only way to reach a profile
// was to already know its exact handle.
//
// A PREFIX search, deliberately — see `handlePrefixPattern` for why `%q%` is not
// on the table and why the `_` in every placeholder handle has to be escaped.
// Display names are NOT searched: they are unvalidated free text, they are not
// indexed, and a search that matched them would be a table scan that also let
// someone find a private account by the name they chose for their friends.

type UserSearchRow = {
  id: string;
  handle: string;
  display_name: string | null;
  avatar_key: string | null;
  is_private: number;
};

profiles.get('/users', async (c) => {
  const pattern = handlePrefixPattern(new URL(c.req.url).searchParams.get('q'));
  if (!pattern) return fail(c, 400, 'invalid_body', 'q is required.');

  // Open route; the bearer is optional and buys only the block filter. A bad
  // token reads as anonymous rather than 401ing a public search.
  const viewer = await optionalViewer(c.env, c.req.header('Authorization'));

  const res = await c.env.DB.prepare(
    `SELECT p.id, p.handle, p.display_name, p.avatar_key, p.is_private
       FROM profiles p
      WHERE p.handle_lower LIKE ? ESCAPE '\\'
        AND p.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM blocks b
                        WHERE (b.blocker_id = ? AND b.blocked_id = p.id)
                           OR (b.blocker_id = p.id AND b.blocked_id = ?))
      ORDER BY p.handle_lower
      LIMIT ?`,
  )
    .bind(pattern, viewer, viewer, USER_SEARCH_LIMIT)
    .all<UserSearchRow>();

  // The shell only. A search result is a row in a list, not a profile — counts,
  // bio and links stay behind `GET /v1/profiles/:handle` and its privacy matrix.
  return c.json({
    items: (res.results ?? []).map((r) => ({
      id: r.id,
      handle: r.handle,
      display_name: r.display_name,
      avatar_key: r.avatar_key,
      is_private: r.is_private === 1,
    })),
  });
});

// ── GET /v1/profiles/:handle ────────────────────────────────────────────────

profiles.get('/profiles/:handle', async (c) => {
  const viewer = await optionalViewer(c.env, c.req.header('Authorization'));
  const row = await readProfile(c.env, c.req.param('handle'), viewer);

  // A soft-deleted profile is gone, not a tombstone.
  if (!row) return fail(c, 404, 'not_found', 'No such profile.');
  if (row.blocked === 1) return fail(c, 404, 'not_found', 'No such profile.');

  return c.json(shapeProfile(row, viewer, new Date().toISOString()));
});

// ── GET /v1/profiles/:handle/followers ──────────────────────────────────────

profiles.get('/profiles/:handle/followers', async (c) => {
  const viewer = await optionalViewer(c.env, c.req.header('Authorization'));
  const row = await readProfile(c.env, c.req.param('handle'), viewer);
  if (!row || row.blocked === 1) return fail(c, 404, 'not_found', 'No such profile.');

  // The same rule the counts follow: a private profile's follower list is part
  // of the detail, not part of the shell.
  if (!maySeeDetail(row, viewer)) return fail(c, 403, 'forbidden', 'This profile is private.');

  return c.json(
    await edgePage(
      c.env.DB,
      'followee_id',
      'follower_id',
      row.id,
      new URL(c.req.url).searchParams.get('cursor'),
    ),
  );
});

// ── GET /v1/profiles/:handle/lists ──────────────────────────────────────────

type ListRow = {
  id: string;
  name: string;
  description: string | null;
  is_public: number;
  created_at: string;
  item_count: number;
};

function shapeList(row: ListRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    is_public: row.is_public === 1,
    item_count: row.item_count,
    created_at: row.created_at,
  };
}

profiles.get('/profiles/:handle/lists', async (c) => {
  const viewer = await optionalViewer(c.env, c.req.header('Authorization'));
  const row = await readProfile(c.env, c.req.param('handle'), viewer);
  if (!row || row.blocked === 1) return fail(c, 404, 'not_found', 'No such profile.');
  if (!maySeeDetail(row, viewer)) return fail(c, 403, 'forbidden', 'This profile is private.');

  // Public lists only, even for the owner: this is the shop window, and an
  // owner who wants their drafts has `GET /v1/lists/:id` for each.
  const res = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.description, l.is_public, l.created_at,
            (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id) AS item_count
     FROM lists l
     WHERE l.owner_id = ? AND l.is_public = 1
     ORDER BY l.created_at DESC, l.id DESC`,
  )
    .bind(row.id)
    .all<ListRow>();

  return c.json({ items: (res.results ?? []).map(shapeList) });
});

// ── GET /v1/lists/:id ───────────────────────────────────────────────────────

type ListDetailRow = ListRow & {
  owner_id: string;
  handle: string;
  display_name: string | null;
  avatar_key: string | null;
  blocked: number;
};

profiles.get('/lists/:id', async (c) => {
  const viewer = await optionalViewer(c.env, c.req.header('Authorization'));

  const row = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.description, l.is_public, l.created_at, l.owner_id,
            p.handle, p.display_name, p.avatar_key,
            0 AS item_count,
            EXISTS(SELECT 1 FROM blocks b
                   WHERE (b.blocker_id = ? AND b.blocked_id = p.id)
                      OR (b.blocker_id = p.id AND b.blocked_id = ?)) AS blocked
     FROM lists l JOIN profiles p ON p.id = l.owner_id
     WHERE l.id = ? AND p.deleted_at IS NULL`,
  )
    .bind(viewer, viewer, c.req.param('id'))
    .first<ListDetailRow>();

  // Every refusal here is the same 404: a private list, a list belonging to a
  // deleted account, a list belonging to someone who blocked you and a list
  // that never existed must be indistinguishable, or the id space becomes an
  // oracle.
  if (!row || row.blocked === 1) return fail(c, 404, 'not_found', 'No such list.');
  if (row.is_public !== 1 && row.owner_id !== viewer) return fail(c, 404, 'not_found', 'No such list.');

  // Ordered by position, with the DENORMALISED title: rendering a list must
  // not require a metadata lookup, which is the entire reason `title` is
  // stored on the item.
  const items = await c.env.DB.prepare(
    `SELECT position, target_source, target_key, title
     FROM list_items WHERE list_id = ? ORDER BY position`,
  )
    .bind(row.id)
    .all<{ position: number; target_source: string; target_key: string; title: string | null }>();

  const results = items.results ?? [];
  return c.json({
    ...shapeList({ ...row, item_count: results.length }),
    owner: {
      id: row.owner_id,
      handle: row.handle,
      display_name: row.display_name,
      avatar_key: row.avatar_key,
    },
    items: results,
  });
});
