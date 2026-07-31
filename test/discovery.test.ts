import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { handlePrefixPattern, USER_SEARCH_LIMIT } from '@/pure';
import { call, freshDatabase, insertBlock, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * The two gaps the client hit the moment the social layer was real: you could
 * not FIND a person, and a reply notification carried a comment id it had no
 * way to resolve into a thread.
 */

let raw: Database.Database;
let env: Env;

beforeEach(() => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = makeEnv(fresh.db);
});

// ── GET /v1/users?q= ─────────────────────────────────────────────────────────

describe('GET /v1/users', () => {
  beforeEach(() => {
    insertProfile(raw, 'p1', 'mahmood');
    insertProfile(raw, 'p2', 'mahmoud');
    insertProfile(raw, 'p3', 'sara');
    insertProfile(raw, 'p4', 'gone', '2026-07-01T00:00:00.000Z');
  });

  const handles = (json: { items: { handle: string }[] }) => json.items.map((i) => i.handle);

  it('never returns YOU — you are not somebody to follow', async () => {
    const token = await tokenFor(env, 'p1');
    expect(handles((await call(env, 'GET', '/v1/users?q=mah', { token })).json)).toEqual(['mahmoud']);
  });

  it('still returns everyone to a SIGNED-OUT search', async () => {
    // The self-exclusion binds NULL when there is no viewer. `p.id != NULL` is
    // NULL, not TRUE, so the naive form would empty every anonymous search —
    // a whole feature switched off for anybody who has not joined.
    expect(handles((await call(env, 'GET', '/v1/users?q=mah')).json)).toEqual(['mahmood', 'mahmoud']);
  });

  it('matches on a prefix and returns the shell of each profile', async () => {
    const res = await call(env, 'GET', '/v1/users?q=mah');
    expect(res.status).toBe(200);
    expect(handles(res.json)).toEqual(['mahmood', 'mahmoud']);
    expect(res.json.items[0]).toEqual({
      id: 'p1',
      handle: 'mahmood',
      display_name: null,
      avatar_key: null,
      is_private: false,
    });
  });

  it('is case-insensitive, because a pasted handle is not case-correct', async () => {
    expect(handles((await call(env, 'GET', '/v1/users?q=MAHMOOD')).json)).toEqual(['mahmood']);
  });

  it('is a PREFIX search, not a substring one', async () => {
    // `ood` is inside `mahmood`; an unanchored LIKE would find it and would
    // also scan the whole table to do so.
    expect(handles((await call(env, 'GET', '/v1/users?q=ood')).json)).toEqual([]);
  });

  it('returns nothing for a handle nobody has', async () => {
    expect((await call(env, 'GET', '/v1/users?q=zzz')).json).toEqual({ items: [] });
  });

  it('never returns a soft-deleted account', async () => {
    expect(handles((await call(env, 'GET', '/v1/users?q=gone')).json)).toEqual([]);
  });

  it('excludes someone the caller blocked, and someone who blocked the caller', async () => {
    const token = await tokenFor(env, 'p3');
    insertBlock(raw, 'p3', 'p1'); // sara blocked mahmood
    insertBlock(raw, 'p2', 'p3'); // mahmoud blocked sara

    expect(handles((await call(env, 'GET', '/v1/users?q=mah', { token })).json)).toEqual([]);
    // Anonymously, both are still there — the filter is the viewer's, not a ban.
    expect(handles((await call(env, 'GET', '/v1/users?q=mah')).json)).toEqual(['mahmood', 'mahmoud']);
  });

  it('caps the page at twenty', async () => {
    for (let i = 0; i < USER_SEARCH_LIMIT + 5; i++) {
      insertProfile(raw, `x${i}`, `zed${String(i).padStart(2, '0')}`);
    }
    expect((await call(env, 'GET', '/v1/users?q=zed')).json.items).toHaveLength(USER_SEARCH_LIMIT);
  });

  it('treats the underscore in a placeholder handle as a letter, not a wildcard', async () => {
    insertProfile(raw, 'u1', 'user_abcdef1234');
    insertProfile(raw, 'u2', 'usermade');
    expect(handles((await call(env, 'GET', '/v1/users?q=user_')).json)).toEqual(['user_abcdef1234']);
  });

  it('requires something to search for', async () => {
    expect((await call(env, 'GET', '/v1/users')).status).toBe(400);
    expect((await call(env, 'GET', '/v1/users?q=')).status).toBe(400);
    expect((await call(env, 'GET', '/v1/users?q=%20%20')).status).toBe(400);
  });

  it('a bad bearer reads as anonymous rather than 401ing a public search', async () => {
    const res = await call(env, 'GET', '/v1/users?q=sara', { token: 'not.a.token' });
    expect(res.status).toBe(200);
    expect(handles(res.json)).toEqual(['sara']);
  });
});

describe('handlePrefixPattern', () => {
  it('anchors at the front and nowhere else', () => {
    expect(handlePrefixPattern('mah')).toBe('mah%');
  });

  it('normalises the way every handle lookup does', () => {
    expect(handlePrefixPattern('  MahMood ')).toBe('mahmood%');
  });

  it('escapes the LIKE wildcards that are legal handle characters', () => {
    expect(handlePrefixPattern('user_')).toBe('user\\_%');
    expect(handlePrefixPattern('a%b')).toBe('a\\%b%');
    expect(handlePrefixPattern('a\\b')).toBe('a\\\\b%');
  });

  it('is null when there is nothing to search for', () => {
    expect(handlePrefixPattern('')).toBeNull();
    expect(handlePrefixPattern('   ')).toBeNull();
    expect(handlePrefixPattern(null)).toBeNull();
    expect(handlePrefixPattern(undefined)).toBeNull();
  });
});

// ── GET /v1/comments/:id ─────────────────────────────────────────────────────

describe('GET /v1/comments/:id', () => {
  function comment(
    id: string,
    author: string,
    over: { deleted?: boolean; hidden?: boolean; parent?: string | null } = {},
  ) {
    raw
      .prepare(
        `INSERT INTO comments
           (id, author_id, target_source, target_key, season, episode, body, parent_id,
            deleted_at, hidden_at, created_at)
         VALUES (?, ?, 'tvdb', '121361', 1, 3, 'a real opinion', ?, ?, ?, '2026-07-01T00:00:00.000Z')`,
      )
      .run(
        id,
        author,
        over.parent ?? null,
        over.deleted ? '2026-07-02T00:00:00.000Z' : null,
        over.hidden ? '2026-07-02T00:00:00.000Z' : null,
      );
  }

  beforeEach(() => {
    insertProfile(raw, 'p1', 'mahmood');
    insertProfile(raw, 'p2', 'sara');
  });

  it('returns the comment, shaped exactly as the thread shapes it', async () => {
    comment('c1', 'p2');
    comment('c2', 'p1', { parent: 'c1' });

    const res = await call(env, 'GET', '/v1/comments/c1');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      id: 'c1',
      author: { id: 'p2', handle: 'sara', display_name: null, avatar_key: null },
      target_source: 'tvdb',
      target_key: '121361',
      season: 1,
      episode: 3,
      body: 'a real opinion',
      parent_id: null,
      like_count: 0,
      liked_by_me: false,
      reply_count: 1,
    });
  });

  it('reports liked_by_me for the reader holding a bearer', async () => {
    comment('c1', 'p2');
    raw
      .prepare(
        `INSERT INTO comment_likes (comment_id, user_id, created_at)
         VALUES ('c1', 'p1', '2026-07-01T00:00:00.000Z')`,
      )
      .run();

    const token = await tokenFor(env, 'p1');
    expect((await call(env, 'GET', '/v1/comments/c1', { token })).json.liked_by_me).toBe(true);
    expect((await call(env, 'GET', '/v1/comments/c1')).json.liked_by_me).toBe(false);
  });

  it('404s a comment its author deleted', async () => {
    comment('c1', 'p2', { deleted: true });
    const res = await call(env, 'GET', '/v1/comments/c1');
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('not_found');
  });

  it('404s a comment the report threshold hid', async () => {
    comment('c1', 'p2', { hidden: true });
    expect((await call(env, 'GET', '/v1/comments/c1')).status).toBe(404);
  });

  it('404s a comment by someone the reader blocked, in either direction', async () => {
    comment('c1', 'p2');
    const token = await tokenFor(env, 'p1');

    insertBlock(raw, 'p1', 'p2');
    expect((await call(env, 'GET', '/v1/comments/c1', { token })).status).toBe(404);
    // Anonymously it is still readable: the block belongs to the reader.
    expect((await call(env, 'GET', '/v1/comments/c1')).status).toBe(200);

    raw.prepare('DELETE FROM blocks').run();
    insertBlock(raw, 'p2', 'p1');
    expect((await call(env, 'GET', '/v1/comments/c1', { token })).status).toBe(404);
  });

  it('404s a comment whose author soft-deleted their account', async () => {
    comment('c1', 'p2');
    raw.prepare("UPDATE profiles SET deleted_at = '2026-07-02T00:00:00.000Z' WHERE id = 'p2'").run();
    expect((await call(env, 'GET', '/v1/comments/c1')).status).toBe(404);
  });

  it('404s an id that never existed — the same answer as every other refusal', async () => {
    expect((await call(env, 'GET', '/v1/comments/c_nope')).status).toBe(404);
  });

  it('does not count a hidden reply in reply_count', async () => {
    comment('c1', 'p2');
    comment('c2', 'p1', { parent: 'c1', hidden: true });
    expect((await call(env, 'GET', '/v1/comments/c1')).json.reply_count).toBe(0);
  });
});
