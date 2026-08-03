import { beforeEach, describe, expect, it } from 'vitest';
import {
  chunk,
  coveredByWatermark,
  D1_MAX_BOUND_PARAMS,
  type FullProfileView,
  isPlus,
  RECONCILE_FIXED_BINDS,
  RECONCILE_IDS_PER_QUERY,
  RECONCILE_MAX_IDS,
  validateFriendIds,
  visibleProfileFields,
} from '@/pure';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * docs/IMPLEMENTATION.md Step 4, "Unit tests". The decisions that can be
 * quietly wrong: who sees what on a private profile, a Plus flag that must
 * never leak a billing date, the watermark boundary that decides whether a
 * badge ever clears, and the input guard on the one endpoint that reads other
 * people's ids.
 */

const PROFILE: FullProfileView = {
  id: 'p_b',
  handle: 'sara',
  display_name: 'Sara',
  avatar_key: 'av/sara.jpg',
  cover_url: 'https://image.tmdb.org/t/p/w1280/cover.jpg',
  bio: 'Watching everything twice.',
  is_private: true,
  links: ['https://example.com'],
  is_plus: false,
  counts: { followers: 12, following: 30, comments: 88, lists: 2 },
  followed_by_me: false,
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('visibleProfileFields — the is_private matrix', () => {
  it('shows a stranger of a PRIVATE profile the shell, and only the shell', () => {
    const v = visibleProfileFields(PROFILE, false, false);
    // The shell must exist, or you cannot request to follow someone.
    expect(v.handle).toBe('sara');
    expect(v.display_name).toBe('Sara');
    expect(v.avatar_key).toBe('av/sara.jpg');
    expect(v.is_private).toBe(true);
    // And nothing else.
    expect(v.counts).toBeNull();
    expect(v.bio).toBeNull();
    expect(v.links).toBeNull();
  });

  it('shows a FOLLOWER of a private profile the counts, bio and links', () => {
    const v = visibleProfileFields({ ...PROFILE, followed_by_me: true }, true, false);
    expect(v.counts).toEqual(PROFILE.counts);
    expect(v.bio).toBe(PROFILE.bio);
    expect(v.links).toEqual(PROFILE.links);
  });

  it('shows the owner everything, private or not', () => {
    const v = visibleProfileFields(PROFILE, false, true);
    expect(v.counts).toEqual(PROFILE.counts);
    expect(v.bio).toBe(PROFILE.bio);
    expect(v.links).toEqual(PROFILE.links);
    expect(v.is_private).toBe(true);
  });

  it('shows a stranger of a PUBLIC profile everything', () => {
    const v = visibleProfileFields({ ...PROFILE, is_private: false }, false, false);
    expect(v.counts).toEqual(PROFILE.counts);
    expect(v.bio).toBe(PROFILE.bio);
  });

  it('never mutates the profile it was handed', () => {
    const input = { ...PROFILE };
    visibleProfileFields(input, false, false);
    expect(input.counts).toEqual(PROFILE.counts);
    expect(input.bio).toBe(PROFILE.bio);
  });

  it('carries is_plus and followed_by_me through the shell — both are needed to render it', () => {
    const v = visibleProfileFields({ ...PROFILE, is_plus: true }, false, false);
    expect(v.is_plus).toBe(true);
    expect(v.followed_by_me).toBe(false);
  });
});

describe('isPlus — a boolean, never a date', () => {
  const now = '2026-07-31T12:00:00.000Z';

  it('is false when nothing was ever purchased', () => {
    expect(isPlus(null, now)).toBe(false);
    expect(isPlus(undefined, now)).toBe(false);
    expect(isPlus('', now)).toBe(false);
  });

  it('is false for an entitlement that has run out', () => {
    expect(isPlus('2026-07-30T12:00:00.000Z', now)).toBe(false);
  });

  it('is true for an entitlement still running', () => {
    expect(isPlus('2026-08-30T12:00:00.000Z', now)).toBe(true);
  });

  it('is false at the exact instant of expiry', () => {
    expect(isPlus(now, now)).toBe(false);
  });
});

describe('coveredByWatermark — the read boundary', () => {
  const upTo = '2026-07-31T12:00:00.000Z';

  it('marks a notification stamped EXACTLY at the watermark', () => {
    // Exclusive would leave the newest row unread every time, because that is
    // precisely the timestamp the client sends back.
    expect(coveredByWatermark(upTo, upTo)).toBe(true);
  });

  it('marks everything older', () => {
    expect(coveredByWatermark('2026-07-31T11:59:59.999Z', upTo)).toBe(true);
  });

  it('leaves anything newer unread', () => {
    expect(coveredByWatermark('2026-07-31T12:00:00.001Z', upTo)).toBe(false);
  });
});

describe('validateFriendIds — the reconcile input guard', () => {
  it('accepts a list at the cap', () => {
    const ids = Array.from({ length: RECONCILE_MAX_IDS }, (_, i) => i + 1);
    const r = validateFriendIds(ids);
    expect(r.ok).toBe(true);
  });

  it('refuses 501 ids — the app chunks, the server does not stretch', () => {
    const ids = Array.from({ length: RECONCILE_MAX_IDS + 1 }, (_, i) => i + 1);
    const r = validateFriendIds(ids);
    expect(r).toEqual({ ok: false, reason: 'too_many' });
  });

  it('refuses non-integers, including numeric strings and floats', () => {
    expect(validateFriendIds(['12137674'])).toEqual({ ok: false, reason: 'not_an_integer' });
    expect(validateFriendIds([1.5])).toEqual({ ok: false, reason: 'not_an_integer' });
    expect(validateFriendIds([Number.NaN])).toEqual({ ok: false, reason: 'not_an_integer' });
  });

  it('refuses negatives and zero', () => {
    expect(validateFriendIds([-1])).toEqual({ ok: false, reason: 'not_an_integer' });
    expect(validateFriendIds([0])).toEqual({ ok: false, reason: 'not_an_integer' });
  });

  it('refuses anything that is not an array', () => {
    expect(validateFriendIds(undefined)).toEqual({ ok: false, reason: 'not_an_array' });
    expect(validateFriendIds({ 0: 1 })).toEqual({ ok: false, reason: 'not_an_array' });
  });

  it('dedupes, because an export repeats ids', () => {
    const r = validateFriendIds([12137674, 12137674, 9912]);
    expect(r.ok && r.ids).toEqual([12137674, 9912]);
  });

  it('accepts an empty list', () => {
    const r = validateFriendIds([]);
    expect(r.ok && r.ids).toEqual([]);
  });
});

describe('chunk', () => {
  it('slices at the boundary', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns one chunk when the input fits', () => {
    expect(chunk([1, 2], 500)).toEqual([[1, 2]]);
  });

  it('returns nothing for nothing', () => {
    expect(chunk([], 500)).toEqual([]);
  });
});

/**
 * The reconcile route had the aggregate list form's bug at a different
 * threshold: one bound parameter per friend id in an `IN`, plus three fixed
 * binds, against D1's ceiling of 100 per statement. `RECONCILE_MAX_IDS` is 500,
 * so it broke from the 98th id — and a TV Time export with a hundred friends in
 * it is an ordinary export.
 */
describe('POST /v1/me/friends/reconcile — past one statement\'s worth of ids', () => {
  it('derives its per-query cap from D1\'s limit and the three fixed binds', () => {
    expect(RECONCILE_IDS_PER_QUERY).toBe(D1_MAX_BOUND_PARAMS - RECONCILE_FIXED_BINDS);
    expect(RECONCILE_IDS_PER_QUERY + RECONCILE_FIXED_BINDS).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMS,
    );
  });

  it('matches a friend whose id sits past the chunk boundary', async () => {
    const { raw, db } = freshDatabase();
    const env = makeEnv(db);
    insertProfile(raw, 'p_me', 'mahmood');
    insertProfile(raw, 'p_far', 'sara');
    // Sara's TV Time id is the 200th in the list, well past the 97 a single
    // statement can bind. Before chunking this whole call was a 500.
    raw.prepare('UPDATE profiles SET tvtime_user_id = 4242 WHERE id = ?').run('p_far');

    const ids = Array.from({ length: RECONCILE_MAX_IDS }, (_, i) => i + 1);
    ids[199] = 4242;

    const res = await call(env, 'POST', '/v1/me/friends/reconcile', {
      token: await tokenFor(env, 'p_me'),
      body: { friend_ids: ids },
    });

    expect(res.status).toBe(200);
    expect(res.json.matched.map((m: { handle: string }) => m.handle)).toEqual(['sara']);
  });

  it('returns each match once, never once per chunk', async () => {
    const { raw, db } = freshDatabase();
    const env = makeEnv(db);
    insertProfile(raw, 'p_me', 'mahmood');
    insertProfile(raw, 'p_a', 'aya');
    insertProfile(raw, 'p_b', 'basim');
    raw.prepare('UPDATE profiles SET tvtime_user_id = 5 WHERE id = ?').run('p_a');
    raw.prepare('UPDATE profiles SET tvtime_user_id = 300 WHERE id = ?').run('p_b');

    const res = await call(env, 'POST', '/v1/me/friends/reconcile', {
      token: await tokenFor(env, 'p_me'),
      body: { friend_ids: Array.from({ length: RECONCILE_MAX_IDS }, (_, i) => i + 1) },
    });

    expect(res.status).toBe(200);
    const handles = res.json.matched.map((m: { handle: string }) => m.handle).sort();
    expect(handles).toEqual(['aya', 'basim']);
  });
});

/**
 * GET /v1/profiles/:handle/comments.
 *
 * A profile could report "2 comments" and had no endpoint that could show
 * them: the thread read wants a target or a parent, so the screen rendered a
 * count band over an empty page. These assertions are mostly about the
 * endpoint NOT becoming a back door — everything the thread hides, a profile
 * must hide too.
 */
describe('reconcile returns which friend each match is', () => {
  it('carries tvtime_user_id back, so a match can be tied to the person', async () => {
    const fresh = freshDatabase();
    const env2 = makeEnv(fresh.db);
    insertProfile(fresh.raw, 'p1', 'mahmood');
    insertProfile(fresh.raw, 'p2', 'sara');
    fresh.raw.prepare("UPDATE profiles SET tvtime_user_id = 53635487 WHERE id = 'p2'").run();
    fresh.raw.prepare("UPDATE profiles SET tvtime_user_id = 50248888 WHERE id = 'p1'").run();

    const res = await call(env2, 'POST', '/v1/me/friends/reconcile', {
      token: await tokenFor(env2, 'p1'),
      body: { friend_ids: [53635487, 12137674] },
    });

    expect(res.status).toBe(200);
    // Without this the same human shows up twice in a merged follow list:
    // once as a TV Time row and once as an OpenTV one.
    expect(res.json.matched).toEqual([
      { handle: 'sara', display_name: null, avatar_key: null, tvtime_user_id: 53635487 },
    ]);
  });
});

describe('a profile’s own comments', () => {
  let raw: import('better-sqlite3').Database;
  let env: import('@/env').Env;

  const say = (id: string, author: string, body: string, at: string, over: Record<string, unknown> = {}) =>
    raw
      .prepare(
        `INSERT INTO comments (id, author_id, target_source, target_key, season, episode, body,
                               is_spoiler, lang, parent_id, imported_at, created_at,
                               deleted_at, hidden_at, like_count)
         VALUES (?, ?, 'tvdb', '121361', 1, 3, ?, 0, NULL, ?, NULL, ?, ?, ?, 0)`,
      )
      .run(
        id,
        author,
        body,
        (over.parent_id as string) ?? null,
        at,
        (over.deleted_at as string) ?? null,
        (over.hidden_at as string) ?? null,
      );

  beforeEach(() => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    env = makeEnv(fresh.db);
    insertProfile(raw, 'p1', 'mahmood');
    insertProfile(raw, 'p2', 'sara');
  });

  it('returns them newest first', async () => {
    say('c1', 'p1', 'older', '2019-01-01T00:00:00.000Z');
    say('c2', 'p1', 'newer', '2022-01-01T00:00:00.000Z');

    const res = await call(env, 'GET', '/v1/profiles/mahmood/comments');
    expect(res.status).toBe(200);
    expect(res.json.items.map((i: { body: string }) => i.body)).toEqual(['newer', 'older']);
  });

  it('returns only that person’s', async () => {
    say('c1', 'p1', 'mine', '2022-01-01T00:00:00.000Z');
    say('c2', 'p2', 'hers', '2022-01-02T00:00:00.000Z');

    const res = await call(env, 'GET', '/v1/profiles/mahmood/comments');
    expect(res.json.items.map((i: { body: string }) => i.body)).toEqual(['mine']);
  });

  // A reply is half of somebody else's conversation, and the owner's own
  // Profile tab has never listed one. A visitor seeing four where the owner
  // counts two is the same disagreement in a number.
  it('omits replies, and does not count them', async () => {
    say('c1', 'p2', 'top', '2022-01-01T00:00:00.000Z');
    say('c2', 'p1', 'my reply', '2022-01-02T00:00:00.000Z', { parent_id: 'c1' });
    say('c3', 'p1', 'my own', '2022-01-03T00:00:00.000Z');

    const res = await call(env, 'GET', '/v1/profiles/mahmood/comments');
    expect(res.json.items.map((i: { body: string }) => i.body)).toEqual(['my own']);

    const prof = await call(env, 'GET', '/v1/profiles/mahmood');
    expect(prof.json.counts.comments).toBe(1);
  });

  it('hides deleted and moderator-hidden rows, exactly as the thread does', async () => {
    say('c1', 'p1', 'gone', '2022-01-01T00:00:00.000Z', { deleted_at: '2026-01-01T00:00:00.000Z' });
    say('c2', 'p1', 'hidden', '2022-01-02T00:00:00.000Z', { hidden_at: '2026-01-01T00:00:00.000Z' });
    say('c3', 'p1', 'visible', '2022-01-03T00:00:00.000Z');

    const res = await call(env, 'GET', '/v1/profiles/mahmood/comments');
    expect(res.json.items.map((i: { body: string }) => i.body)).toEqual(['visible']);
  });

  it('pages on (created_at, id), so a seeding batch in one second cannot repeat a row', async () => {
    const same = '2022-01-01T00:00:00.000Z';
    for (const id of ['c1', 'c2', 'c3']) say(id, 'p1', id, same);

    const first = await call(env, 'GET', '/v1/profiles/mahmood/comments?limit=2');
    expect(first.json.items).toHaveLength(2);
    expect(first.json.next_cursor).toBeTruthy();

    const second = await call(
      env,
      'GET',
      `/v1/profiles/mahmood/comments?limit=2&cursor=${encodeURIComponent(first.json.next_cursor)}`,
    );
    const seen = [...first.json.items, ...second.json.items].map((i: { id: string }) => i.id);
    expect(new Set(seen).size).toBe(3);
  });

  it('is 404 for a profile that does not exist', async () => {
    expect((await call(env, 'GET', '/v1/profiles/nobody/comments')).status).toBe(404);
  });

  it('is 403 on a private profile a stranger has not earned', async () => {
    raw.prepare("UPDATE profiles SET is_private = 1 WHERE id = 'p1'").run();
    say('c1', 'p1', 'private thoughts', '2022-01-01T00:00:00.000Z');

    expect((await call(env, 'GET', '/v1/profiles/mahmood/comments')).status).toBe(403);
    // …and the owner still sees their own.
    const mine = await call(env, 'GET', '/v1/profiles/mahmood/comments', { token: await tokenFor(env, 'p1') });
    expect(mine.status).toBe(200);
    expect(mine.json.items).toHaveLength(1);
  });
});

/**
 * GET /v1/profiles/:handle/following.
 *
 * The mirror of the followers list, and the reason it exists: a profile's
 * "following" count was unopenable on anybody but yourself, so the same number
 * behaved differently on your profile and on somebody else's.
 *
 * The two directions must not be confused — that is the one thing a copied
 * handler gets wrong — so every test here checks that A-follows-B produces B in
 * A's following list and A in B's followers list, never the reverse.
 */
describe('GET /v1/profiles/:handle/following', () => {
  let raw: import('better-sqlite3').Database;
  let env: import('@/env').Env;

  const followed = (a: string, b: string) =>
    raw
      .prepare('INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)')
      .run(a, b, '2026-01-01T00:00:00.000Z');

  beforeEach(() => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    env = makeEnv(fresh.db);
    insertProfile(raw, 'p1', 'mahmood');
    insertProfile(raw, 'p2', 'sara');
    insertProfile(raw, 'p3', 'amanda');
  });

  it('lists who they follow, not who follows them', async () => {
    followed('p1', 'p2'); // mahmood follows sara
    followed('p3', 'p1'); // amanda follows mahmood

    const following = await call(env, 'GET', '/v1/profiles/mahmood/following');
    expect(following.status).toBe(200);
    expect(following.json.items.map((i: { handle: string }) => i.handle)).toEqual(['sara']);

    // …and the followers route still answers the other question.
    const followers = await call(env, 'GET', '/v1/profiles/mahmood/followers');
    expect(followers.json.items.map((i: { handle: string }) => i.handle)).toEqual(['amanda']);
  });

  it('is empty for somebody who follows nobody', async () => {
    const res = await call(env, 'GET', '/v1/profiles/mahmood/following');
    expect(res.status).toBe(200);
    expect(res.json.items).toEqual([]);
  });

  it('is 404 for a profile that does not exist', async () => {
    expect((await call(env, 'GET', '/v1/profiles/nobody/following')).status).toBe(404);
  });

  it('is 403 on a private profile a stranger has not earned, 200 for the owner', async () => {
    followed('p1', 'p2');
    raw.prepare("UPDATE profiles SET is_private = 1 WHERE id = 'p1'").run();

    expect((await call(env, 'GET', '/v1/profiles/mahmood/following')).status).toBe(403);

    const mine = await call(env, 'GET', '/v1/profiles/mahmood/following', {
      token: await tokenFor(env, 'p1'),
    });
    expect(mine.status).toBe(200);
    expect(mine.json.items).toHaveLength(1);
  });

  it('is 403 for a private profile until you follow it', async () => {
    followed('p1', 'p2');
    raw.prepare("UPDATE profiles SET is_private = 1 WHERE id = 'p1'").run();
    followed('p3', 'p1'); // amanda now follows mahmood

    const res = await call(env, 'GET', '/v1/profiles/mahmood/following', {
      token: await tokenFor(env, 'p3'),
    });
    expect(res.status).toBe(200);
  });

  it('is 404 across a block, in either direction', async () => {
    followed('p1', 'p2');
    const p3 = await tokenFor(env, 'p3');

    raw
      .prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES ('p1','p3','2026-01-01T00:00:00Z')")
      .run();
    expect((await call(env, 'GET', '/v1/profiles/mahmood/following', { token: p3 })).status).toBe(404);

    raw.prepare('DELETE FROM blocks').run();
    raw
      .prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES ('p3','p1','2026-01-01T00:00:00Z')")
      .run();
    expect((await call(env, 'GET', '/v1/profiles/mahmood/following', { token: p3 })).status).toBe(404);
  });
});
