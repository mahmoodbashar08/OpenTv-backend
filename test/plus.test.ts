import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { FREE_MAX_FAVOURITES, FREE_MAX_LISTS } from '@/routes/published';
import { call, freshDatabase, insertProfile, makeEnv, tokenFor } from './harness';

/**
 * OpenTV Plus: the webhook that grants it, and the caps it lifts.
 *
 * The three things here that can be wrong invisibly:
 *
 *  1. THE DOOR. An unset secret that opens rather than closes hands free Plus
 *     to anybody who finds the URL, and nothing in the app would ever show it.
 *  2. WHICH EVENTS REVOKE. CANCELLATION means auto-renew is off, not that the
 *     period ended; revoking on it takes a feature away from somebody who has
 *     paid for the month they are standing in.
 *  3. GRANDFATHERING. The publish intake REPLACES the whole set, so a cap that
 *     binds retroactively deletes last year's work on the next background sync,
 *     with nobody pressing anything.
 */

const SECRET = 'rc-shared-secret-from-the-dashboard';

let raw: Database.Database;
let env: Env;
let token: string;

const rcEvent = (event: Record<string, unknown>, secret: string | null = SECRET) =>
  call(env, 'POST', '/v1/rc/webhook', {
    body: { api_version: '1.0', event },
    headers: secret === null ? {} : { Authorization: secret },
  });

const isPlusRow = (id: string) =>
  raw.prepare('SELECT is_plus, plus_since FROM profiles WHERE id = ?').get(id) as {
    is_plus: number;
    plus_since: string | null;
  };

beforeEach(async () => {
  const fresh = freshDatabase();
  raw = fresh.raw;
  env = { ...makeEnv(fresh.db), RC_WEBHOOK_SECRET: SECRET };
  insertProfile(raw, 'p1', 'mahmood');
  insertProfile(raw, 'p2', 'sara');
  token = await tokenFor(env, 'p1');
});

describe('POST /v1/rc/webhook — the door', () => {
  it('refuses everything when no secret is configured', async () => {
    const bare = makeEnv(freshDatabase().db);
    const res = await call(bare, 'POST', '/v1/rc/webhook', {
      body: { event: { type: 'INITIAL_PURCHASE', app_user_id: 'p1' } },
      headers: { Authorization: 'anything' },
    });
    // The dangerous failure is comparing against undefined and granting Plus.
    expect(res.status).toBe(503);
  });

  it('refuses a wrong secret and a missing one', async () => {
    expect((await rcEvent({ type: 'INITIAL_PURCHASE', app_user_id: 'p1' }, 'wrong')).status).toBe(401);
    expect((await rcEvent({ type: 'INITIAL_PURCHASE', app_user_id: 'p1' }, null)).status).toBe(401);
    expect(isPlusRow('p1').is_plus).toBe(0);
  });
});

describe('POST /v1/rc/webhook — the entitlement', () => {
  const grant = (type: string) =>
    rcEvent({ type, app_user_id: 'p1', entitlement_ids: ['plus'], product_id: 'otv_plus_monthly' });

  it.each(['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE'])('grants on %s', async (type) => {
    const res = await grant(type);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, matched: true });
    expect(isPlusRow('p1').is_plus).toBe(1);
  });

  it('stamps plus_since once and never moves it', async () => {
    await grant('INITIAL_PURCHASE');
    const first = isPlusRow('p1').plus_since;
    expect(first).toBeTruthy();
    await grant('RENEWAL');
    // A renewal that moved this would make "member since" read as today, every
    // month.
    expect(isPlusRow('p1').plus_since).toBe(first);
  });

  it('is idempotent — the same event twice is the same row', async () => {
    await grant('INITIAL_PURCHASE');
    await grant('INITIAL_PURCHASE');
    expect(isPlusRow('p1')).toEqual({ is_plus: 1, plus_since: isPlusRow('p1').plus_since });
  });

  it('ignores an entitlement that is not ours', async () => {
    const res = await rcEvent({ type: 'INITIAL_PURCHASE', app_user_id: 'p1', entitlement_ids: ['pro'] });
    expect(res.status).toBe(200);
    expect(res.json.matched).toBe(false);
    expect(isPlusRow('p1').is_plus).toBe(0);
  });

  it('revokes on EXPIRATION', async () => {
    await grant('INITIAL_PURCHASE');
    const res = await rcEvent({ type: 'EXPIRATION', app_user_id: 'p1', entitlement_ids: ['plus'] });
    expect(res.status).toBe(200);
    // The date stays: it is "member since", not the billing state.
    expect(isPlusRow('p1').is_plus).toBe(0);
    expect(isPlusRow('p1').plus_since).toBeTruthy();
  });

  it('does NOT revoke on CANCELLATION or BILLING_ISSUE — the period is still paid for', async () => {
    await grant('INITIAL_PURCHASE');
    await rcEvent({ type: 'CANCELLATION', app_user_id: 'p1', entitlement_ids: ['plus'] });
    expect(isPlusRow('p1').is_plus).toBe(1);
    await rcEvent({ type: 'BILLING_ISSUE', app_user_id: 'p1', entitlement_ids: ['plus'] });
    expect(isPlusRow('p1').is_plus).toBe(1);
  });

  it('ignores an anonymous RevenueCat id with a 200 — there is nothing to map', async () => {
    const res = await rcEvent({
      type: 'INITIAL_PURCHASE',
      app_user_id: '$RCAnonymousID:8a9f2c0d1e',
      entitlement_ids: ['plus'],
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, matched: false });
  });

  it('answers 200 for a profile it has never heard of — a 4xx would be retried for ever', async () => {
    const res = await rcEvent({ type: 'RENEWAL', app_user_id: 'p_nobody', entitlement_ids: ['plus'] });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, matched: false });
  });

  it('moves the flag on TRANSFER, and clears the side that lost it', async () => {
    await grant('INITIAL_PURCHASE');
    const res = await rcEvent({
      type: 'TRANSFER',
      transferred_from: ['p1'],
      transferred_to: ['p2'],
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, matched: true });
    expect(isPlusRow('p1').is_plus).toBe(0);
    expect(isPlusRow('p2').is_plus).toBe(1);
  });

  it('transfers nothing when the source never had it', async () => {
    await rcEvent({ type: 'TRANSFER', transferred_from: ['$RCAnonymousID:zz'], transferred_to: ['p2'] });
    expect(isPlusRow('p2').is_plus).toBe(0);
  });
});

describe('the flag reaches every profile payload', () => {
  it('shows on a public profile, a search result and a follower row', async () => {
    raw.prepare('UPDATE profiles SET is_plus = 1 WHERE id = ?').run('p2');
    raw
      .prepare("INSERT INTO follows (follower_id, followee_id, created_at) VALUES ('p1', 'p2', '2026-01-02T00:00:00.000Z')")
      .run();

    expect((await call(env, 'GET', '/v1/profiles/sara')).json.is_plus).toBe(true);
    expect((await call(env, 'GET', '/v1/users?q=sar')).json.items[0].is_plus).toBe(true);
    expect((await call(env, 'GET', '/v1/me/following', { token })).json.items[0].is_plus).toBe(true);
    expect((await call(env, 'GET', '/v1/profiles/mahmood')).json.is_plus).toBe(false);
  });

  it('still honours a hand-granted plus_until, which is the support escape hatch', async () => {
    raw.prepare('UPDATE profiles SET plus_until = ? WHERE id = ?').run('2099-01-01T00:00:00.000Z', 'p2');
    expect((await call(env, 'GET', '/v1/profiles/sara')).json.is_plus).toBe(true);
  });
});

// ── the caps ────────────────────────────────────────────────────────────────

const list = (i: number) => ({ name: `List ${i}`, items: [] });

const publishLists = (n: number) =>
  call(env, 'POST', '/v1/published/lists', {
    token,
    body: { lists: Array.from({ length: n }, (_, i) => list(i)) },
  });

const countLists = () =>
  (raw.prepare("SELECT COUNT(*) AS n FROM lists WHERE owner_id = 'p1'").get() as { n: number }).n;

describe('published lists are capped for a free profile', () => {
  it('keeps the first ten in the order the phone sent, and says so', async () => {
    const res = await publishLists(15);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ lists: FREE_MAX_LISTS, capped: true, kept: FREE_MAX_LISTS });
    expect(countLists()).toBe(FREE_MAX_LISTS);
    const first = raw.prepare("SELECT name FROM lists WHERE owner_id = 'p1' ORDER BY position").all() as {
      name: string;
    }[];
    expect(first.map((r) => r.name)).toEqual(Array.from({ length: 10 }, (_, i) => `List ${i}`));
  });

  it('says nothing about capping when the cap did not bite', async () => {
    const res = await publishLists(3);
    expect(res.json).toEqual({ lists: 3 });
  });

  it('GRANDFATHERS what was published before Plus existed — twelve stay twelve', async () => {
    // Twelve rows already on the server, as a profile published in 1.2.0 would
    // have. The cap must not delete two of them on the next background sync.
    for (let i = 0; i < 12; i++) {
      raw
        .prepare(
          `INSERT INTO lists (id, owner_id, name, description, is_public, created_at, position)
           VALUES (?, 'p1', ?, NULL, 1, '2026-01-01T00:00:00.000Z', ?)`,
        )
        .run(`l${i}`, `Old ${i}`, i);
    }

    const res = await publishLists(15);
    expect(res.json).toEqual({ lists: 12, capped: true, kept: 12 });
    expect(countLists()).toBe(12);

    // And it does not ratchet upwards for ever: a smaller publish is honoured
    // as-is, because REPLACE is the intake's whole contract.
    expect((await publishLists(4)).json).toEqual({ lists: 4 });
  });

  it('does not cap a Plus profile', async () => {
    raw.prepare('UPDATE profiles SET is_plus = 1 WHERE id = ?').run('p1');
    expect((await publishLists(15)).json).toEqual({ lists: 15 });
    expect(countLists()).toBe(15);
  });
});

const favourite = (i: number, fav: boolean) => ({
  target_source: 'tvdb',
  target_key: String(1000 + i),
  name: `Show ${i}`,
  favourite: fav,
  rank: i,
});

const publishFavourites = (n: number, extras = 0) =>
  call(env, 'PUT', '/v1/me/published', {
    token,
    body: {
      kind: 'show',
      stats: {},
      titles: [
        ...Array.from({ length: n }, (_, i) => favourite(i, true)),
        ...Array.from({ length: extras }, (_, i) => favourite(500 + i, false)),
      ],
    },
  });

const countFavourites = () =>
  (raw.prepare("SELECT COUNT(*) AS n FROM profile_titles WHERE profile_id = 'p1' AND favourite = 1").get() as {
    n: number;
  }).n;

describe('published favourites are capped for a free profile', () => {
  it('keeps twenty, and keeps the rest of the shelf as ordinary titles', async () => {
    const res = await publishFavourites(25, 5);
    expect(res.json).toEqual({ ok: true, kind: 'show', titles: 30, capped: true, kept: FREE_MAX_FAVOURITES });
    expect(countFavourites()).toBe(FREE_MAX_FAVOURITES);
    // THE SHELF IS INTACT. The star came off; nothing was deleted.
    expect(
      (raw.prepare("SELECT COUNT(*) AS n FROM profile_titles WHERE profile_id = 'p1'").get() as { n: number }).n,
    ).toBe(30);
    // The first twenty in the client's own order are the ones that kept it.
    const starred = raw
      .prepare("SELECT target_key FROM profile_titles WHERE profile_id = 'p1' AND favourite = 1 ORDER BY rank")
      .all() as { target_key: string }[];
    expect(starred[0]!.target_key).toBe('1000');
    expect(starred[19]!.target_key).toBe('1019');
  });

  it('says nothing about capping when the cap did not bite', async () => {
    expect((await publishFavourites(5)).json).toEqual({ ok: true, kind: 'show', titles: 5 });
  });

  it('GRANDFATHERS the favourites already published', async () => {
    raw.prepare('UPDATE profiles SET is_plus = 1 WHERE id = ?').run('p1');
    await publishFavourites(24);
    raw.prepare('UPDATE profiles SET is_plus = 0 WHERE id = ?').run('p1');

    // Twenty-four were up before the subscription lapsed; they stay up, and
    // only the twenty-fifth is refused.
    expect((await publishFavourites(30)).json).toEqual({ ok: true, kind: 'show', titles: 30, capped: true, kept: 24 });
    expect(countFavourites()).toBe(24);
  });

  it('does not cap a Plus profile', async () => {
    raw.prepare('UPDATE profiles SET is_plus = 1 WHERE id = ?').run('p1');
    expect((await publishFavourites(30)).json).toEqual({ ok: true, kind: 'show', titles: 30 });
    expect(countFavourites()).toBe(30);
  });
});

/**
 * The profile theme — the first Plus feature a visitor can see besides the
 * badge. The decisions worth pinning: setting it is paid, CLEARING it is not
 * (cosmetics are not stripped off a lapsed subscriber), the format check is
 * strict because every visitor's phone renders the value verbatim, and it
 * rides the public profile payload.
 */
describe('PATCH /v1/me theme_color', () => {
  let env: ReturnType<typeof makeEnv>;
  let raw: ReturnType<typeof freshDatabase>['raw'];

  beforeEach(() => {
    const fresh = freshDatabase();
    raw = fresh.raw;
    env = makeEnv(fresh.db);
    insertProfile(raw, 'p1', 'mahmood');
    insertProfile(raw, 'p2', 'sara');
  });

  it('needs Plus to set, with its own code so the app can answer with the paywall', async () => {
    const res = await call(env, 'PATCH', '/v1/me', {
      token: await tokenFor(env, 'p1'),
      body: { theme_color: '#8B5CF6' },
    });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('plus_required');
  });

  it('sets for a Plus profile, uppercased, and comes back on GET /v1/me', async () => {
    raw.prepare("UPDATE profiles SET is_plus = 1 WHERE id = 'p1'").run();
    const res = await call(env, 'PATCH', '/v1/me', {
      token: await tokenFor(env, 'p1'),
      body: { theme_color: '#8b5cf6' },
    });
    expect(res.status).toBe(200);
    expect(res.json.theme_color).toBe('#8B5CF6');
  });

  it('clears without Plus — a lapsed subscriber may always undo, never redo', async () => {
    raw.prepare("UPDATE profiles SET theme_color = '#8B5CF6' WHERE id = 'p1'").run();
    const res = await call(env, 'PATCH', '/v1/me', {
      token: await tokenFor(env, 'p1'),
      body: { theme_color: null },
    });
    expect(res.status).toBe(200);
    expect(res.json.theme_color).toBeNull();
  });

  it('refuses anything that is not #RRGGBB', async () => {
    raw.prepare("UPDATE profiles SET is_plus = 1 WHERE id = 'p1'").run();
    for (const bad of ['8B5CF6', '#8B5', '#8B5CF6FF', 'purple', '#8B5CG6']) {
      const res = await call(env, 'PATCH', '/v1/me', {
        token: await tokenFor(env, 'p1'),
        body: { theme_color: bad },
      });
      expect(res.status, bad).toBe(400);
    }
  });

  it('rides the public profile payload for every visitor', async () => {
    raw.prepare("UPDATE profiles SET theme_color = '#14C8B8' WHERE id = 'p2'").run();
    const res = await call(env, 'GET', '/v1/profiles/sara', {});
    expect(res.status).toBe(200);
    expect(res.json.theme_color).toBe('#14C8B8');
  });
});
