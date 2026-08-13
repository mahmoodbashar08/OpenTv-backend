import { Buffer } from 'node:buffer';
import { Hono } from 'hono';
import type { App, Env } from '@/env';
import { fail } from '@/http';
import { overBudget } from '@/rate-limit';

/**
 * The one page that looks at the whole server, and the smallest thing that can
 * be.
 *
 * SERVED BY THE WORKER, not Pages. The numbers live in D1 and only the Worker
 * can read them, so a page hosted anywhere else would need CORS opened on an
 * API that currently has none, and a token in browser storage where every
 * script on the page can read it. Same-origin costs one route and buys an
 * HttpOnly cookie that JavaScript cannot touch at all.
 *
 * COUNTS ONLY, DELIBERATELY. This reads how MANY comments exist, never what
 * they say; how many accounts, never whose. The rule the analytics module is
 * built on — shape, never content — is not weaker because the person looking
 * owns the server. A dashboard that lists other people's writing is a habit
 * that ends with reading it.
 *
 * NOT THE APP'S SESSION. An admin token is its own signature with its own
 * prefix, so a user token can never be replayed here and this cookie can never
 * act as a user. There is no admin flag on any profile — nothing to
 * accidentally grant.
 */
export const admin = new Hono<App>();

const COOKIE = 'otv_admin';
/** Short, because it protects a password typed into a browser on a laptop. */
const TTL_SECONDS = 12 * 60 * 60;
/** Five attempts an hour per address. A password in a form is guessable. */
const LOGIN_BUDGET = { limit: 5, windowSeconds: 3600 };

function b64url(bytes: Uint8Array | string): string {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Length-independent, so a wrong answer costs the same as a right one. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(env: Env, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`admin:${env.SESSION_SECRET}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}

async function issue(env: Env, nowMs: number): Promise<string> {
  const payload = b64url(JSON.stringify({ exp: Math.floor(nowMs / 1000) + TTL_SECONDS }));
  return `${payload}.${await hmac(env, payload)}`;
}

async function valid(env: Env, token: string | undefined, nowMs: number): Promise<boolean> {
  if (!token) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  if (!constantTimeEqual(sig, await hmac(env, payload))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { exp: number };
    return typeof exp === 'number' && exp * 1000 > nowMs;
  } catch {
    return false;
  }
}

function cookieFrom(header: string | undefined): string | undefined {
  return header
    ?.split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
}

// ── POST /v1/admin/login ─────────────────────────────────────────────────────

admin.post('/admin/login', async (c) => {
  // NO PASSWORD CONFIGURED MEANS NO DOOR. An unset secret must refuse
  // everything rather than accept everything, which is what comparing against
  // undefined would quietly do.
  const expectedEmail = c.env.ADMIN_EMAIL;
  const expectedPassword = c.env.ADMIN_PASSWORD;
  if (!expectedEmail || !expectedPassword) {
    return fail(c, 503, 'unavailable', 'No administrator is configured.');
  }

  const ip = c.req.header('CF-Connecting-IP') ?? '0.0.0.0';
  if (await overBudget(c.env, 'admin', ip, LOGIN_BUDGET, Date.now())) {
    return fail(c, 429, 'rate_limited', 'Too many attempts. Try again later.');
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const password = typeof b.password === 'string' ? b.password : '';

  // Both compared, both constant-time, and the failure says neither which was
  // wrong nor that the address exists.
  const ok =
    constantTimeEqual(email, expectedEmail.trim().toLowerCase()) && constantTimeEqual(password, expectedPassword);
  if (!ok) return fail(c, 401, 'unauthenticated', 'Wrong email or password.');

  const token = await issue(c.env, Date.now());
  // HttpOnly: unreadable by any script on the page, so an injected one cannot
  // steal the session. SameSite=Strict: no other site can make an authenticated
  // request with it.
  c.header(
    'Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${TTL_SECONDS}`,
  );
  return c.json({ ok: true });
});

admin.post('/admin/logout', (c) => {
  c.header('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
  return c.json({ ok: true });
});

// ── GET /v1/admin/stats ──────────────────────────────────────────────────────

admin.get('/admin/stats', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }

  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM profiles WHERE deleted_at IS NULL)                      AS accounts,
       (SELECT COUNT(*) FROM profiles WHERE deleted_at IS NOT NULL)                  AS deleted,
       (SELECT COUNT(*) FROM profiles WHERE deleted_at IS NULL
          AND handle LIKE 'user!_p!_%' ESCAPE '!')                                   AS placeholder_handles,
       (SELECT COUNT(*) FROM identities WHERE provider = 'email')                    AS via_email,
       (SELECT COUNT(*) FROM identities WHERE provider = 'google')                   AS via_google,
       (SELECT COUNT(*) FROM identities WHERE provider = 'apple')                    AS via_apple,
       (SELECT COUNT(*) FROM email_credentials WHERE verified_at IS NULL)            AS unconfirmed,
       (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL)                      AS comments,
       (SELECT COUNT(*) FROM ratings)                                                AS ratings,
       (SELECT COUNT(*) FROM character_votes)                                        AS character_votes,
       (SELECT COUNT(*) FROM emotion_votes)                                          AS emotion_votes,
       (SELECT COUNT(*) FROM comment_likes)                                          AS likes,
       (SELECT COUNT(*) FROM follows)                                                AS follows,
       (SELECT COUNT(*) FROM lists)                                                  AS lists,
       (SELECT COUNT(*) FROM comment_images)                                         AS images,
       (SELECT COUNT(*) FROM push_tokens)                                            AS push_devices,
       -- The queue that has a clock on it: a report unanswered for 24 hours is
       -- the one number here worth being woken up about.
       (SELECT COUNT(*) FROM reports WHERE resolved_at IS NULL)                      AS open_reports`,
  ).first<Record<string, number>>();

  // Joins per day for the last fortnight — enough to see whether an
  // announcement did anything, and small enough to draw as bars.
  const joins = await c.env.DB.prepare(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
       FROM profiles
      WHERE deleted_at IS NULL AND created_at >= date('now', '-13 days')
      GROUP BY day ORDER BY day`,
  ).all<{ day: string; n: number }>();

  return c.json({ totals: row ?? {}, joins: joins.results ?? [] }, 200, {
    'Cache-Control': 'no-store',
  });
});

// ── GET /v1/admin/users ──────────────────────────────────────────────────────

/**
 * WHO IS HERE — and the line this route sits on.
 *
 * The stats route reads how many; this one reads who. That is a real step, and
 * it is taken deliberately rather than by accident: an owner needs to see that
 * an account is stuck on a placeholder handle, or that somebody registered and
 * never confirmed, and neither is answerable by a count.
 *
 * WHAT IT STILL WILL NOT SHOW: a single word anybody wrote. Comment bodies,
 * ratings, what they watched — none of it is selected here, and the counts
 * beside each person say how much, never what. Moderation reads content
 * through the report queue, where somebody has asked for it to be read.
 */
admin.get('/admin/users', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }

  const res = await c.env.DB.prepare(
    `SELECT p.handle,
            p.display_name,
            p.created_at,
            -- The address only where the person typed one into this app. A
            -- provider's copy is Apple's or Google's to show, not ours to
            -- collect a list of.
            c.email,
            c.verified_at IS NULL AND c.profile_id IS NOT NULL AS unconfirmed,
            (SELECT GROUP_CONCAT(provider) FROM identities i WHERE i.profile_id = p.id) AS providers,
            (SELECT COUNT(*) FROM comments  x WHERE x.author_id = p.id AND x.deleted_at IS NULL) AS comments,
            (SELECT COUNT(*) FROM ratings   x WHERE x.author_id = p.id) AS ratings,
            (SELECT COUNT(*) FROM follows   x WHERE x.followee_id = p.id) AS followers,
            (SELECT COUNT(*) FROM lists     x WHERE x.owner_id = p.id) AS lists,
            -- How many of their photographs the rescue actually caught. Zero
            -- against thousands of comments means their import ran after TV
            -- Time's CDN died, and those pictures are gone for good.
            (SELECT COUNT(*) FROM comment_images ci
               JOIN comments cm ON cm.id = ci.comment_id
              WHERE cm.author_id = p.id) AS images
       FROM profiles p
       LEFT JOIN email_credentials c ON c.profile_id = p.id
      WHERE p.deleted_at IS NULL
      ORDER BY p.created_at DESC
      LIMIT 200`,
  ).all<Record<string, unknown>>();

  return c.json({ items: res.results ?? [] }, 200, { 'Cache-Control': 'no-store' });
});
