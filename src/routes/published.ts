import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import { chunk, D1_MAX_BOUND_PARAMS, isTargetSource, listId, numberOrNull } from '@/pure';
import { optionalViewer } from '@/routes/comments';

/**
 * The published half of a profile: how much someone has watched, and what.
 *
 * WHY IT EXISTS. Another person's profile was a name, a follower count and a
 * shelf of lists, because the server held no history at all. The design
 * (design/referance/51-user-profile-sarah.png) is mostly history — TV time,
 * episodes watched, their shows, their films, their favourites — so those
 * shelves had nothing to draw.
 *
 * WHAT IS PUBLISHED IS A SUMMARY, NOT A HISTORY. There is deliberately no row
 * anywhere recording that a particular episode was watched on a particular
 * date: that is the thing that would let a reader reconstruct somebody's
 * evenings, and it stays on the phone. What goes up is two totals and a list of
 * titles — exactly what the shelves render and nothing more.
 *
 * IT IS DERIVED AND DISPOSABLE. The phone recomputes all of it from its own
 * database and replaces what is here. Nothing on this server is authoritative,
 * there is no reconciliation job, and losing the lot costs one sync.
 */

export const published = new Hono<App>();

/** One request replaces one kind's shelf. Chosen so 250 titles stay inside the
 *  100-parameter ceiling at 9 binds each — see `TITLE_BINDS`. */
export const PUBLISH_MAX_TITLES = 250;

/**
 * Columns bound per title row, and how many rows fit in one statement.
 *
 * DERIVED, NOT GUESSED. D1 binds at most 100 parameters per query, and a guess
 * is exactly how the aggregate list form shipped a 500 that only appeared above
 * twenty-five targets. Every column is bound — including `profile_id` and
 * `kind`, which are constant for the whole request and were briefly inlined
 * into the SQL text to save two binds. That saved nothing worth having and put
 * two values into a statement string, which is where injections come from.
 */
const TITLE_BINDS = 9;
const TITLES_PER_STATEMENT = Math.floor(D1_MAX_BOUND_PARAMS / TITLE_BINDS);

type TitleInput = {
  target_source: string;
  target_key: string;
  name?: unknown;
  poster?: unknown;
  favourite?: unknown;
  rank?: unknown;
  fav_rank?: unknown;
};

// ── PUT /v1/me/published — replace my summary ───────────────────────────────

published.put('/me/published', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const kind = b.kind;
  if (kind !== 'show' && kind !== 'movie') {
    return fail(c, 400, 'invalid_body', 'kind must be "show" or "movie".');
  }
  if (!Array.isArray(b.titles)) return fail(c, 400, 'invalid_body', 'titles must be an array.');
  if (b.titles.length > PUBLISH_MAX_TITLES) {
    return fail(c, 413, 'too_large', `At most ${PUBLISH_MAX_TITLES} titles per request.`);
  }

  const me = c.get('profileId');
  const db = c.env.DB;
  const nowIso = new Date().toISOString();

  const rows: {
    source: string;
    key: string;
    name: string | null;
    poster: string | null;
    favourite: number;
    rank: number | null;
    favRank: number | null;
  }[] = [];
  for (const raw of b.titles as TitleInput[]) {
    if (!raw || typeof raw !== 'object') continue;
    if (!isTargetSource(raw.target_source)) continue;
    if (typeof raw.target_key !== 'string' || raw.target_key.length === 0) continue;
    const rank = numberOrNull(raw.rank);
    const favRank = numberOrNull(raw.fav_rank);
    rows.push({
      source: raw.target_source,
      key: raw.target_key,
      name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name.slice(0, 200) : null,
      poster: typeof raw.poster === 'string' && raw.poster.length > 0 ? raw.poster.slice(0, 500) : null,
      favourite: raw.favourite === true || raw.favourite === 1 ? 1 : 0,
      rank: rank === undefined ? null : rank,
      favRank: favRank === undefined ? null : favRank,
    });
  }

  // REPLACE, not merge. A shelf is the whole truth about one kind at one
  // moment: a title unfollowed on the phone has to disappear here, and a merge
  // could only ever grow. The delete and the inserts go in one batch so a
  // crash cannot leave the shelf empty.
  const statements = [
    db.prepare('DELETE FROM profile_titles WHERE profile_id = ? AND kind = ?').bind(me, kind),
    ...chunk(rows, TITLES_PER_STATEMENT).map((group) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO profile_titles
             (profile_id, kind, target_source, target_key, name, poster, favourite, rank, fav_rank)
           VALUES ${group.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        )
        .bind(
          ...group.flatMap((r) => [me, kind, r.source, r.key, r.name, r.poster, r.favourite, r.rank, r.favRank]),
        ),
    ),
  ];
  await db.batch(statements);

  // The totals ride along with the shelf they belong to, so a profile is never
  // showing counts from one sync and titles from another.
  const stats = (b.stats ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  await db
    .prepare(
      `INSERT INTO profile_stats
         (profile_id, episodes_watched, minutes_watched, movie_minutes, shows_count, movies_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (profile_id) DO UPDATE SET
         episodes_watched = excluded.episodes_watched,
         minutes_watched  = excluded.minutes_watched,
         movie_minutes    = excluded.movie_minutes,
         shows_count      = CASE WHEN ? = 'show'  THEN excluded.shows_count  ELSE profile_stats.shows_count  END,
         movies_count     = CASE WHEN ? = 'movie' THEN excluded.movies_count ELSE profile_stats.movies_count END,
         updated_at       = excluded.updated_at`,
    )
    .bind(
      me,
      n(stats.episodes_watched),
      n(stats.minutes_watched),
      n(stats.movie_minutes),
      kind === 'show' ? rows.length : 0,
      kind === 'movie' ? rows.length : 0,
      nowIso,
      kind,
      kind,
    )
    .run();

  return c.json({ ok: true, kind, titles: rows.length });
});

// ── GET /v1/profiles/:handle/published ──────────────────────────────────────

type ShelfRow = {
  kind: string;
  target_source: string;
  target_key: string;
  name: string | null;
  poster: string | null;
  favourite: number;
  rank: number | null;
  fav_rank: number | null;
};

published.get('/profiles/:handle/published', async (c) => {
  const viewer = await optionalViewer(c.env, c.req.header('Authorization'));
  const db = c.env.DB;

  // The same visibility rules the rest of a profile follows, in one statement:
  // a deleted account, or a block in either direction, is a 404 — never a 403,
  // which would confirm the account exists.
  const owner = await db
    .prepare(
      `SELECT p.id, p.is_private,
              EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.followee_id = p.id) AS followed_by_me,
              EXISTS(SELECT 1 FROM blocks b
                     WHERE (b.blocker_id = ? AND b.blocked_id = p.id)
                        OR (b.blocker_id = p.id AND b.blocked_id = ?)) AS blocked
         FROM profiles p
        WHERE p.handle_lower = ? AND p.deleted_at IS NULL`,
    )
    .bind(viewer, viewer, viewer, (c.req.param('handle') ?? '').toLowerCase())
    .first<{ id: string; is_private: number; followed_by_me: number; blocked: number }>();

  if (!owner || owner.blocked === 1) return fail(c, 404, 'not_found', 'No such profile.');
  const maySee = owner.is_private === 0 || owner.id === viewer || owner.followed_by_me === 1;
  if (!maySee) return fail(c, 403, 'forbidden', 'This profile is private.');

  const stats = await db
    .prepare(
      `SELECT episodes_watched, minutes_watched, movie_minutes, shows_count, movies_count, updated_at
         FROM profile_stats WHERE profile_id = ?`,
    )
    .bind(owner.id)
    .first<{
      episodes_watched: number;
      minutes_watched: number;
      movie_minutes: number;
      shows_count: number;
      movies_count: number;
      updated_at: string;
    }>();

  // THE OWNER'S ORDER, and nothing else's. `favourite DESC` used to come
  // first, which reordered every shelf around a flag the shelf is not sorted
  // by — so a public profile listed the same titles as the owner's own screen
  // in a different order. Unranked rows fall to the end by name, so a shelf
  // published before ranks existed is still stable rather than whatever SQLite
  // felt like returning.
  const res = await db
    .prepare(
      `SELECT kind, target_source, target_key, name, poster, favourite, rank, fav_rank
         FROM profile_titles
        WHERE profile_id = ?
        ORDER BY kind, rank IS NULL, rank, name`,
    )
    .bind(owner.id)
    .all<ShelfRow>();

  const shape = (r: ShelfRow) => ({
    target_source: r.target_source,
    target_key: r.target_key,
    name: r.name,
    poster: r.poster,
    favourite: r.favourite === 1,
    // Sent so the client can order the FAVOURITES shelf on its own terms —
    // the owner's drag order, which is not the main shelf's order.
    fav_rank: r.fav_rank,
  });
  const all = res.results ?? [];

  return c.json({
    // Null rather than zeroes when nothing has been published: a profile that
    // has never synced must render as "no stats yet", not as somebody who has
    // watched nothing.
    stats: stats
      ? {
          episodes_watched: stats.episodes_watched,
          minutes_watched: stats.minutes_watched,
          movie_minutes: stats.movie_minutes,
          shows_count: stats.shows_count,
          movies_count: stats.movies_count,
          updated_at: stats.updated_at,
        }
      : null,
    shows: all.filter((r) => r.kind === 'show').map(shape),
    movies: all.filter((r) => r.kind === 'movie').map(shape),
  });
});

// ── POST /v1/published/lists ────────────────────────────────────────────────

/** A profile is a shelf, not an archive: enough to browse, not a full library. */
export const PUBLISH_MAX_LISTS = 50;
export const PUBLISH_MAX_LIST_ITEMS = 200;

type ListInput = {
  name?: unknown;
  description?: unknown;
  items?: unknown;
};

type ListItemInput = {
  target_source?: unknown;
  target_key?: unknown;
  title?: unknown;
  poster?: unknown;
};

/**
 * Publish the owner's lists — the band a public profile has never been able to
 * draw.
 *
 * THE TABLES HAVE ALWAYS BEEN HERE, and so has the reading: `/profiles/:handle/
 * lists`, `/lists/:id`, the client functions and the screen. Nothing ever wrote
 * them, so every profile showed no lists and the section simply did not appear.
 *
 * REPLACE, not merge — the same rule the title shelves follow. The phone sends
 * the lists it wants public and this becomes the whole truth; a list deleted or
 * hidden on the phone has to vanish here, and a merge could only ever grow.
 *
 * PRIVACY IS THE PHONE'S DECISION. Anything marked "Hide from profile" is never
 * sent, so there is nothing here to leak. `is_public` is written 1 for what
 * arrives, because arriving IS the act of publishing it.
 */
published.post('/published/lists', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(b.lists)) return fail(c, 400, 'invalid_body', 'lists must be an array.');
  if (b.lists.length > PUBLISH_MAX_LISTS) {
    return fail(c, 413, 'too_large', `At most ${PUBLISH_MAX_LISTS} lists per request.`);
  }

  const me = c.get('profileId');
  const db = c.env.DB;
  const nowIso = new Date().toISOString();

  const lists: { id: string; name: string; description: string | null; items: {
    source: string; key: string; title: string | null; poster: string | null;
  }[] }[] = [];

  for (const raw of b.lists as ListInput[]) {
    if (!raw || typeof raw !== 'object') continue;
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) : '';
    if (name.length === 0) continue;

    const items: { source: string; key: string; title: string | null; poster: string | null }[] = [];
    if (Array.isArray(raw.items)) {
      for (const it of (raw.items as ListItemInput[]).slice(0, PUBLISH_MAX_LIST_ITEMS)) {
        if (!it || typeof it !== 'object') continue;
        if (!isTargetSource(it.target_source)) continue;
        if (typeof it.target_key !== 'string' || it.target_key.length === 0) continue;
        items.push({
          source: it.target_source,
          key: it.target_key,
          title: typeof it.title === 'string' && it.title.length > 0 ? it.title.slice(0, 200) : null,
          poster: typeof it.poster === 'string' && it.poster.length > 0 ? it.poster.slice(0, 500) : null,
        });
      }
    }

    // DERIVED from the owner and the name, not random: re-publishing must land
    // on the same id, or every sync would hand a reader a new URL for a list
    // they already had open.
    lists.push({ id: listId(me, name), name, description: null, items });
  }

  const statements = [
    db.prepare('DELETE FROM list_items WHERE list_id IN (SELECT id FROM lists WHERE owner_id = ?)').bind(me),
    db.prepare('DELETE FROM lists WHERE owner_id = ?').bind(me),
  ];
  lists.forEach((l, position) => {
    // POSITION IS THE ARRAY ORDER the phone sent. The owner arranged them; this
    // is the only place that arrangement can reach anybody else.
    statements.push(
      db
        .prepare(
          `INSERT INTO lists (id, owner_id, name, description, is_public, created_at, position)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(l.id, me, l.name, l.description, nowIso, position),
    );
    l.items.forEach((it, i) => {
      statements.push(
        db
          .prepare(
            `INSERT INTO list_items (list_id, position, target_source, target_key, title, poster)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(l.id, i, it.source, it.key, it.title, it.poster),
      );
    });
  });

  await db.batch(statements);
  return c.json({ lists: lists.length });
});
