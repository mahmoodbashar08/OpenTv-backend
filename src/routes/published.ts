import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import { chunk, D1_MAX_BOUND_PARAMS, isTargetSource, numberOrNull } from '@/pure';
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
 *  100-parameter ceiling at 6 binds each — see `TITLE_BINDS`. */
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
const TITLE_BINDS = 8;
const TITLES_PER_STATEMENT = Math.floor(D1_MAX_BOUND_PARAMS / TITLE_BINDS);

type TitleInput = {
  target_source: string;
  target_key: string;
  name?: unknown;
  poster?: unknown;
  favourite?: unknown;
  rank?: unknown;
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
  }[] = [];
  for (const raw of b.titles as TitleInput[]) {
    if (!raw || typeof raw !== 'object') continue;
    if (!isTargetSource(raw.target_source)) continue;
    if (typeof raw.target_key !== 'string' || raw.target_key.length === 0) continue;
    const rank = numberOrNull(raw.rank);
    rows.push({
      source: raw.target_source,
      key: raw.target_key,
      name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name.slice(0, 200) : null,
      poster: typeof raw.poster === 'string' && raw.poster.length > 0 ? raw.poster.slice(0, 500) : null,
      favourite: raw.favourite === true || raw.favourite === 1 ? 1 : 0,
      rank: rank === undefined ? null : rank,
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
             (profile_id, kind, target_source, target_key, name, poster, favourite, rank)
           VALUES ${group.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        )
        .bind(...group.flatMap((r) => [me, kind, r.source, r.key, r.name, r.poster, r.favourite, r.rank])),
    ),
  ];
  await db.batch(statements);

  // The totals ride along with the shelf they belong to, so a profile is never
  // showing counts from one sync and titles from another.
  const stats = (b.stats ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  await db
    .prepare(
      `INSERT INTO profile_stats (profile_id, episodes_watched, minutes_watched, shows_count, movies_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (profile_id) DO UPDATE SET
         episodes_watched = excluded.episodes_watched,
         minutes_watched  = excluded.minutes_watched,
         shows_count      = CASE WHEN ? = 'show'  THEN excluded.shows_count  ELSE profile_stats.shows_count  END,
         movies_count     = CASE WHEN ? = 'movie' THEN excluded.movies_count ELSE profile_stats.movies_count END,
         updated_at       = excluded.updated_at`,
    )
    .bind(
      me,
      n(stats.episodes_watched),
      n(stats.minutes_watched),
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
      `SELECT episodes_watched, minutes_watched, shows_count, movies_count, updated_at
         FROM profile_stats WHERE profile_id = ?`,
    )
    .bind(owner.id)
    .first<{
      episodes_watched: number;
      minutes_watched: number;
      shows_count: number;
      movies_count: number;
      updated_at: string;
    }>();

  // Favourites first, then the owner's order, then by name — a shelf with no
  // ranks is still stable rather than whatever SQLite felt like returning.
  const res = await db
    .prepare(
      `SELECT kind, target_source, target_key, name, poster, favourite, rank
         FROM profile_titles
        WHERE profile_id = ?
        ORDER BY kind, favourite DESC, rank IS NULL, rank, name`,
    )
    .bind(owner.id)
    .all<ShelfRow>();

  const shape = (r: ShelfRow) => ({
    target_source: r.target_source,
    target_key: r.target_key,
    name: r.name,
    poster: r.poster,
    favourite: r.favourite === 1,
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
          shows_count: stats.shows_count,
          movies_count: stats.movies_count,
          updated_at: stats.updated_at,
        }
      : null,
    shows: all.filter((r) => r.kind === 'show').map(shape),
    movies: all.filter((r) => r.kind === 'movie').map(shape),
  });
});
