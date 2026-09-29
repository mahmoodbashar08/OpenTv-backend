/**
 * Reading the CommsUni board — phase one of the integration (1.6.5).
 * The key stays on the Worker, only members can read, deleted comments are
 * hidden whole, "never archived" is an empty thread and not an error, and a
 * 429 stops us asking for a minute.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '@/env';
import { commsuniPath, trimComment } from '@/routes/commsuni';
import { call, freshDatabase, makeEnv, tokenFor } from './harness';

describe('commsuniPath', () => {
  it('addresses an episode by show id, season and episode', () => {
    expect(commsuniPath({ type: 'episode', id: '289590', season: '1', episode: '2' })).toBe(
      '/entities/episode/tvdb-289590-s1e2/comments?limit=20&sort=most_liked',
    );
  });
  it('addresses shows and films by their own id, and passes sort and cursor', () => {
    expect(commsuniPath({ type: 'movie', id: '1234', sort: 'most_recent', cursor: 'abc' })).toBe(
      '/entities/movie/tvdb-1234/comments?limit=20&sort=most_recent&cursor=abc',
    );
  });
  it('refuses anything that is not a number where one belongs', () => {
    expect(commsuniPath({ type: 'show', id: '12a' })).toBeNull();
    expect(commsuniPath({ type: 'episode', id: '1', season: 'x', episode: '1' })).toBeNull();
    expect(commsuniPath({ type: 'user', id: '1' })).toBeNull();
  });
});

describe('trimComment', () => {
  it('hides a tombstone completely', () => {
    expect(trimComment({ id: 'a', text: null as unknown as string, deleted: true })).toBeNull();
  });
  it('keeps what the app draws and nothing about the viewer', () => {
    const t = trimComment({
      id: 'a', text: 'hi', userName: 'TV Time user', origin: { kind: 'tvtime', slug: 'tvtime', displayName: 'TV Time' },
      likeCount: 4, replyCount: 1, isSpoiler: true, viewerLiked: true,
    } as never);
    expect(t).toMatchObject({ id: 'a', text: 'hi', likes: 4, replyCount: 1, isSpoiler: true, origin: { kind: 'tvtime' } });
    expect(JSON.stringify(t)).not.toContain('viewer');
  });
});

describe('GET /v1/commsuni/comments', () => {
  let env: Env;
  let calls: { url: string; headers: Headers }[];
  let reply: { status: number; body: unknown };

  beforeEach(() => {
    const fresh = freshDatabase();
    fresh.raw.prepare(`INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES ('p1', 'a', 'a', '2026-09-29')`).run();
    env = { ...makeEnv(fresh.db), COMMSUNI_API_KEY: 'tvta_live_test' };
    calls = [];
    reply = { status: 200, body: { data: { comments: [{ id: 'c1', text: 'great', origin: { kind: 'tvtime', slug: 'tvtime' } }], nextCursor: null } } };
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: new Headers(init.headers) });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const get = async (q = 'type=episode&id=289590&season=1&episode=2') =>
    call(env, 'GET', `/v1/commsuni/comments?${q}`, { token: await tokenFor(env, 'p1') });

  it('needs a signed-in member', async () => {
    expect((await call(env, 'GET', '/v1/commsuni/comments?type=show&id=1')).status).toBe(401);
  });

  it('sends the key and an opaque actor id, and never a device header', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.json.comments[0].text).toBe('great');
    expect(calls[0]!.url).toBe('https://api.commsuni.tv/v1/entities/episode/tvdb-289590-s1e2/comments?limit=20&sort=most_liked');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer tvta_live_test');
    expect(calls[0]!.headers.get('x-tvta-actor-id')).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0]!.headers.get('origin')).toBeNull();
  });

  it('answers a repeat read from the cache', async () => {
    await get();
    await new Promise((r) => setTimeout(r, 5));
    await get();
    expect(calls).toHaveLength(1);
  });

  it('turns "never archived" into an empty thread', async () => {
    reply = { status: 404, body: { error: { code: 'not_archived' } } };
    const res = await get('type=show&id=99');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ comments: [], nextCursor: null, archived: false });
  });

  it('stops asking for a minute after a 429', async () => {
    reply = { status: 429, body: { error: { code: 'rate_limited' } } };
    expect((await get('type=show&id=1')).status).toBe(503);
    expect((await get('type=show&id=2')).status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it('is off, quietly, when no key is configured', async () => {
    env = { ...env, COMMSUNI_API_KEY: undefined };
    expect((await get()).status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});
