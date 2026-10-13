import { Hono } from 'hono';
import type { App } from '@/env';
import { requireAuth } from '@/middleware';
import { plusOn } from '@/pure';

/**
 * The friends feed — `GET /v1/me/feed` (2.0.0, feature 1; DESIGN-community §1).
 *
 * What the people I follow did in the app, newest first: rated or felt
 * something about an episode, a show or a film, wrote a comment, picked a
 * favourite character. Read on demand from the tables those things already
 * live in (fan-out-on-read); nothing new is written anywhere.
 *
 * WHAT IT CANNOT SAY, AND WHY THAT IS THE POINT. There is no watch-history
 * table on this server, so the feed cannot say "sara watched S2E5" and never
 * pretends to. It returns the same payload whatever the reader has watched; the
 * PHONE decides, against its own `watches` table, which cards to lock. The
 * request carries nothing about the reader's progress. The lock protects the
 * reader from spoilers, not the content from the reader — somebody who edits
 * their own client only spoils themselves.
 *
 * EVERY RULE IS A REUSED ONE:
 *  - only `state = 'accepted'` follows: a pending request to a private profile
 *    shows nothing, as in every other follow read;
 *  - blocks need nothing here: `routes/blocks.ts` deletes the follow edges both
 *    ways in the block's own batch, and `routes/follows.ts` refuses a new one;
 *  - `imported_at IS NULL`: the archive is "archive, not activity" (0029), so a
 *    member seeding seven years of TV Time does not fill every follower's feed
 *    with 8,000 cards dated today;
 *  - comments carry the thread read's own `deleted_at`/`hidden_at` predicates;
 *  - an actor who is deleted, never joined (0049) or switched off
 *    "Show my reactions to followers" (hidden section `'feed'`, D6) is left out
 *    of the friend set itself, so a page is never short because rows were
 *    dropped after the LIMIT.
 *
 * Reactions only (D7): no "added The Bear to their shows" cards.
 *
 * ── D1 ROWS READ PER CALL ───────────────────────────────────────────────────
 * F = accepted follows (typical 15), E = friends' live events inside the window.
 *
 *   reader probe (profile PK + first follows row)        2
 *   friend set, ×3 statements (follows + profile PK)     6F ≈ 90
 *   three partial-index ranges (0055)                   E    (the cost)
 *   feelings per rating row (emotion_votes PK prefix)   ≤ 12 per rating
 *   comment_images per comment row (PK)                 1 per comment
 *   actor shells (PK, ≤ limit ids)                      ≤ 50
 *
 * Cold, 7-day floor, 3 live events per friend a day: E ≈ 315, so ~470 rows.
 * A `since` refresh: ~90 + the handful of new events ≈ 110. A non-member, or a
 * member who follows nobody, costs the 2-row probe and nothing else. With the
 * phone's 60 s throttle and its 100-item delta cache, five opens a day is
 * ~900 rows per reader per day. Writes: none.
 *
 * `ponytail: fan-out-on-read; a 30-day activity table written alongside
 * comments/ratings/votes only if the dashboard shows the feed above ~1.5M
 * rows/day (DESIGN §1.6). The window floor below is the first knob.`
 */
export const feed = new Hono<App>();

/** D4. The single biggest rows-read knob: every friend's events inside it are read. */
export const FEED_WINDOW_DAYS = 7;
export const FEED_PAGE_DEFAULT = 30;
export const FEED_PAGE_MAX = 50;

/**
 * The people whose events this reader may see, as a fragment bound with (me).
 *
 * THE FILTERS LIVE HERE, NOT AFTER THE QUERY. Dropping a hidden or deleted
 * actor's rows after the LIMIT would hand back a short page and a null cursor
 * while older visible events still existed. Filtering the friend set costs one
 * profile PK probe per friend per statement and makes every row that comes back
 * a row that is shown.
 *
 * `instr` rather than parsing: `hidden_sections` is only ever written by
 * `validateHiddenSections`, a JSON array of keys from a closed set, so `"feed"`
 * with its quotes appears in it exactly when the key does.
 */
const FRIENDS = `SELECT f.followee_id FROM follows f JOIN profiles p ON p.id = f.followee_id
   WHERE f.follower_id = ? AND f.state = 'accepted'
     AND p.deleted_at IS NULL AND p.joined_at IS NOT NULL
     AND instr(COALESCE(p.hidden_sections, ''), '"feed"') = 0`;

/*
 * THE THREE STATEMENTS, each bound with (me, after, before, limit).
 *
 * `INDEXED BY` IS LOAD-BEARING. Asked plainly, SQLite prefers the 0029
 * `*_activity (imported_at, created_at)` indexes — equality on `imported_at`
 * plus a range on `created_at` looks cheap — and that plan walks EVERY member's
 * live events in the week and only then asks whether the author is a friend:
 * the whole community's activity, read on every pull-to-refresh. Pinned to the
 * 0055 per-author indexes, a call reads only the friends' own ranges.
 * `test/feed.test.ts` checks the plan, so dropping an index fails a test
 * instead of a budget.
 */
/** Ratings and feelings. A feeling-only vote is a ratings row with score NULL
 *  (routes/ratings.ts deletes the row only when nothing is left), so one
 *  statement covers both; the feelings are probed by emotion_votes' own PK. */
export const FEED_RATINGS_SQL = `SELECT r.id, r.author_id, r.target_source, r.target_key, r.season, r.episode, r.score, r.created_at,
       (SELECT GROUP_CONCAT(e.emotion) FROM emotion_votes e
         WHERE e.author_id = r.author_id AND e.target_source = r.target_source
           AND e.target_key = r.target_key
           AND e.season = COALESCE(r.season, -1) AND e.episode = COALESCE(r.episode, -1)) AS emotions
  FROM ratings r INDEXED BY idx_ratings_author_live
 WHERE r.author_id IN (${FRIENDS})
   AND r.imported_at IS NULL AND r.created_at > ? AND r.created_at < ?
 ORDER BY r.created_at DESC LIMIT ?`;

/** The thread read's predicates. `substr` so a long comment costs 280
 *  characters on the wire; `has_image` only for a CLEARED picture, as
 *  everywhere else a picture is served. */
export const FEED_COMMENTS_SQL = `SELECT c.id, c.author_id, c.target_source, c.target_key, c.season, c.episode,
       substr(c.body, 1, 280) AS body, c.is_spoiler, c.parent_id IS NOT NULL AS is_reply,
       c.created_at, (ci.scan_status = 'clean') AS has_image
  FROM comments c INDEXED BY idx_comments_author_live
  LEFT JOIN comment_images ci ON ci.comment_id = c.id
 WHERE c.author_id IN (${FRIENDS})
   AND c.imported_at IS NULL AND c.deleted_at IS NULL AND c.hidden_at IS NULL
   AND c.created_at > ? AND c.created_at < ?
 ORDER BY c.created_at DESC LIMIT ?`;

export const FEED_CHARACTERS_SQL = `SELECT v.id, v.voter_id AS author_id, v.target_source, v.target_key, v.season, v.episode,
       v.character_name, v.created_at
  FROM character_votes v INDEXED BY idx_character_votes_voter_live
 WHERE v.voter_id IN (${FRIENDS})
   AND v.imported_at IS NULL AND v.created_at > ? AND v.created_at < ?
 ORDER BY v.created_at DESC LIMIT ?`;

type Actor = {
  id: string;
  handle: string;
  display_name: string | null;
  avatar_key: string | null;
  is_plus: number;
  plus_until: string | null;
};

type Target = {
  author_id: string;
  target_source: string;
  target_key: string;
  season: number | null;
  episode: number | null;
  created_at: string;
};

type RatingRow = Target & { id: string; score: number | null; emotions: string | null };
type CommentRow = Target & {
  id: string;
  body: string;
  is_spoiler: number;
  is_reply: number;
  has_image: number | null;
};
type CharacterRow = Target & { id: string; character_name: string };

/** An ISO instant, normalised so it compares as a string against `created_at`, or null. */
function instant(raw: string | null | undefined): string | null {
  if (raw == null || raw === '') return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function feedLimit(raw: string | null | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return FEED_PAGE_DEFAULT;
  return Math.min(n, FEED_PAGE_MAX);
}

feed.get('/me/feed', requireAuth, async (c) => {
  const db = c.env.DB;
  const me = c.get('profileId');
  const params = new URL(c.req.url).searchParams;
  const limit = feedLimit(params.get('limit'));
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // A per-person answer: a shared edge cache must never hand it to anybody else.
  const headers = { 'Cache-Control': 'private, no-store' };
  const empty = (followsAnyone: boolean) =>
    c.json({ items: [], next_cursor: null, follows_anyone: followsAnyone }, 200, headers);

  // THE 7-DAY FLOOR applies to every page, `before` pages included, so the feed
  // never reaches further back than a week however far somebody scrolls.
  const floor = new Date(nowMs - FEED_WINDOW_DAYS * 86_400_000).toISOString();
  const since = instant(params.get('since'));
  const after = since != null && since > floor ? since : floor;
  // A malformed `before` is a first page, never a 400 — the cursor rule.
  const before = instant(params.get('before')) ?? '9999-12-31T00:00:00.000Z';

  /*
   * MEMBERS ONLY, AND NOBODY-FOLLOWED IS FREE. Two rows: the reader's own
   * profile, and the first accepted follow if there is one. An account that
   * never joined has no feed (the app never asks, this is the backstop), and a
   * member who follows nobody is told so — the phone draws "Find people" from
   * `follows_anyone` — without the three event statements running at all.
   */
  const reader = await db
    .prepare(
      `SELECT p.joined_at IS NOT NULL AS member,
              EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = p.id AND f.state = 'accepted') AS follows_anyone
         FROM profiles p WHERE p.id = ? AND p.deleted_at IS NULL`,
    )
    .bind(me)
    .first<{ member: number; follows_anyone: number }>();
  if (!reader || reader.member !== 1) return empty(false);
  if (reader.follows_anyone !== 1) return empty(false);
  // A `before` page that has walked past the floor: the week is over.
  if (after >= before) return empty(true);

  // ONE ROUND TRIP for the three sources. Each statement is LIMITed on its own:
  // the newest `limit` of the union is always inside the newest `limit` of each.
  const [ratings, comments, characters] = await db.batch(
    [FEED_RATINGS_SQL, FEED_COMMENTS_SQL, FEED_CHARACTERS_SQL].map((sql) =>
      db.prepare(sql).bind(me, after, before, limit),
    ),
  );

  const target = (r: Target) => ({
    target_source: r.target_source,
    target_key: r.target_key,
    season: r.season,
    episode: r.episode,
    created_at: r.created_at,
  });
  const events = [
    ...((ratings?.results ?? []) as RatingRow[]).map((r) => ({
      author: r.author_id,
      item: {
        id: `rating:${r.id}`,
        kind: 'rating' as const,
        ...target(r),
        score: r.score,
        emotions: r.emotions ? r.emotions.split(',') : [],
      },
    })),
    ...((comments?.results ?? []) as CommentRow[]).map((r) => ({
      author: r.author_id,
      item: {
        id: `comment:${r.id}`,
        kind: 'comment' as const,
        ...target(r),
        comment_id: r.id,
        body: r.body,
        is_spoiler: r.is_spoiler,
        is_reply: r.is_reply === 1,
        has_image: r.has_image === 1,
      },
    })),
    ...((characters?.results ?? []) as CharacterRow[]).map((r) => ({
      author: r.author_id,
      item: { id: `character:${r.id}`, kind: 'character' as const, ...target(r), character: r.character_name },
    })),
  ]
    // `id` second so the order is total and two refreshes agree on it.
    .sort((a, b) =>
      a.item.created_at === b.item.created_at
        ? a.item.id.localeCompare(b.item.id)
        : a.item.created_at < b.item.created_at
          ? 1
          : -1,
    )
    .slice(0, limit);
  if (events.length === 0) return empty(true);

  // The actor shells, one statement. At most `limit` (50) distinct ids, which
  // is under D1's 100 bound parameters without chunking.
  const ids = [...new Set(events.map((e) => e.author))];
  const actors = await db
    .prepare(
      `SELECT id, handle, display_name, avatar_key, is_plus, plus_until FROM profiles
        WHERE id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL`,
    )
    .bind(...ids)
    .all<Actor>();
  const byId = new Map((actors.results ?? []).map((a) => [a.id, a]));

  const items = events.flatMap((e) => {
    const a = byId.get(e.author);
    // Deleted between the two statements: the friend set already excludes the
    // dead, so this is a race, and a card with nobody on it is dropped.
    if (!a) return [];
    return [
      {
        ...e.item,
        actor: {
          id: a.id,
          handle: a.handle,
          display_name: a.display_name,
          avatar_key: a.avatar_key,
          is_plus: plusOn(a, nowIso),
        },
      },
    ];
  });

  /*
   * THE CURSOR IS A TIME, not `(created_at, id)`: three tables, three id
   * shapes. Strictly-older on the next page means two events in the same
   * millisecond across a page boundary can lose the second one.
   * `ponytail: time cursor; a composite cursor if a gap is ever seen in practice.`
   */
  const oldest = events[events.length - 1]!.item.created_at;
  return c.json(
    { items, next_cursor: events.length === limit ? oldest : null, follows_anyone: true },
    200,
    headers,
  );
});
