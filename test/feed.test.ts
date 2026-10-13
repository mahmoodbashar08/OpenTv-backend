/**
 * `GET /v1/me/feed` — the friends feed (routes/feed.ts, DESIGN-community §1).
 *
 * One fixture: a reader who follows four people one way or another, plus the
 * people every rule exists to keep out. Each test names the rule it holds.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '@/env';
import {
  FEED_CHARACTERS_SQL,
  FEED_COMMENTS_SQL,
  FEED_PAGE_DEFAULT,
  FEED_PAGE_MAX,
  FEED_RATINGS_SQL,
} from '@/routes/feed';
import { call, freshDatabase, insertBlock, insertProfile, makeEnv, tokenFor } from './harness';

let env: Env;
let raw: ReturnType<typeof freshDatabase>['raw'];
let token: string;

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const DAY = 24 * 60;

function follow(follower: string, followee: string, state: 'accepted' | 'pending' = 'accepted') {
  raw
    .prepare('INSERT INTO follows (follower_id, followee_id, created_at, state) VALUES (?, ?, ?, ?)')
    .run(follower, followee, ago(DAY * 30), state);
}

let n = 0;
function rate(author: string, at: string, opts: { score?: number | null; season?: number | null; episode?: number | null; imported?: boolean; key?: string } = {}) {
  const id = `r${++n}`;
  raw
    .prepare(
      `INSERT INTO ratings (id, author_id, target_source, target_key, season, episode, score, created_at, imported_at)
       VALUES (?, ?, 'tvdb', ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, author, opts.key ?? '402551', opts.season === undefined ? 2 : opts.season, opts.episode === undefined ? 5 : opts.episode, opts.score === undefined ? 8 : opts.score, at, opts.imported ? at : null);
  return id;
}

function comment(author: string, at: string, opts: { body?: string; hidden?: boolean; deleted?: boolean; imported?: boolean; spoiler?: boolean } = {}) {
  const id = `c${++n}`;
  raw
    .prepare(
      `INSERT INTO comments (id, author_id, target_source, target_key, season, episode, body, is_spoiler, created_at, imported_at, hidden_at, deleted_at)
       VALUES (?, ?, 'tvdb', '402551', 2, 5, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, author, opts.body ?? 'what an ending', opts.spoiler ? 1 : 0, at, opts.imported ? at : null, opts.hidden ? at : null, opts.deleted ? at : null);
  return id;
}

function character(author: string, at: string, name = 'Richie', episode = 5) {
  const id = `v${++n}`;
  raw
    .prepare(
      `INSERT INTO character_votes (id, voter_id, target_source, target_key, character_name, season, episode, created_at)
       VALUES (?, ?, 'tvdb', '402551', ?, 2, ?, ?)`,
    )
    .run(id, author, name, episode, at);
  return id;
}

const read = (query = '', as = token) => call(env, 'GET', `/v1/me/feed${query}`, { token: as });
const kinds = (res: { json: { items: { kind: string; actor: { handle: string } }[] } }) =>
  res.json.items.map((i) => `${i.actor.handle}:${i.kind}`);

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = makeEnv(fresh.db);
  n = 0;
  for (const [id, handle] of [
    ['me', 'reader'],
    ['amy', 'amy'],
    ['ben', 'ben'],
    ['cat', 'cat'],
    ['dan', 'dan'],
    ['eve', 'eve'],
    ['gus', 'gus'],
    ['zed', 'zed'],
  ] as const) insertProfile(raw, id, handle);
  raw.prepare("UPDATE profiles SET is_private = 1 WHERE id IN ('ben', 'cat')").run();
  follow('me', 'amy');
  follow('me', 'ben'); // private, and accepted
  follow('me', 'cat', 'pending'); // private, and only asked
  follow('me', 'eve');
  follow('me', 'gus');
  // dan: blocked. routes/blocks.ts has already removed the follow edge, so the
  // fixture has a block row and no follow — which is exactly the state a block leaves.
  insertBlock(raw, 'me', 'dan');
  token = await tokenFor(env, 'me');
});

describe('GET /v1/me/feed', () => {
  it('needs a session', async () => {
    expect((await call(env, 'GET', '/v1/me/feed')).status).toBe(401);
  });

  it('shows ratings, feelings, comments and characters by people I follow, newest first', async () => {
    rate('amy', ago(10));
    raw
      .prepare(
        `INSERT INTO emotion_votes (author_id, target_source, target_key, season, episode, emotion, created_at)
         VALUES ('amy', 'tvdb', '402551', 2, 5, 'shocked', ?), ('amy', 'tvdb', '402551', 2, 5, 'thrilled', ?)`,
      )
      .run(ago(10), ago(10));
    comment('ben', ago(5), { spoiler: true });
    character('gus', ago(20));
    rate('eve', ago(30), { score: null, season: null, episode: null }); // a feeling-only, show-level vote

    const res = await read();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(kinds(res)).toEqual(['ben:comment', 'amy:rating', 'gus:character', 'eve:rating']);

    const [c, r, v, show] = res.json.items;
    expect(c).toMatchObject({ kind: 'comment', body: 'what an ending', is_spoiler: 1, is_reply: false, has_image: false, season: 2, episode: 5 });
    expect(c.comment_id).toBe(c.id.replace('comment:', ''));
    expect(r).toMatchObject({ kind: 'rating', score: 8, target_source: 'tvdb', target_key: '402551' });
    expect([...r.emotions].sort()).toEqual(['shocked', 'thrilled']);
    expect(r.actor).toEqual({ id: 'amy', handle: 'amy', display_name: null, avatar_key: null, is_plus: false });
    expect(v).toMatchObject({ kind: 'character', character: 'Richie' });
    expect(show).toMatchObject({ season: null, episode: null, score: null, emotions: [] });
    expect(res.json.next_cursor).toBeNull();
    expect(res.json.follows_anyone).toBe(true);
  });

  it('never shows the archive (imported_at)', async () => {
    rate('amy', ago(10), { imported: true });
    comment('amy', ago(10), { imported: true });
    expect((await read()).json.items).toEqual([]);
  });

  it('leaves out a pending request, a block, and people I do not follow', async () => {
    rate('cat', ago(1)); // pending
    rate('dan', ago(1)); // blocked
    rate('zed', ago(1)); // a stranger
    rate('amy', ago(2));
    expect(kinds(await read())).toEqual(['amy:rating']);
  });

  it('follows a block made after the follow: the edge is gone, so are the cards', async () => {
    rate('amy', ago(2));
    expect((await read()).json.items).toHaveLength(1);
    expect((await call(env, 'POST', '/v1/blocks/amy', { token })).status).toBeLessThan(300);
    const res = await read();
    expect(res.json.items).toEqual([]);
    expect(res.json.follows_anyone).toBe(true); // ben, eve and gus are still followed
  });

  it('leaves out hidden and deleted comments, deleted actors, and actors who never joined', async () => {
    comment('amy', ago(1), { hidden: true });
    comment('amy', ago(1), { deleted: true });
    rate('gus', ago(1));
    raw.prepare("UPDATE profiles SET deleted_at = ? WHERE id = 'gus'").run(ago(0));
    rate('eve', ago(1));
    raw.prepare("UPDATE profiles SET joined_at = NULL WHERE id = 'eve'").run();
    expect((await read()).json.items).toEqual([]);
  });

  it("honours 'Show my reactions to followers' (hidden section 'feed', on by default)", async () => {
    rate('amy', ago(1));
    rate('ben', ago(2));
    const amy = await tokenFor(env, 'amy');
    expect((await call(env, 'PATCH', '/v1/me', { token: amy, body: { hidden_sections: ['feed'] } })).status).toBe(200);
    expect(kinds(await read())).toEqual(['ben:rating']);
    // Switched back on, the same rows come back — nothing was deleted.
    expect((await call(env, 'PATCH', '/v1/me', { token: amy, body: { hidden_sections: null } })).status).toBe(200);
    expect(kinds(await read())).toEqual(['amy:rating', 'ben:rating']);
  });

  it('a hidden feed does not hide other sections, and other sections do not hide the feed', async () => {
    rate('amy', ago(1));
    raw.prepare(`UPDATE profiles SET hidden_sections = '["comments","stats"]' WHERE id = 'amy'`).run();
    expect(kinds(await read())).toEqual(['amy:rating']);
  });

  it('never reaches past the 7-day floor, cold, with since, or with before', async () => {
    rate('amy', ago(8 * DAY));
    rate('ben', ago(6 * DAY));
    expect(kinds(await read())).toEqual(['ben:rating']);
    expect(kinds(await read(`?since=${encodeURIComponent(ago(30 * DAY))}`))).toEqual(['ben:rating']);
    expect(kinds(await read(`?before=${encodeURIComponent(ago(6 * DAY + 1))}`))).toEqual([]);
    expect((await read(`?before=${encodeURIComponent(ago(9 * DAY))}`)).json.items).toEqual([]);
  });

  it('since returns only newer events (the refresh); before only older (load more)', async () => {
    rate('amy', ago(30));
    const middle = ago(20);
    rate('ben', middle);
    rate('eve', ago(10));
    expect(kinds(await read(`?since=${encodeURIComponent(middle)}`))).toEqual(['eve:rating']);
    expect(kinds(await read(`?before=${encodeURIComponent(middle)}`))).toEqual(['amy:rating']);
  });

  it('treats a malformed since/before as absent, never a 500', async () => {
    rate('amy', ago(1));
    const res = await read('?since=yesterday&before=%%%');
    expect(res.status).toBe(200);
    expect(kinds(res)).toEqual(['amy:rating']);
  });

  it(`pages: default ${FEED_PAGE_DEFAULT}, capped at ${FEED_PAGE_MAX}, with a cursor that walks to the end`, async () => {
    for (let i = 0; i < 70; i++) rate('amy', ago(i + 1), { key: String(1000 + i) });
    const first = await read();
    expect(first.json.items).toHaveLength(FEED_PAGE_DEFAULT);
    expect((await read('?limit=500')).json.items).toHaveLength(FEED_PAGE_MAX);
    expect((await read('?limit=3')).json.items).toHaveLength(3);

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof read>> = await read(`?limit=${FEED_PAGE_MAX}${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
      for (const it of page.json.items) seen.add(it.id);
      cursor = page.json.next_cursor;
      pages++;
    } while (cursor != null && pages < 5);
    expect(seen.size).toBe(70);
    expect(pages).toBe(2);
  });

  it('merges the three sources before the limit, so a page is the newest N overall', async () => {
    for (let i = 0; i < 4; i++) {
      rate('amy', ago(i * 3 + 1), { key: String(i) });
      comment('ben', ago(i * 3 + 2));
      character('gus', ago(i * 3 + 3), `C${i}`, i + 1);
    }
    const res = await read('?limit=5');
    expect(kinds(res)).toEqual(['amy:rating', 'ben:comment', 'gus:character', 'amy:rating', 'ben:comment']);
    expect(res.json.next_cursor).toBe(res.json.items[4].created_at);
  });

  it('answers a member who follows nobody without reading any event', async () => {
    const lonely = await tokenFor(env, 'zed');
    rate('amy', ago(1));
    const res = await read('', lonely);
    expect(res.json).toEqual({ items: [], next_cursor: null, follows_anyone: false });
  });

  it('has no rows for a non-member, even one with follow edges', async () => {
    raw.prepare("UPDATE profiles SET joined_at = NULL WHERE id = 'me'").run();
    rate('amy', ago(1));
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ items: [], next_cursor: null, follows_anyone: false });
  });

  it('cuts a comment to 280 characters and says whether a CLEARED picture is attached', async () => {
    const id = comment('amy', ago(1), { body: 'x'.repeat(1000) });
    raw
      .prepare(`INSERT INTO comment_images (comment_id, r2_key, scan_status, created_at) VALUES (?, 'k', 'pending', ?)`)
      .run(id, ago(1));
    let item = (await read()).json.items[0];
    expect(item.body).toHaveLength(280);
    expect(item.has_image).toBe(false);
    raw.prepare(`UPDATE comment_images SET scan_status = 'clean' WHERE comment_id = ?`).run(id);
    item = (await read()).json.items[0];
    expect(item.has_image).toBe(true);
  });

  it('writes nothing', async () => {
    rate('amy', ago(1));
    const count = () =>
      raw.prepare('SELECT (SELECT COUNT(*) FROM notifications) + (SELECT COUNT(*) FROM ratings) AS n').get();
    const before = count();
    await read();
    expect(count()).toEqual(before);
  });

  it('reads only the friends\' own index ranges (the budget rests on it)', () => {
    // Without INDEXED BY, SQLite picks the 0029 activity indexes and walks the
    // whole community's week. See the note on the statements in routes/feed.ts.
    for (const [sql, index] of [
      [FEED_RATINGS_SQL, 'idx_ratings_author_live'],
      [FEED_COMMENTS_SQL, 'idx_comments_author_live'],
      [FEED_CHARACTERS_SQL, 'idx_character_votes_voter_live'],
    ] as const) {
      const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('me', 'a', 'b', 30) as { detail: string }[])
        .map((p) => p.detail)
        .join(' | ');
      expect(plan).toContain(`USING INDEX ${index}`);
      expect(plan).not.toContain('_activity');
    }
  });
});
