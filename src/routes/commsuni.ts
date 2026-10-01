import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';

/**
 * The CommsUni consent record.
 *
 * WHY THE SERVER HOLDS THIS AND NOT THE PHONE. The phone keeps a copy so it
 * can behave correctly offline, but a copy on a device somebody can reinstall
 * is not a record of anything. The backfill guide requires the decision to
 * exist server-side BEFORE any of that user's comments are sent, because the
 * question it answers is asked later and by somebody else: what did this
 * person agree to, when, and to which words.
 *
 * APPEND-ONLY. Every decision is a new row and nothing is ever updated, so a
 * withdrawal cannot erase the evidence that consent was once given, and
 * consent cannot erase a withdrawal. "Their current answer" is the newest row;
 * everything before it is the history that makes the current answer provable.
 *
 * PENDING IS NOT STORED. A dismissed or unanswered prompt writes nothing. The
 * guide is explicit that it stays `pending` and is not `keep_private` —
 * inactivity is neither permission nor refusal — so "no row" is the honest
 * representation and the app may ask again without having recorded an answer
 * nobody gave.
 */
export const commsuni = new Hono<App>();

type Decision = 'share' | 'keep_private';
type Identity = 'profile' | 'persona';

type Body = {
  decision?: unknown;
  identity?: unknown;
  promptVersion?: unknown;
  coversExisting?: unknown;
};

commsuni.post('/commsuni/consent', requireAuth, async (c) => {
  let body: Body;
  try {
    body = (await c.req.json()) as Body;
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }

  const decision = body.decision;
  if (decision !== 'share' && decision !== 'keep_private') {
    // 'pending' is deliberately not accepted. It is the absence of a record,
    // not a value, and letting a client write it would turn "we never asked"
    // into something indistinguishable from an answer.
    return fail(c, 400, 'invalid_body', 'decision must be share or keep_private.');
  }

  const identity = body.identity === 'persona' ? 'persona' : body.identity === 'profile' ? 'profile' : null;
  if (decision === 'share' && identity === null) {
    // The guide asks the identity question only of somebody who has agreed to
    // share — but it does ask it, and a shared comment has to be attributed
    // one way or the other before it is written.
    return fail(c, 400, 'invalid_body', 'identity is required when sharing.');
  }

  const promptVersion = Number(body.promptVersion);
  if (!Number.isInteger(promptVersion) || promptVersion < 1) {
    return fail(c, 400, 'invalid_body', 'promptVersion must be a positive integer.');
  }

  await c.env.DB.prepare(
    `INSERT INTO commsuni_consent (id, profile_id, decision, identity, prompt_version, covers_existing, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      c.get('profileId'),
      decision,
      // Never stored on a refusal: there is no identity to choose when nothing
      // is being shared, and a value here would imply one was offered.
      decision === 'share' ? identity : null,
      promptVersion,
      body.coversExisting === true ? 1 : 0,
      new Date().toISOString(),
    )
    .run();

  return c.json({ ok: true, decision, identity: decision === 'share' ? identity : null });
});

/**
 * The current answer, and whether history may be sent.
 *
 * `backfillAllowed` is computed here rather than left to a caller to work out,
 * because getting it wrong means publishing somebody's years of writing on the
 * strength of a prompt that never mentioned it. The guide's rule: consent to
 * the shared feature authorises backfill ONLY when the prompt disclosed that
 * existing comments were included.
 */
commsuni.get('/commsuni/consent', requireAuth, async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT decision, identity, prompt_version, covers_existing, decided_at
       FROM commsuni_consent WHERE profile_id = ?
      ORDER BY decided_at DESC LIMIT 1`,
  )
    .bind(c.get('profileId'))
    .first<{
      decision: Decision;
      identity: Identity | null;
      prompt_version: number;
      covers_existing: number;
      decided_at: string;
    }>();

  if (!row) return c.json({ decision: 'pending', backfillAllowed: false });

  return c.json({
    decision: row.decision,
    identity: row.identity,
    promptVersion: row.prompt_version,
    coversExisting: row.covers_existing === 1,
    decidedAt: row.decided_at,
    backfillAllowed: row.decision === 'share' && row.covers_existing === 1,
  });
});

/* ── reading the shared board ──────────────────────────────────────────────────
 *
 * PHASE ONE IS READ-ONLY. Comments from the TV Time archive and other CommsUni
 * apps, under an episode, a show or a film. Nothing is written upstream yet.
 *
 * THE KEY NEVER LEAVES THIS WORKER (guide §1): the phone asks us, we ask
 * CommsUni with the key and an opaque per-user actor id (§2), and hand back a
 * trimmed copy. Members only — the guide asks that archive reads not be open to
 * signed-out guests, and our own rule is that somebody who declined the
 * community never contacts this server at all.
 *
 * CACHED FOR BURST PROTECTION, NOT FRESHNESS (§8): a minute for a page (KV's
 * shortest life), three hours for "nothing archived here". The viewer-specific
 * fields are dropped, so one cached page serves everybody on the same thread.
 * A 429 starts a one-minute cooldown in which we stop asking — the key is
 * metered, and a queue of retries is how a quota becomes an outage.
 */

const COMMSUNI_BASE = 'https://api.commsuni.tv/v1';
const COOLDOWN_KEY = 'commsuni:cooldown';

/** HMAC-SHA256(SESSION_SECRET, "commsuni:" + profileId), hex — opaque, stable
 *  per member across devices, and derived here so no device can choose it. */
async function actorId(secret: string, profileId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`commsuni:${profileId}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type Upstream = { status: number; body: unknown };

/** One request to CommsUni with an allowlisted set of headers — never the
 *  device's own (§1: no forwarded Origin). */
async function upstream(env: App['Bindings'], path: string, actor: string): Promise<Upstream> {
  const res = await fetch(`${COMMSUNI_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${env.COMMSUNI_API_KEY}`,
      Accept: 'application/json',
      'X-TVTA-Actor-ID': actor,
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

type RawSource = { slug?: unknown; displayName?: unknown; shortName?: unknown; accentColor?: unknown; iconUrl?: unknown; status?: unknown };

/** GET /v1/commsuni/sources — the branding table the banner and badges need. */
commsuni.get('/commsuni/sources', requireAuth, async (c) => {
  if (!c.env.COMMSUNI_API_KEY) return fail(c, 503, 'unavailable', 'CommsUni is not configured.');
  const cached = await c.env.CACHE.get('commsuni:sources');
  if (cached) return c.body(cached, 200, { 'Content-Type': 'application/json' });
  if (await c.env.CACHE.get(COOLDOWN_KEY)) return fail(c, 503, 'unavailable', 'Try again later.');

  const up = await upstream(c.env, '/sources', await actorId(c.env.SESSION_SECRET, c.get('profileId')));
  if (up.status === 429) await c.env.CACHE.put(COOLDOWN_KEY, '1', { expirationTtl: 60 });
  const rows = (up.body as { data?: RawSource[] } | null)?.data;
  if (up.status !== 200 || !Array.isArray(rows)) return fail(c, 503, 'unavailable', 'Try again later.');

  const sources = rows
    .filter((r) => typeof r.slug === 'string' && r.status !== 'inactive')
    .map((r) => ({
      slug: String(r.slug),
      displayName: typeof r.displayName === 'string' ? r.displayName : String(r.slug),
      icon: typeof r.iconUrl === 'string' ? r.iconUrl : null,
      accent: typeof r.accentColor === 'string' ? r.accentColor : null,
    }));
  const body = JSON.stringify({ sources });
  // The guide: the catalogue changes when an app joins, not per request.
  await c.env.CACHE.put('commsuni:sources', body, { expirationTtl: 24 * 60 * 60 });
  return c.body(body, 200, { 'Content-Type': 'application/json' });
});

type RawComment = {
  id?: unknown;
  text?: unknown;
  language?: unknown;
  createdAt?: unknown;
  userName?: unknown;
  userAvatar?: unknown;
  userColor?: unknown;
  origin?: { kind?: unknown; slug?: unknown; displayName?: unknown };
  likeCount?: unknown;
  replyCount?: unknown;
  isSpoiler?: unknown;
  deleted?: unknown;
  imageUrl?: unknown;
  attachments?: unknown;
};

/** The comment's picture, when it has one: https only, as other apps host it. */
function imageOf(r: RawComment): string | null {
  const first = Array.isArray(r.attachments) ? (r.attachments[0] as { url?: unknown; contentType?: unknown } | undefined) : undefined;
  const url = typeof r.imageUrl === 'string' ? r.imageUrl : typeof first?.url === 'string' ? first.url : null;
  return url && /^https:\/\//.test(url) && url.length <= 1024 ? url : null;
}

/** Only what the app draws. Tombstones are dropped whole (§3: hide them
 *  completely), and viewer state is dropped so the page can be shared. */
export function trimComment(r: RawComment) {
  if (r.deleted === true || typeof r.id !== 'string' || typeof r.text !== 'string') return null;
  const kind = r.origin?.kind === 'tvtime' ? 'tvtime' : 'partner';
  return {
    id: r.id,
    text: r.text,
    language: typeof r.language === 'string' ? r.language : null,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    author: {
      name: typeof r.userName === 'string' ? r.userName : null,
      avatar: typeof r.userAvatar === 'string' ? r.userAvatar : null,
      color: typeof r.userColor === 'string' ? r.userColor : null,
    },
    origin: {
      kind,
      slug: typeof r.origin?.slug === 'string' ? r.origin.slug : kind,
      displayName: typeof r.origin?.displayName === 'string' ? r.origin.displayName : kind === 'tvtime' ? 'TV Time' : '',
    },
    likes: typeof r.likeCount === 'number' ? r.likeCount : 0,
    replyCount: typeof r.replyCount === 'number' ? r.replyCount : 0,
    isSpoiler: r.isSpoiler === true,
    image: imageOf(r),
  };
}

/** The upstream path for one of our targets, or null when it cannot be one. */
export function commsuniPath(q: { type?: string; id?: string; season?: string; episode?: string; sort?: string; cursor?: string }): string | null {
  const id = q.id ?? '';
  if (!/^\d{1,10}$/.test(id)) return null;
  let ref: string;
  if (q.type === 'show' || q.type === 'movie') ref = `${q.type}/tvdb-${id}`;
  else if (q.type === 'episode') {
    if (!/^\d{1,4}$/.test(q.season ?? '') || !/^\d{1,5}$/.test(q.episode ?? '')) return null;
    ref = `episode/tvdb-${id}-s${Number(q.season)}e${Number(q.episode)}`;
  } else return null;
  const p = new URLSearchParams({ limit: '20', sort: q.sort === 'most_recent' ? 'most_recent' : 'most_liked' });
  if (q.cursor && q.cursor.length <= 512) p.set('cursor', q.cursor);
  return `/entities/${ref}/comments?${p.toString()}`;
}

/**
 * GET /v1/commsuni/comments?type=episode&id=<show tvdb>&season=1&episode=2
 *                          [&sort=most_liked|most_recent][&cursor=...]
 * type=show|movie take only `id` (a TVDB series or film id).
 */
commsuni.get('/commsuni/comments', requireAuth, async (c) => {
  if (!c.env.COMMSUNI_API_KEY) return fail(c, 503, 'unavailable', 'CommsUni is not configured.');
  const path = commsuniPath({
    type: c.req.query('type'),
    id: c.req.query('id'),
    season: c.req.query('season'),
    episode: c.req.query('episode'),
    sort: c.req.query('sort'),
    cursor: c.req.query('cursor'),
  });
  if (!path) return fail(c, 400, 'invalid_body', 'Unknown target.');

  const cacheKey = `commsuni:c:${path}`;
  const cached = await c.env.CACHE.get(cacheKey);
  if (cached) return c.body(cached, 200, { 'Content-Type': 'application/json' });
  if (await c.env.CACHE.get(COOLDOWN_KEY)) return fail(c, 503, 'unavailable', 'Try again later.');

  let up: Upstream;
  try {
    up = await upstream(c.env, path, await actorId(c.env.SESSION_SECRET, c.get('profileId')));
  } catch {
    return fail(c, 503, 'unavailable', 'Try again later.');
  }

  if (up.status === 404) {
    // Never archived. Not an error — the same empty state as a quiet thread —
    // and cached for hours, as the guide asks, since the first native comment
    // is the only thing that would change it.
    const body = JSON.stringify({ comments: [], nextCursor: null, archived: false });
    await c.env.CACHE.put(cacheKey, body, { expirationTtl: 3 * 60 * 60 });
    return c.body(body, 200, { 'Content-Type': 'application/json' });
  }
  if (up.status === 429) await c.env.CACHE.put(COOLDOWN_KEY, '1', { expirationTtl: 60 });
  const data = (up.body as { data?: { comments?: RawComment[]; nextCursor?: unknown } } | null)?.data;
  if (up.status !== 200 || !data || !Array.isArray(data.comments)) {
    if (up.status !== 429) console.log(`[commsuni] ${up.status} ${JSON.stringify((up.body as { error?: unknown } | null)?.error ?? null)}`);
    return fail(c, 503, 'unavailable', 'Try again later.');
  }

  const body = JSON.stringify({
    comments: data.comments.map(trimComment).filter((x) => x !== null),
    nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
    archived: true,
  });
  await c.env.CACHE.put(cacheKey, body, { expirationTtl: 60 });
  return c.body(body, 200, { 'Content-Type': 'application/json' });
});

/**
 * GET /v1/commsuni/replies?id=<comment uuid>[&cursor=...]
 *
 * One thread's replies, fetched only when somebody taps to open it (the guide:
 * "fetch replies lazily when the user expands a thread"). Same trim, same
 * one-minute cache and 429 cooldown as a comment page.
 */
commsuni.get('/commsuni/replies', requireAuth, async (c) => {
  if (!c.env.COMMSUNI_API_KEY) return fail(c, 503, 'unavailable', 'CommsUni is not configured.');
  const id = c.req.query('id') ?? '';
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return fail(c, 400, 'invalid_body', 'Unknown comment.');
  const p = new URLSearchParams({ limit: '50', sort: 'most_recent' });
  const cursor = c.req.query('cursor');
  if (cursor && cursor.length <= 512) p.set('cursor', cursor);
  const path = `/comments/${id}/replies?${p.toString()}`;

  const cacheKey = `commsuni:r:${path}`;
  const cached = await c.env.CACHE.get(cacheKey);
  if (cached) return c.body(cached, 200, { 'Content-Type': 'application/json' });
  if (await c.env.CACHE.get(COOLDOWN_KEY)) return fail(c, 503, 'unavailable', 'Try again later.');

  let up: Upstream;
  try {
    up = await upstream(c.env, path, await actorId(c.env.SESSION_SECRET, c.get('profileId')));
  } catch {
    return fail(c, 503, 'unavailable', 'Try again later.');
  }
  if (up.status === 429) await c.env.CACHE.put(COOLDOWN_KEY, '1', { expirationTtl: 60 });
  const data = (up.body as { data?: { replies?: RawComment[]; nextCursor?: unknown } } | null)?.data;
  if (up.status !== 200 || !data || !Array.isArray(data.replies)) {
    if (up.status !== 429) console.log(`[commsuni] replies ${up.status}`);
    return fail(c, 503, 'unavailable', 'Try again later.');
  }
  const body = JSON.stringify({
    replies: data.replies.map(trimComment).filter((x) => x !== null),
    nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
  });
  await c.env.CACHE.put(cacheKey, body, { expirationTtl: 60 });
  return c.body(body, 200, { 'Content-Type': 'application/json' });
});

