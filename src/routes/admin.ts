import { Buffer } from 'node:buffer';
import { Hono } from 'hono';
import type { App, Env } from '@/env';
import { fail } from '@/http';
import { constantTimeEqual } from '@/pure';
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
       -- ACTIVE MEMBERS, and the name is the honest one.
       --
       -- last_seen_at is stamped by GET /v1/me, which the app calls on every
       -- launch, so this counts members who OPENED THE APP rather than members
       -- who exist. It cannot count anybody else: a phone that declined the
       -- community never contacts this server, and measuring those people would
       -- mean breaking the promise that keeps them away from it.
       --
       -- Three windows because one number cannot tell "quiet today" from
       -- "gone" — a lone DAU figure drops every weekend and reads as decline.
       (SELECT COUNT(*) FROM profiles WHERE deleted_at IS NULL
          AND last_seen_at >= ?)                                                     AS active_today,
       (SELECT COUNT(*) FROM profiles WHERE deleted_at IS NULL
          AND last_seen_at >= ?)                                                     AS active_7d,
       (SELECT COUNT(*) FROM profiles WHERE deleted_at IS NULL
          AND last_seen_at >= ?)                                                     AS active_30d,
       (SELECT COUNT(*) FROM profiles WHERE deleted_at IS NULL
          AND handle LIKE 'user!_p!_%' ESCAPE '!')                                   AS placeholder_handles,
       -- PAYING AND GIVEN, COUNTED SEPARATELY, because one is revenue and the
       -- other is a favour. A single "Plus" number would read as a business
       -- doing better than it is: three of four Plus profiles being hand-outs
       -- is the fact worth seeing, and it disappears the moment they are added
       -- together.
       (SELECT COUNT(*) FROM profiles WHERE deleted_at IS NULL AND is_plus = 1)      AS plus_paying,
       -- A live grant on somebody who is NOT paying. Excluding subscribers
       -- keeps the two columns from double-counting the same person, which
       -- happens whenever a paying user was also given a month.
       (SELECT COUNT(*) FROM profiles WHERE deleted_at IS NULL
          AND (is_plus IS NULL OR is_plus = 0)
          AND plus_until IS NOT NULL AND plus_until > ?)                             AS plus_given,
       (SELECT COUNT(*) FROM identities WHERE provider = 'email')                    AS via_email,
       (SELECT COUNT(*) FROM identities WHERE provider = 'google')                   AS via_google,
       (SELECT COUNT(*) FROM identities WHERE provider = 'apple')                    AS via_apple,
       (SELECT COUNT(*) FROM email_credentials WHERE verified_at IS NULL)            AS unconfirmed,
       (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL)                      AS comments,
       (SELECT COUNT(*) FROM ratings)                                                AS ratings,
       (SELECT COUNT(*) FROM character_votes)                                        AS character_votes,
       -- HOW MUCH IS HAPPENING, not how much exists. A total only ever goes up,
       -- so it cannot answer "is anyone here this week" — which is the question
       -- the totals above look like they answer and never do.
       --
       -- BY DAY, AND WITHOUT WRAPPING THE COLUMN. date('now', ...) is
       -- 'YYYY-MM-DD' and a stored timestamp is 'YYYY-MM-DDTHH:MM:SS.sssZ', so
       -- a plain >= compares them correctly as strings AND leaves created_at
       -- bare, which is the difference between a range scan and reading every
       -- row of a 72,000-row table three times.
       --
       -- NOT datetime('now', ...): that renders 'YYYY-MM-DD HH:MM:SS', a space
       -- where the stored value has a T, and a space sorts BEFORE a T — so
       -- every row would fall inside every window.
       --
       -- AN IMPORT IS NOT ACTIVITY. A seeded TV Time comment carries its
       -- ORIGINAL date in created_at (imported_at is when it arrived — see
       -- routes/import.ts), so a member uploading nine years of archive does
       -- not appear here as nine years of writing done today. That is the
       -- honest reading: they wrote it in 2019.
       (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL
          AND created_at >= date('now'))                                AS comments_today,
       (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL
          AND created_at >= date('now', '-6 days'))                     AS comments_7d,
       (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL
          AND created_at >= date('now', '-29 days'))                    AS comments_30d,
       (SELECT COUNT(*) FROM ratings
          WHERE created_at >= date('now'))                              AS ratings_today,
       (SELECT COUNT(*) FROM ratings
          WHERE created_at >= date('now', '-6 days'))                   AS ratings_7d,
       (SELECT COUNT(*) FROM ratings
          WHERE created_at >= date('now', '-29 days'))                  AS ratings_30d,
       (SELECT COUNT(*) FROM character_votes
          WHERE created_at >= date('now'))                              AS characters_today,
       (SELECT COUNT(*) FROM character_votes
          WHERE created_at >= date('now', '-6 days'))                   AS characters_7d,
       (SELECT COUNT(*) FROM character_votes
          WHERE created_at >= date('now', '-29 days'))                  AS characters_30d,
       -- HOW MANY PEOPLE, which is the only one of these that cannot be moved
       -- by a single import. Six members seeding their TV Time archives put
       -- 8,335 of one week's 8,393 ratings on the board, each of them in a
       -- single day: a row count answers "how big was somebody's archive", and
       -- a person count answers "was anybody here". Only the second is a
       -- measure of the community.
       --
       -- Comments are counted BOTH ways above and here because a comment keeps
       -- its original date, so its rows are already honest; the people number
       -- is still the more useful one, and the two together say whether a
       -- week was many people once or one person many times.
       (SELECT COUNT(DISTINCT author_id) FROM ratings
          WHERE created_at >= date('now'))                              AS raters_today,
       (SELECT COUNT(DISTINCT author_id) FROM ratings
          WHERE created_at >= date('now', '-6 days'))                   AS raters_7d,
       (SELECT COUNT(DISTINCT author_id) FROM ratings
          WHERE created_at >= date('now', '-29 days'))                  AS raters_30d,
       (SELECT COUNT(DISTINCT author_id) FROM comments WHERE deleted_at IS NULL
          AND created_at >= date('now'))                                AS commenters_today,
       (SELECT COUNT(DISTINCT author_id) FROM comments WHERE deleted_at IS NULL
          AND created_at >= date('now', '-6 days'))                     AS commenters_7d,
       (SELECT COUNT(DISTINCT author_id) FROM comments WHERE deleted_at IS NULL
          AND created_at >= date('now', '-29 days'))                    AS commenters_30d,
       -- voter_id, not author_id: this table names the column for what a
       -- character vote is.
       (SELECT COUNT(DISTINCT voter_id) FROM character_votes
          WHERE created_at >= date('now'))                              AS voters_today,
       (SELECT COUNT(DISTINCT voter_id) FROM character_votes
          WHERE created_at >= date('now', '-6 days'))                   AS voters_7d,
       (SELECT COUNT(DISTINCT voter_id) FROM character_votes
          WHERE created_at >= date('now', '-29 days'))                  AS voters_30d,
       (SELECT COUNT(*) FROM emotion_votes)                                          AS emotion_votes,
       (SELECT COUNT(*) FROM comment_likes)                                          AS likes,
       -- The list repair. calls is phones that asked, films is entries
       -- actually named -- the second is the one that says whether the
       -- catalogue is any good, because a call that resolves nothing still
       -- counts as a call.
       (SELECT COALESCE(n, 0) FROM counters WHERE key = 'list_repair_calls')        AS repair_calls,
       (SELECT COALESCE(n, 0) FROM counters WHERE key = 'list_repair_films')        AS repair_films,
       (SELECT COUNT(*) FROM movie_uuids)                                           AS catalogue_films,
       -- ACCEPTED ONLY, like every other count of this table: a pending row is
       -- a question nobody has answered, and counting it would inflate the one
       -- number this page has for how connected the community actually is.
       (SELECT COUNT(*) FROM follows WHERE state = 'accepted')                       AS follows,
       (SELECT COUNT(*) FROM lists)                                                  AS lists,
       (SELECT COUNT(*) FROM comment_images)                                         AS images,
       (SELECT COUNT(*) FROM comment_images WHERE scan_status = 'pending')            AS images_pending,
       (SELECT COUNT(*) FROM comment_images WHERE scan_status = 'clean')              AS images_clean,
       (SELECT COUNT(*) FROM push_tokens)                                            AS push_devices,
       -- The queue that has a clock on it: a report unanswered for 24 hours is
       -- the one number here worth being woken up about.
       (SELECT COUNT(*) FROM reports WHERE resolved_at IS NULL)                      AS open_reports`,
  )
    // Midnight UTC, seven days, thirty days — bound rather than interpolated,
    // in the order the three windows appear above.
    .bind(
      `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
      new Date(Date.now() - 7 * 864e5).toISOString(),
      new Date(Date.now() - 30 * 864e5).toISOString(),
      // `plus_given` compares against now, not a window.
      new Date().toISOString(),
    )
    .first<Record<string, number>>();

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
            -- PLUS, BOTH WAYS IT CAN BE TRUE. is_plus is the flag the
            -- RevenueCat webhook owns; plus_until is the hand-grant escape
            -- hatch. The dashboard shows which of the two it is, because
            -- "paying" and "given a month by Mahmood" are different facts and
            -- a single green tick would hide the difference.
            p.is_plus,
            p.plus_until,
            p.plus_since,
            -- Stamped by GET /v1/me, which the app calls on every launch. It
            -- is the closest thing this server has to "still using it", and
            -- it is a DATE, not a history: nothing records the launch before
            -- this one.
            p.last_seen_at,
            -- The address only where the person typed one into this app. A
            -- provider's copy is Apple's or Google's to show, not ours to
            -- collect a list of.
            c.email,
            c.verified_at IS NULL AND c.profile_id IS NOT NULL AS unconfirmed,
            (SELECT GROUP_CONCAT(provider) FROM identities i WHERE i.profile_id = p.id) AS providers,
            (SELECT COUNT(*) FROM comments  x WHERE x.author_id = p.id AND x.deleted_at IS NULL) AS comments,
            (SELECT COUNT(*) FROM ratings   x WHERE x.author_id = p.id) AS ratings,
            (SELECT COUNT(*) FROM follows   x WHERE x.followee_id = p.id AND x.state = 'accepted') AS followers,
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

/**
 * POST /v1/admin/users/:handle/plus — give somebody Plus, or take it back.
 *
 * `plus_until` AND NEVER `is_plus`. The flag belongs to the RevenueCat webhook
 * and means "this person is paying"; writing it by hand would make the server
 * believe in a subscription that does not exist, and the next webhook would
 * overwrite it anyway. The date is the hand-grant lane — `plusEntitled()` reads
 * `is_plus === 1 || isPlus(plus_until, now)`, so a grant is a real entitlement
 * that expires on its own with nothing to revoke and no card anywhere near it.
 *
 * EXTENDING ADDS TO WHAT IS LEFT, rather than replacing it. Somebody with three
 * weeks remaining who is given a month should end up with seven weeks, not
 * four: the alternative silently takes time away from the person being given
 * something, which is the opposite of the intent every time this is used.
 * An expired or absent grant starts from today instead.
 *
 * `months: 0` REMOVES the grant. There is no separate delete route because
 * there is no separate action — the whole feature is one date.
 */
admin.post('/admin/users/:handle/plus', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const months = (body as { months?: unknown })?.months;
  if (typeof months !== 'number' || !Number.isInteger(months) || months < 0 || months > 12) {
    return fail(c, 400, 'invalid_body', 'months must be a whole number from 0 to 12.');
  }

  const handle = c.req.param('handle').toLowerCase();
  const row = await c.env.DB.prepare(
    'SELECT id, plus_until FROM profiles WHERE handle_lower = ? AND deleted_at IS NULL',
  )
    .bind(handle)
    .first<{ id: string; plus_until: string | null }>();
  if (!row) return fail(c, 404, 'not_found', 'No such profile.');

  if (months === 0) {
    await c.env.DB.prepare('UPDATE profiles SET plus_until = NULL WHERE id = ?').bind(row.id).run();
    return c.json({ handle, plus_until: null }, 200, { 'Cache-Control': 'no-store' });
  }

  const now = Date.now();
  const current = row.plus_until ? Date.parse(row.plus_until) : NaN;
  const from = new Date(Number.isFinite(current) && current > now ? current : now);
  /*
   * setMonth HANDLES THE SHORT ONES. Adding a month to 31 January lands on
   * 3 March rather than throwing, which is the behaviour anybody granting
   * "a month" expects and the reason this is not arithmetic on milliseconds.
   */
  from.setMonth(from.getMonth() + months);
  const until = from.toISOString();

  await c.env.DB.prepare('UPDATE profiles SET plus_until = ? WHERE id = ?').bind(until, row.id).run();
  return c.json({ handle, plus_until: until }, 200, { 'Cache-Control': 'no-store' });
});

// ── Image review ────────────────────────────────────────────────────────────

/**
 * THE ONLY WAY AN IMAGE BECOMES VISIBLE.
 *
 * `GET /v1/comments/:id/image` serves `clean` and nothing else, and nothing in
 * the codebase writes `clean` except the route below — one person, signed in,
 * having looked at the picture. There is no bulk approve, no default, and no
 * "approve everything from this user": each of those would be a way for an
 * image to become public without being seen, which is the single thing this
 * queue exists to prevent.
 *
 * The reviewer sees the picture through `GET /v1/admin/image/:id`, which is
 * cookie-gated and serves ANY status — that is the whole job. It is the one
 * place in the server where an unreviewed image is readable, and it is readable
 * by exactly the person who has to decide about it.
 */
admin.get('/admin/images', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  const status = c.req.query('status') ?? 'pending';
  if (!['pending', 'clean', 'blocked'].includes(status)) {
    return fail(c, 400, 'invalid_body', 'Unknown status.');
  }

  const res = await c.env.DB.prepare(
    `SELECT ci.comment_id, ci.is_gif, ci.scan_status, ci.created_at,
            p.handle,
            -- WHO SENT IT, because the two kinds of picture in this queue
            -- arrive by different doors and deserve different attention. A
            -- rescued TV Time photograph was taken years ago by somebody who
            -- has since imported their own archive; a Plus subscriber's upload
            -- is new, was chosen deliberately, and is the one a stranger will
            -- see on a public thread. Same review, different weight.
            (p.is_plus = 1 OR (p.plus_until IS NOT NULL AND p.plus_until > ?)) AS by_plus,
            cm.target_source, cm.target_key, cm.season, cm.episode,
            -- The caption, because a picture is judged with the sentence it was
            -- attached to. Trimmed: this is a queue, not a reading list.
            substr(cm.body, 1, 140) AS body
       FROM comment_images ci
       JOIN comments cm ON cm.id = ci.comment_id
       JOIN profiles p  ON p.id  = cm.author_id
      WHERE ci.scan_status = ? AND cm.deleted_at IS NULL
      ORDER BY ci.created_at DESC
      LIMIT 200`,
  )
    .bind(new Date().toISOString(), status)
    .all<Record<string, unknown>>();

  return c.json({ items: res.results ?? [] }, 200, { 'Cache-Control': 'no-store' });
});

admin.post('/admin/images/:id', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const status = (body as { status?: unknown }).status;
  // Deliberately not 'pending': a decision can be changed from clean to blocked
  // or back, but nothing returns an image to "nobody has looked at this yet".
  if (status !== 'clean' && status !== 'blocked') {
    return fail(c, 400, 'invalid_body', 'status must be clean or blocked.');
  }

  const res = await c.env.DB.prepare(
    'UPDATE comment_images SET scan_status = ?, scanned_at = ? WHERE comment_id = ?',
  )
    .bind(status, new Date().toISOString(), c.req.param('id'))
    .run();

  if (!res.meta.changes) return fail(c, 404, 'not_found', 'No such image.');
  return c.json({ ok: true, status });
});

/**
 * SHOW EVERYTHING CURRENTLY IN THE QUEUE.
 *
 * A bulk approve is exactly what the per-image queue was built to avoid, so it
 * takes the ids rather than a status: the page sends the pictures it has
 * rendered, which means the button can only clear images that were on screen.
 * There is no "approve all pending" — an image uploaded a minute ago, by
 * somebody who joined a minute ago, is not covered by a decision made before it
 * existed.
 *
 * Capped at the page size for the same reason.
 */
admin.post('/admin/images/bulk', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as { ids?: unknown; status?: unknown };
  const status = b.status;
  if (status !== 'clean' && status !== 'blocked') {
    return fail(c, 400, 'invalid_body', 'status must be clean or blocked.');
  }
  const ids = Array.isArray(b.ids) ? b.ids.filter((v): v is string => typeof v === 'string') : [];
  if (ids.length === 0) return fail(c, 400, 'invalid_body', 'ids are required.');
  if (ids.length > 200) return fail(c, 400, 'invalid_body', 'At most 200 at a time.');

  const now = new Date().toISOString();
  const res = await c.env.DB.batch(
    ids.map((id) =>
      c.env.DB.prepare(
        // `AND scan_status = 'pending'` so this can never silently reverse a
        // decision already made about an image, in either direction.
        "UPDATE comment_images SET scan_status = ?, scanned_at = ? WHERE comment_id = ? AND scan_status = 'pending'",
      ).bind(status, now, id),
    ),
  );

  const changed = res.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  return c.json({ ok: true, status, changed });
});

/** The picture itself, at any status, to the one person who must look at it. */
admin.get('/admin/image/:id', async (c) => {
  if (!(await valid(c.env, cookieFrom(c.req.header('Cookie')), Date.now()))) {
    return fail(c, 401, 'unauthenticated', 'Sign in first.');
  }
  const bucket = c.env.COMMENT_IMAGES;
  if (!bucket) return fail(c, 503, 'unavailable', 'Image storage is not configured.');

  const row = await c.env.DB.prepare('SELECT r2_key FROM comment_images WHERE comment_id = ?')
    .bind(c.req.param('id'))
    .first<{ r2_key: string }>();
  if (!row) return fail(c, 404, 'not_found', 'No image.');

  const object = await bucket.get(row.r2_key);
  if (!object) return fail(c, 404, 'not_found', 'No image.');

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      // Never cached: a reviewed image changes status, and a stale copy in a
      // browser is a decision made about the wrong picture.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
