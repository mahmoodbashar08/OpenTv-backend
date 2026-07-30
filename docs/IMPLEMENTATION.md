# OpenTV backend — the implementation plan

**Status:** written 31 July 2026, nothing past Step 0 built.
**Prerequisite reading:** [`PLAN.md`](./PLAN.md) — every decision below builds on
the decisions recorded there and none of them are reopened here.

`PLAN.md` says *what* and *why*. This file says *what to type*. It is written so
each step can be picked up cold, finished in one focused evening or three, and
left green.

Step numbering here starts at 0 (scaffold) and runs to 6; `PLAN.md` §5 numbers
the same work 1–6. They are the same steps, shifted by one.

---

## Overview

| Step | What ships | Sessions |
|---|---|---|
| **0** | Scaffold finished: compat date, Vitest, typecheck green, `/health` verified, CI | 0.5 |
| **1** | Auth — Apple/Google ID tokens, sessions, `/me`, handle claim, account deletion | 3 |
| **2** | Ratings — `POST /ratings`, batch `GET /aggregates`, write-time rollup | 1.5 |
| **3** | Comments — CRUD, likes, reports, blocks, opt-in seeding | 3 |
| **4** | Social — follow, public profiles, published lists, notifications, reconnection | 2 |
| **5** | Maintenance — cron Worker: counter reconciliation, soft-delete purge | 1 |
| **6** | Deployment — deploy, domain, secrets, remote migration, launch checklist | 1 |
| | **Total** | **12** |

A session is one focused evening. Steps 2 and 3 depend on Step 1; nothing else
has a hard ordering, but the order above is the order of risk (numbers before
words, per `PLAN.md` §5).

---

## Conventions that apply to every step

### Versioning — `/v1` from day one

Every route is mounted under `/v1`. `GET /health` is the only exception; it is
infrastructure, not API. Adding a prefix later means a client-side flag day, and
this app ships to phones that update slowly and to phones that never update. One
character of forethought buys a migration path.

```ts
const v1 = new Hono<{ Bindings: Env }>();
app.route('/v1', v1);
```

### Error envelope

Success responses are the bare resource — no `{ data: … }` wrapper.
Failures are always:

```json
{ "error": { "code": "handle_taken", "message": "That handle is in use." } }
```

`code` is a stable machine string the app switches on; `message` is English and
for logs and last-resort display only — the app localises from `code`, because it
ships in six languages and the server has no business guessing which.

Codes in use: `unauthenticated`, `forbidden`, `not_found`, `invalid_body`,
`handle_taken`, `handle_invalid`, `rate_limited`, `target_invalid`,
`too_large`, `blocked`, `internal`.

One helper in `src/http.ts`:

```ts
export function fail(c: Context, status: ContentfulStatusCode, code: string, message: string)
```

Status codes: 400 invalid body, 401 no/bad session, 403 blocked or not yours,
404 missing, 409 conflict (handle taken), 429 rate limited, 500 unexpected.

### Auth header

`Authorization: Bearer <session-jwt>`. Nothing else. No cookies — there is no
browser client, and cookies would drag CSRF into a design that has no need of it.

### Rate limiting

The honest answer on the free plan is **Cloudflare WAF rate-limiting rules**, not
application code. KV free tier is 1,000 writes/day; a per-IP KV counter would
exhaust it before breakfast and cost latency on every request besides. So:

1. **WAF rate-limiting rule** (one is included free): 100 requests/minute per IP
   across `/v1/*`. Configured in the dashboard, recorded in Step 6.
2. **In-Worker, KV-backed** only on `POST /v1/auth/session` — low volume by
   nature (once per install per week), and the one endpoint that does expensive
   work (JWKS verification) for an unauthenticated caller. Key
   `rl:auth:<ip-hash>`, 20/hour, KV TTL 3600.
3. **Per-user write limits enforced in D1**, where the data already lives and
   the read is free-ish: before inserting a comment,
   `SELECT COUNT(*) FROM comments WHERE author_id = ? AND created_at > ?`
   over the last hour, cap 30. Same for reports, cap 20/day. This is the limit
   that actually matters — abuse is per-account, not per-IP.

### Testing philosophy

Same split as `mobile/src/pure.ts`, for the same reason: decisions that can be
wrong get tested; I/O that can only be plumbed gets smoke-tested.

- **`src/pure.ts`** — no imports, no bindings, no `Date.now()` (time is a
  parameter). `targetKey`, `slug`, `aggregateDelta`, `normaliseHandle`,
  `isHandleValid`, `parseCursor`/`makeCursor`, `stableImportId` (async, hashing
  only), `verifyClaims` (takes a decoded payload and a clock, returns
  ok/reason — the crypto stays outside).
- **`test/pure.test.ts`** — plain Vitest, node environment, no Workers pool
  needed. This is where the effort goes.
- **Handlers** stay thin: parse → call pure function → one D1 statement or
  batch → serialise. If a handler grows a branch worth arguing about, that
  branch belongs in `pure.ts`.
- **`scripts/smoke.sh`** — curls a running `wrangler dev` and asserts status
  codes. Runs by hand, not in CI (CI has no D1).

---

## The shared identity rule

Phone and server must compute the same key for the same film or they will build
two threads for it. The rule below is normative and must be implemented
**character-for-character identically** in `backend/src/pure.ts` and
`mobile/src/pure.ts`, with the same test vectors on both sides.

```ts
/** slug: lowercase · NFKD-fold diacritics · non-alphanumerics → single hyphen · trim hyphens */
export function slug(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')       // drop combining marks: é → e, مُ → م
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')  // Unicode-aware: Arabic and CJK survive
    .replace(/^-+|-+$/g, '');
}

/** The address of a thread. Shows are an id; films without one are slug|year. */
export function targetKey(
  source: 'tvdb' | 'tmdb' | 'title',
  a: { id?: number | string | null; title?: string | null; year?: string | null },
): string {
  if (source === 'tvdb' || source === 'tmdb') return String(a.id);
  const base = movieBaseName(a.title ?? '');        // strips a trailing "(YYYY)"
  const year = movieYearOf(a.title ?? '', a.year);  // column first, then suffix
  return `${slug(base)}|${year ?? ''}`;
}
```

`movieBaseName` and `movieYearOf` already exist in `mobile/src/pure.ts` and are
copied verbatim into the backend. The year rule is deliberately the same one
`movieIdentityMatches` uses: the stored column if it is four digits, otherwise a
`(YYYY)` suffix on the title, otherwise nothing. `movieYear()`'s `.slice(0, 4)`
behaviour is preserved so `"2021-10-22"` yields `2021`.

**Critically:** the character class is `[^\p{L}\p{N}]`, not `[^a-z0-9]`. An
ASCII-only class would reduce every Arabic title to the empty string and collapse
the entire Arabic catalogue into one thread. This is the single most important
line in the file.

### Test vectors — identical on both sides

| Input | `targetKey` |
|---|---|
| `('title', {title:'Amado', year:'2011'})` | `amado\|2011` |
| `('title', {title:'Amado', year:'2022'})` | `amado\|2022` |
| `('title', {title:'Amélie', year:'2001'})` | `amelie\|2001` |
| `('title', {title:'Amélie'})` | `amelie\|` |
| `('title', {title:'مسلسل ما'})` | `مسلسل-ما\|` |
| `('title', {title:'مُسَلْسَل ما', year:'2019'})` | `مسلسل-ما\|2019` |
| `('title', {title:'Spider-Man: No Way Home', year:'2021'})` | `spider-man-no-way-home\|2021` |
| `('title', {title:'WALL·E', year:'2008'})` | `wall-e\|2008` |
| `('title', {title:'  Dune  ', year:'2021-10-22'})` | `dune\|2021` |
| `('title', {title:'Dune (1984)'})` | `dune\|1984` |
| `('tvdb', {id:121361})` | `121361` |

The two Amado rows are the whole point: they are the films that collided in
1.2.1 because the app compared names alone. They must produce different keys,
and the diacritic and Arabic rows must produce non-empty ones.

**Work owed on the app side** (also listed in `PLAN.md` §7): export `targetKey`
from `mobile/src/pure.ts` next to `movieIdentityMatches`, with this table as its
test. Do it in the same session as backend Step 2, so the two never drift.

---

## Step 0 — finish the scaffold

**Goal:** `npm run typecheck && npm test` green, `/health` answering locally,
nothing half-committed.

**Effort:** 0.5 sessions.

### Files

- `wrangler.jsonc` — **modify.** `compatibility_date` is committed as
  `"2026-07-31"`; installed workerd is `1.20260730.1`, whose ceiling is
  2026-07-30, so `wrangler dev` prints a future-date error on every start. Set
  it to `"2026-07-30"`. (The working tree already has this fix uncommitted —
  commit it.) Also add `"compatibility_flags": ["nodejs_compat"]`: Step 1 needs
  `node:buffer` for base64url handling of JWT segments.
- `vitest.config.ts` — **create.** Plain node environment. No
  `@cloudflare/vitest-pool-workers`: nothing under test touches a binding, and
  the pool costs install weight and start-up seconds for no coverage.
  ```ts
  import { defineConfig } from 'vitest/config';
  export default defineConfig({
    test: { include: ['test/**/*.test.ts'], environment: 'node' },
    resolve: { alias: { '@': new URL('./src/', import.meta.url).pathname } },
  });
  ```
- `src/pure.ts` — **create.** Starts with `slug`, `movieBaseName`,
  `movieYearOf`, `targetKey`.
- `test/pure.test.ts` — **create.** The vector table above.
- `src/http.ts` — **create.** `fail()` and the error-code union.
- `.github/workflows/ci.yml` — **create** (optional but cheap): node 22,
  `npm ci`, `npm run typecheck`, `npm test`. No deploy step — deployment stays
  manual until there is something worth automating.
- `package-lock.json` — **commit it.** It is currently untracked.

### Done when

```bash
npm run typecheck && npm test          # both exit 0, no wrangler warnings
npx wrangler dev &                     # starts with NO compatibility-date error
curl -s localhost:8787/health          # {"ok":true,"db":true}
```

---

## Step 1 — auth

**Goal:** an app can sign in with Apple or Google, get a session, pick a handle,
read its own profile, and delete its account from inside the app.

**Effort:** 3 sessions. The largest step, and the one everything else waits on.

### 1a · JWKS fetch and cache

Both providers publish RSA public keys as JWKS and rotate them without notice.

- Apple: `https://appleid.apple.com/auth/keys`
- Google: `https://www.googleapis.com/oauth2/v3/certs`

`src/jwks.ts`:

```ts
getKey(env, provider: 'apple' | 'google', kid: string): Promise<CryptoKey>
```

1. Read `jwks:<provider>` from `CACHE` KV (`type: 'json'`).
2. If the cached set contains `kid`, import it with
   `crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])` and return.
3. If it does not, **fetch fresh once** and re-check. A missing `kid` is the
   signature of a rotation, and refusing to refetch would lock every user out
   until the TTL expired. Guard against a hostile client forcing fetches: record
   `jwks:<provider>:refetch` in KV with a 60-second TTL and skip the refetch if
   it is set; if the kid is still unknown after a refetch, fail
   `401 unauthenticated`.
4. Write the fetched set back with `expirationTtl: 86400`. A day is well inside
   both providers' rotation cadence, and step 3 covers early rotation anyway.

The KV read is ~1 per request on the auth endpoint only, which is why sessions
are not KV-backed (see 1c).

### 1b · Token verification

`src/auth.ts` — `verifyIdToken(env, provider, token): Promise<{ sub, email? }>`.

Split deliberately: the crypto is in `auth.ts`, the claim rules are
`verifyClaims(payload, expected, nowMs)` in `pure.ts` and unit-tested.

Claims validated, all of them, no exceptions:

| Claim | Apple | Google |
|---|---|---|
| `iss` | `https://appleid.apple.com` | `https://accounts.google.com` (also accept `accounts.google.com` — Google emits both) |
| `aud` | `com.insightfy.opentv` (the iOS bundle id; from `var APPLE_BUNDLE_ID`) | must be a member of `GOOGLE_CLIENT_IDS` (comma-separated var: iOS client, Android client, Web client — Android sign-in returns the *web* client id as `aud`, which is the classic trap) |
| `exp` | `> now` | `> now` |
| `iat` | `< now + 300` (clock skew allowance) | same |
| `sub` | present, non-empty → `identities.external_id` | same |
| `nonce` | not used — the app is not a browser and there is no redirect to replay | — |
| `email_verified` | ignored | ignored — email is stored for support only, never trusted for identity |

Signature: `crypto.subtle.verify` over `header.payload` using the key from 1a,
with `alg` restricted to `RS256`. Reject `alg: none` and any HS variant before
looking at anything else.

### 1c · Session issuance — decision

**Use a short-lived HS256 JWT signed with a Worker secret. No sessions table.**

An opaque token in D1 costs one indexed read on *every* authenticated request —
that is a network hop to the D1 primary in front of every rating, thread page
and notification poll, on a platform whose whole appeal here is that it scales to
zero and answers from the edge. A signed JWT verifies inside the isolate with no
I/O at all. The usual counter-argument is revocation, and it does not bite here:
the two things needing immediate revocation are account deletion and a ban, and
both are already enforced where they matter — every write joins `profiles` with
`deleted_at IS NULL`, so a deleted or banned account cannot write even holding a
valid token, and reads of other people's public data are not worth a per-request
round trip to protect. Token lifetime is therefore **7 days**, short enough that
a stale token expires within a week; the app silently re-authenticates against
Apple/Google (both support silent credential refresh) and calls
`POST /v1/auth/session` again. If a per-user kill switch is ever genuinely
needed, it is a `token_epoch` integer on `profiles` checked on writes — additive,
no migration of behaviour.

Token: `{ sub: profileId, iat, exp }`, HS256, secret `SESSION_SECRET`.
`src/session.ts`: `sign(env, profileId, nowMs)` / `verify(env, token, nowMs)`.

### 1d · Endpoints

**`POST /v1/auth/session`** — unauthenticated.

```jsonc
// request
{ "provider": "apple", "id_token": "eyJ…", "tvtime_user_id": 50248888 }  // tvtime_user_id optional
// 200
{ "token": "eyJ…", "expires_at": "2026-08-07T…Z",
  "profile": { "id": "p_…", "handle": null, "display_name": null, "avatar_key": null,
               "is_private": 0, "plus_until": null, "created_at": "…" },
  "needs_handle": true }
```

Find-or-create, as one `db.batch()`:

```sql
SELECT profile_id FROM identities WHERE provider = ? AND external_id = ?;
-- if found and the profile is not soft-deleted: issue a token, done.
-- if not found:
INSERT INTO profiles (id, handle, handle_lower, created_at) VALUES (?, ?, ?, ?);
INSERT INTO identities (provider, external_id, profile_id, email, created_at) VALUES (?,?,?,?,?);
```

`profiles.handle` is `NOT NULL UNIQUE`, so a new profile gets a **placeholder**:
`user_<first 10 of id>`, with `needs_handle: true` telling the app to run the
handle flow. Never invent a pretty handle server-side — see `PLAN.md` §3.

If the found profile has `deleted_at` set, treat it as absent and create a fresh
one (Step 1f deletes the identity row, so this branch is defensive only).

Profile ids: `p_` + `crypto.randomUUID()` with hyphens stripped. Not the provider
`sub` — that is the whole reason `identities` is a separate table.

**`GET /v1/me`** — authenticated. Returns the full own-profile row plus
`{ unread_notifications: n }`. One statement:

```sql
SELECT p.*, (SELECT COUNT(*) FROM notifications WHERE recipient_id = p.id AND read_at IS NULL) AS unread
FROM profiles p WHERE p.id = ? AND p.deleted_at IS NULL;
```

404 → `unauthenticated`, because a token for a vanished profile is not a valid
session.

**`PATCH /v1/me`** — authenticated. Accepts `display_name`, `bio`, `is_private`,
`links`. **Never** `plus_until`, `handle`, `tvtime_user_id` — reject the whole
body with `invalid_body` if any appear, rather than silently ignoring them.
`plus_until` is written only by the RevenueCat webhook (`PLAN.md` §3).

**`POST /v1/me/handle`** — authenticated. The suggest/confirm flow.

```jsonc
{ "handle": "mahmood", "check_only": true }
// 200 available
{ "available": true }
// 409 taken
{ "error": { "code": "handle_taken", "message": "…" } }
```

With `check_only: false` it claims:

```sql
UPDATE profiles SET handle = ?, handle_lower = ?
WHERE id = ? AND NOT EXISTS (SELECT 1 FROM profiles WHERE handle_lower = ? AND id <> ?);
```

Zero rows changed → 409. The `UNIQUE` index on `handle_lower` is the real
guarantee; catch its constraint error and map it to 409 too, because the
check-then-write above is racy by construction.

Validation in `pure.ts`, `isHandleValid`: 3–20 characters, `[a-z0-9_]` after
`normaliseHandle` (NFKC, lowercase, trim), not starting with `user_` (reserved
for placeholders), not in a small reserved list (`admin`, `opentv`, `support`,
`help`, `api`, `moderator`). Rejecting non-ASCII handles is deliberate — a handle
is an address people type and read aloud, and homograph attacks on a
follow-someone-by-name flow are not a theoretical risk.

The app pre-fills this field with the imported TV Time name. The server never
sees that as a claim: it arrives as an ordinary candidate handle and is refused
if taken, exactly like any other (`PLAN.md` §3).

**`DELETE /v1/me`** — authenticated. Apple 5.1.1(v) and GDPR erasure.

**Deletes immediately:** `identities` (so signing in again creates a *new*
profile, which is what "deleted" must mean to the user), `comments` by them,
`comment_likes` by them, `ratings` by them, `follows` in both directions,
`blocks` in both directions, `lists` + `list_items`, `notifications` where they
are recipient, and the R2 avatar object at `avatar_key`.

**Scrubs, does not delete:** the `profiles` row. It is set
`deleted_at = now`, `handle = 'deleted_' || substr(id,3,8)`,
`handle_lower` likewise, and `display_name`, `bio`, `avatar_key`, `links`,
`tvtime_user_id`, `tvtime_handle` all `NULL`. No personal data survives.

**Must not touch:** `reports` they filed, and any `moderation_actions` naming
them. This is the reason for the shell rather than a hard delete —
`reports.reporter_id` cascades, so hard-deleting an account would silently erase
its open reports and quietly defeat the 24-hour moderation clock;
`moderation_actions.moderator_id` has no `ON DELETE` clause at all and would
reject the delete outright for anyone who has ever moderated. The shell is purged
by the Step 5 job after 30 days, at which point those cascades are acceptable
because the queue is long since resolved.

It must also not touch the phone. The app deletes nothing local on account
deletion, and says so on the confirmation screen.

Response: `204`. Ratings deletion does **not** correct `rating_aggregates` in
this handler — see Step 2's note on drift; the Step 5 job reconciles.

### 1e · Middleware

`src/middleware.ts` — `requireAuth`: reads the bearer token, verifies with
`session.verify`, sets `c.set('profileId', sub)`, else 401 `unauthenticated`.
Zero I/O, by design (1c). Mounted as `v1.use('/me/*', requireAuth)` and on every
write route; `GET /v1/aggregates` and `GET /v1/profiles/:handle` stay open.

### Unit tests (Vitest)

`verifyClaims` — right issuer, wrong issuer, `aud` not in the allowed set, `aud`
matching the *second* Google client id, expired, `iat` five minutes in the
future, `alg: none`, missing `sub`. `isHandleValid` / `normaliseHandle` — too
short, too long, uppercase folding, spaces, `user_` prefix, reserved word, a
Unicode lookalike. `sign`/`verify` round-trip with a fixed clock, plus a
tampered payload and an expired token.

### Done when

```bash
npx wrangler dev
# with a real ID token captured from the app:
curl -s -X POST localhost:8787/v1/auth/session -d '{"provider":"apple","id_token":"…"}' | jq .needs_handle   # true
TOKEN=…
curl -s localhost:8787/v1/me -H "Authorization: Bearer $TOKEN" | jq .handle                                   # user_xxxxxxxxxx
curl -s -X POST localhost:8787/v1/me/handle -H "Authorization: Bearer $TOKEN" -d '{"handle":"mahmood"}'        # 200
curl -s -X POST localhost:8787/v1/me/handle -H "Authorization: Bearer $TOKEN2" -d '{"handle":"Mahmood"}'       # 409 handle_taken
curl -s -X DELETE localhost:8787/v1/me -H "Authorization: Bearer $TOKEN" -o /dev/null -w '%{http_code}\n'      # 204
npx wrangler d1 execute opentv --local --command "SELECT handle, deleted_at FROM profiles" # deleted_xxxxxxxx, timestamp
```

---

## Step 2 — ratings

**Goal:** a user votes; everyone else reads a percentage. No text, no moderation
surface, highest value per unit of risk (`PLAN.md` §5).

**Effort:** 1.5 sessions.

### Files

`src/routes/ratings.ts`, `src/pure.ts` (+`aggregateDelta`),
`test/aggregate.test.ts`.

### `POST /v1/ratings` — authenticated

```jsonc
// request
{ "target_source": "tvdb", "target_key": "121361", "season": 1, "episode": 3,
  "score": 9, "emotion": "love" }        // either may be null, not both
// 200
{ "ok": true, "aggregate": { "vote_count": 412, "score_avg": 8.7,
                             "emotion_counts": { "love": 210, "shock": 44 } } }
```

`season`/`episode` are `NULL` for a show- or film-level vote and are normalised
to `-1` when touching `rating_aggregates`, whose primary key cannot hold NULLs
(see the migration's comment).

### The delta logic

An upsert is not enough on its own: the aggregate must move by the *difference*
between the old vote and the new one, and there are four cases. `aggregateDelta`
in `pure.ts` takes `(prev: Vote | null, next: Vote)` and returns
`{ dVotes, dScore, emotionFrom, emotionTo }`:

| Case | `dVotes` | `dScore` | emotion |
|---|---|---|---|
| New vote, with a score | +1 | `+next.score` | `null → next.emotion` |
| New vote, emotion only | +1 | 0 | `null → next.emotion` |
| Changed score 7 → 9 | 0 | `+2` | unchanged |
| Score added to an emotion-only vote | 0 | `+next.score` | unchanged |
| Score removed (score → null) | 0 | `-prev.score` | unchanged |
| Emotion changed only | 0 | 0 | `prev.emotion → next.emotion` |

`vote_count` counts *people*, not scores — so an emotion-only vote still counts,
and `score_avg` is therefore computed by the *client* as
`score_sum / scored_count`… which the schema does not carry. Resolve it the
simple way: `vote_count` counts people, and the response exposes
`score_avg = score_sum / vote_count` only when every counted vote has a score is
not knowable — so **expose `score_sum` and `vote_count` raw** and let the app
render `score_sum / vote_count` as "average of votes cast", accepting that
emotion-only votes drag it down. If that proves wrong in practice, add a
`scored_count` column in migration 0003; it is one more `+1` in the same
statement. Recorded here so the next session does not rediscover it.

### The statements — one `db.batch()`

D1's `batch()` runs all statements in a single implicit transaction, so the vote
and its rollup move together or not at all. There is no `BEGIN`/`COMMIT` to
write by hand; do not try.

```ts
const prev = await db.prepare(
  `SELECT id, score, emotion FROM ratings
   WHERE author_id = ? AND target_source = ? AND target_key = ?
     AND COALESCE(season,-1) = ? AND COALESCE(episode,-1) = ?`
).bind(me, src, key, s, e).first<Vote>();

const d = aggregateDelta(prev, next);

await db.batch([
  db.prepare(
    `INSERT INTO ratings (id, author_id, target_source, target_key, season, episode, score, emotion, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT (author_id, target_source, target_key, COALESCE(season,-1), COALESCE(episode,-1))
     DO UPDATE SET score = excluded.score, emotion = excluded.emotion`
  ).bind(…),

  db.prepare(
    `INSERT INTO rating_aggregates
       (target_source, target_key, season, episode, vote_count, score_sum, emotion_counts, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT (target_source, target_key, season, episode) DO UPDATE SET
       vote_count = rating_aggregates.vote_count + excluded.vote_count,
       score_sum  = rating_aggregates.score_sum  + excluded.score_sum,
       updated_at = excluded.updated_at`
  ).bind(src, key, s ?? -1, e ?? -1, d.dVotes, d.dScore, initialEmotionJson, now),
]);
```

Note the `ON CONFLICT` target on `ratings` names the expression index exactly as
`idx_one_vote_per_person` declares it, `COALESCE` included. SQLite matches
partial/expression indexes by expression, not by name; get this wrong and the
upsert silently becomes a duplicate-key error.

**Emotion counts** are a JSON blob, and a read-modify-write of a blob is racy
across users. Do it in SQL so it is not:

```sql
emotion_counts = json_set(
  json_set(COALESCE(emotion_counts, '{}'),
           '$.' || :from, MAX(0, COALESCE(json_extract(emotion_counts, '$.' || :from), 0) - 1)),
  '$.' || :to,   COALESCE(json_extract(emotion_counts, '$.' || :to), 0) + 1)
```

applied only when `emotionFrom !== emotionTo`, with the decrement half skipped
when `emotionFrom` is null. Emotion names are validated against a fixed
allow-list in `pure.ts` before they reach a JSON path — an unvalidated emotion is
a JSON-path injection.

**Drift is expected and accounted for.** Two concurrent votes by the same user,
or a `DELETE /v1/me` that removes ratings without adjusting rollups, will nudge a
counter off. That is precisely why `counter_repair` exists (Step 5). Do not add
locking; the correction is nightly and the numbers are percentages.

### `GET /v1/aggregates` — open, edge-cached

Two forms. The **season form** is primary because it is one short, highly
cacheable URL for the screen that asks most often:

```
GET /v1/aggregates?source=tvdb&key=121361&season=1
→ { "items": [ { "season":1, "episode":1, "vote_count":412, "score_sum":3596,
                 "emotion_counts": {"love":210} }, … ] }
```

```sql
SELECT season, episode, vote_count, score_sum, emotion_counts
FROM rating_aggregates
WHERE target_source = ? AND target_key = ? AND season = ?
ORDER BY episode;
```

The **list form** covers a mixed screen (a watchlist of films):
`?t=title:amado|2011&t=tvdb:121361` — repeated `t` params, `source:key[:season:episode]`,
**capped at 100**; over the cap → `400 target_invalid`. Built as a single
`WHERE (target_source, target_key, season, episode) IN (VALUES …)`.

Headers on both: `Cache-Control: public, max-age=300, stale-while-revalidate=3600`.
Also put it in the Worker's own cache (`caches.default`) keyed on the request
URL, so a popular episode costs zero D1 reads. Five minutes stale on a vote count
is invisible; the D1 read budget it protects is not.

### Unit tests

`aggregateDelta` across all six rows of the table above, plus: emotion-only →
score-only (emotion cleared), identical re-vote (all deltas zero), and score 0 /
11 rejected before reaching SQL. `parseTargets` for the list form: valid, 101
targets, malformed `t`, a `title:` key containing a literal `|`.

### Done when

```bash
curl -s -X POST localhost:8787/v1/ratings -H "Authorization: Bearer $TOKEN" \
  -d '{"target_source":"tvdb","target_key":"121361","season":1,"episode":3,"score":9,"emotion":"love"}'
# re-vote with score 7 and emotion "shock"
npx wrangler d1 execute opentv --local --command \
  "SELECT vote_count, score_sum, emotion_counts FROM rating_aggregates"
# → 1 | 7 | {"love":0,"shock":1}     vote_count stayed 1, sum moved, emotion moved
curl -s "localhost:8787/v1/aggregates?source=tvdb&key=121361&season=1" -D- | grep -i cache-control
```

---

## Step 3 — comments

**Goal:** threads, likes, and the moderation tools that ship *with* them, not
after. Apple 1.2 does not treat report/block as a follow-up release.

**Effort:** 3 sessions.

### Migration 0002

One column: `ALTER TABLE comments ADD COLUMN hidden_at TEXT;`

Auto-hide must be reversible by a moderator (`moderation_actions.action`
includes `restore`), and reusing `deleted_at` would make an author's own deletion
indistinguishable from an automatic hide. Every thread read filters
`deleted_at IS NULL AND hidden_at IS NULL`.

### `POST /v1/comments` — authenticated

```jsonc
{ "target_source": "tvdb", "target_key": "121361", "season": 1, "episode": 3,
  "body": "…", "is_spoiler": true, "lang": "ar", "parent_id": null }
// 201 → the created comment, as the thread renders it
```

Rules: body 1–2,000 characters after trim (`too_large` beyond); `parent_id` must
resolve to a comment with `parent_id IS NULL` — **one level only**
(`PLAN.md` §3), so a reply to a reply is `400 invalid_body`, not a silent
re-parent; a reply inherits its parent's target rather than trusting the client's.
`lang` is stamped from the request body if it is a valid BCP-47 tag, otherwise
from `Accept-Language`, otherwise NULL. Never guessed from the text — language
detection in a Worker's 10 ms CPU budget is not happening, and a wrong stamp is
worse than none.

Writes, in one batch: the comment, plus a `reply` notification to the parent's
author when `parent_id` is set and the parent's author is not the replier.

### `GET /v1/comments` — open, but block-aware when authenticated

```
GET /v1/comments?source=tvdb&key=121361&season=1&episode=3&cursor=…&limit=25
→ { "items": [ { "id","author":{"id","handle","display_name","avatar_key"},
                 "body","is_spoiler","lang","like_count","liked_by_me",
                 "reply_count","created_at","edited_at" } … ],
    "next_cursor": "MjAyNi0wNy0zMVQ…" | null }
```

Top-level only; replies come from `?parent_id=…`, so a 200-reply argument never
lands in one payload.

Cursor is `base64url(created_at + '|' + id)`, giving a total order that survives
identical timestamps — an imported seeding batch writes hundreds of rows in the
same second, so `created_at` alone would skip or repeat rows. Page size 25,
maximum 50.

```sql
SELECT c.*, p.handle, p.display_name, p.avatar_key,
       EXISTS(SELECT 1 FROM comment_likes WHERE comment_id = c.id AND user_id = ?me) AS liked_by_me
FROM comments c JOIN profiles p ON p.id = c.author_id
WHERE c.target_source = ? AND c.target_key = ?
  AND COALESCE(c.season,-1) = ? AND COALESCE(c.episode,-1) = ?
  AND c.parent_id IS NULL
  AND c.deleted_at IS NULL AND c.hidden_at IS NULL
  AND p.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM blocks b
                  WHERE (b.blocker_id = ?me AND b.blocked_id = c.author_id)
                     OR (b.blocker_id = c.author_id AND b.blocked_id = ?me))
  AND (c.created_at, c.id) < (?, ?)          -- cursor; omitted on the first page
ORDER BY c.created_at DESC, c.id DESC
LIMIT ?;
```

Blocks filter **both directions**: I do not see them, and they do not see me.
Apple 1.2 asks for the first; the second is what stops block from being a one-way
mute that the blocked party can work around by refreshing.

For an unauthenticated read, `?me` is `''` and both sub-queries are trivially
false — no branching SQL, one statement.

### `DELETE /v1/comments/:id` — authenticated

Author only. Soft: `UPDATE comments SET deleted_at = ? WHERE id = ? AND author_id = ?`.
Zero rows → 403 `forbidden` (not 404 — do not leak whether the id exists).
Replies survive with a tombstone parent, which is the lesser evil against
cascading a conversation out of existence.

### Likes

`POST /v1/comments/:id/like` and `DELETE`. Each is a two-statement batch:

```sql
INSERT OR IGNORE INTO comment_likes (comment_id, user_id, created_at) VALUES (?,?,?);
UPDATE comments SET like_count = like_count + 1 WHERE id = ? AND ?changed = 1;
```

Take `changed` from the first statement's `meta.changes` and skip the second when
it is 0, so a double-tap does not inflate the counter. The unlike path mirrors it
with `MAX(like_count - 1, 0)`. A `like` notification is written on the insert
path only, and only when liker ≠ author. Counter drift is again the Step 5 job's
problem, and `comment_likes` is the stated source of truth (`schema.dbml`).

### Reports and auto-hide

`POST /v1/reports`:

```jsonc
{ "target_type": "comment", "target_id": "c_…", "reason": "spam" }   // 202
```

`reason` from a fixed list: `spam`, `harassment`, `hate`, `sexual`, `violence`,
`spoiler`, `other`. One report per reporter per target — enforce with a
`SELECT … LIMIT 1` guard (the table has no unique index; do not add one, a
person may legitimately re-report after a `dismissed` outcome).

Batch: insert the report; `UPDATE comments SET report_count = report_count + 1`;
then, in the same batch, the auto-hide:

```sql
UPDATE comments SET hidden_at = ?
WHERE id = ? AND hidden_at IS NULL AND report_count + 1 >= 5;
```

Five distinct reporters hides a comment pending human review. The threshold is a
constant in `pure.ts` (`AUTO_HIDE_REPORTS = 5`) so it can be tuned without
hunting through SQL. This is the mechanism that makes the 24-hour response
requirement survivable for a solo moderator: the bad comment is invisible within
minutes; `reports.first_seen_at` still starts the clock when a human opens the
queue.

`POST /v1/reports` also accepts `target_type: "profile" | "list"`, which record
only — no auto-hide for accounts.

### Blocks

`POST /v1/blocks/:profileId` / `DELETE /v1/blocks/:profileId`. Insert or delete
the pair row. Blocking also removes any follow edges in both directions, in the
same batch — a block that leaves a follow in place is not a block.

### Opt-in seeding — `POST /v1/comments/import`

Fired by the app after the join prompt, which itself fires after a successful
import (`PLAN.md` §7): *"you imported 47 comments — bring them with you?"*

```jsonc
{ "items": [ { "target_source":"title","target_key":"amado|2011","season":null,
               "episode":null,"body":"…","created_at":"2019-04-02T…Z","lang":"en" } … ] }
// 200
{ "imported": 44, "skipped": 3 }
```

Batches of 200 maximum; the app chunks. Every row gets `imported_at = now`, which
lets the UI mark them as brought-from-TV-Time rather than freshly written.

**Dedupe by construction, not by query.** The id is derived, not random:

```
id = 'imp_' + hex(SHA-256(author_id ‖ ' ' ‖ target_source ‖ ' ' ‖ target_key ‖ ' '
                          ‖ season ‖ ' ' ‖ episode ‖ ' ' ‖ created_at ‖ ' ' ‖ body)).slice(0, 32)
```

then `INSERT OR IGNORE`. Re-importing the same export is a no-op no matter how
many times it runs, with no read-before-write and no unique index to add. This
mirrors the app's own merge-safe import rule, and the mobile importer already
dedupes on `entity + text + date` for exactly this reason. `skipped` is
`items.length - meta.changes`.

Imported comments never generate notifications.

### Unit tests

`stableImportId` — deterministic across calls, differs on a one-character body
change, differs between two users with the same text. `parseCursor`/`makeCursor`
round-trip, plus a malformed cursor rejected rather than thrown on. `validateBody`
— empty, whitespace-only, 2,001 characters, an emoji-only body (allowed).
`replyDepthOk`. `AUTO_HIDE_REPORTS` threshold arithmetic at 4 and 5.

### Done when

```bash
# post, reply, like, double-like, report x5
npx wrangler d1 execute opentv --local --command "SELECT like_count FROM comments"        # 1, not 2
npx wrangler d1 execute opentv --local --command "SELECT hidden_at FROM comments WHERE report_count >= 5"  # set
curl -s "localhost:8787/v1/comments?source=tvdb&key=121361&season=1&episode=3"            # hidden one absent
bash scripts/smoke.sh                                                                      # all green
# import the same payload twice:
curl … /v1/comments/import   # {"imported":44,"skipped":0}
curl … /v1/comments/import   # {"imported":0,"skipped":44}
```

---

## Step 4 — follow, profiles, reconnection

**Goal:** the community becomes navigable, and two people who were TV Time
friends in 2019 find each other without typing anything.

**Effort:** 2 sessions.

### Follow

`POST /v1/follows/:profileId`, `DELETE /v1/follows/:profileId`.
`INSERT OR IGNORE INTO follows` (the `CHECK (follower_id <> followee_id)` in the
migration handles self-follow; catch and return 400). A `follow` notification on
the insert path when a row was actually created. Refuse if either side has
blocked the other → 403 `blocked`.

`GET /v1/me/following` and `GET /v1/profiles/:handle/followers`, cursor-paged on
`created_at|follower_id`, page 50.

### `GET /v1/profiles/:handle` — open

```jsonc
{ "id","handle","display_name","avatar_key","bio","is_private","links",
  "is_plus": true,                       // plus_until > now — never the date itself
  "counts": { "followers": 12, "following": 30, "comments": 88, "lists": 2 },
  "followed_by_me": false, "created_at": "…" }
```

Lookup is on `handle_lower`, always — the URL a user types is not case-correct.

`is_private` rules: a private profile still returns handle, display name, avatar
and `is_private: true` — the shell must exist or you cannot request to follow
someone. It returns **no counts, no bio, no links** unless the viewer follows
them. Soft-deleted profiles are `404 not_found`, not a tombstone.

`plus_until` is never exposed as a date; the client gets a boolean. A date is an
entitlement detail and belongs to RevenueCat.

### `GET /v1/profiles/:handle/lists` — open

`WHERE owner_id = ? AND is_public = 1`, plus the `is_private` rule above. Items
come from a second call, `GET /v1/lists/:id`, which returns `list_items` ordered
by `position` with the denormalised `title` — rendering a list must not require a
metadata lookup, which is why `title` is stored there.

### Notification write paths

Written by the handler that causes them, in the same batch, never by a job:

| Handler | kind | recipient | subject |
|---|---|---|---|
| `POST /v1/comments` with `parent_id` | `reply` | parent's author | `comment` / new comment id |
| `POST /v1/comments/:id/like` (insert path) | `like` | comment's author | `comment` / comment id |
| `POST /v1/follows/:id` (insert path) | `follow` | followee | `profile` / follower id |
| `POST /v1/me/friends/reconcile` | `friend_found` | both sides | `profile` / the other id |
| moderation tooling (later) | `moderation` | actioned user | `comment` / comment id |

Never notify yourself: every path checks `actor_id <> recipient_id` first.

`GET /v1/notifications?cursor=` — the inbox, newest first, joined to
`profiles` for the actor's handle and avatar, filtered by the same
block-both-directions rule as threads.
`POST /v1/notifications/read` with `{ "up_to": "2026-07-31T…Z" }` →
`UPDATE notifications SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL AND created_at <= ?`.
Marking by watermark rather than by id list means the badge clears in one request
regardless of how many rows are behind it.

### Reconnection — `POST /v1/me/friends/reconcile`

`friend.csv` lists friendships as numeric id pairs and carries no usernames, so
the match is on `tvtime_user_id` and can only be (`PLAN.md` §3).

```jsonc
{ "tvtime_user_id": 50248888, "friend_ids": [12137674, 9912, …] }   // ≤ 500 per call
// 200
{ "matched": [ { "handle":"sara","display_name":"Sara","avatar_key":"…" } ] }
```

1. Set the caller's own id **write-once**:
   `UPDATE profiles SET tvtime_user_id = ? WHERE id = ? AND tvtime_user_id IS NULL`.
   Write-once because a mutable field here would let someone re-point at id after
   id, harvesting `friend_found` notifications across the whole user base. The
   residual risk — that the first claimant of an id might not own it — is
   accepted and recorded: the id grants nothing but a mutual "you were friends"
   hint, and the export it comes from is the user's own GDPR download.
2. Find matches:
   `SELECT id, handle, display_name, avatar_key FROM profiles
    WHERE tvtime_user_id IN (…) AND deleted_at IS NULL`.
3. For each match, write a `friend_found` notification **to both sides**,
   guarded by an existence check so repeated calls do not re-notify:
   `WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE recipient_id=? AND actor_id=? AND kind='friend_found')`.

Chunk `friend_ids` at 500 per request; the app loops. The `idx_profiles_tvtime`
partial index makes the `IN` cheap.

The app calls this once after the join prompt, and again on each
`POST /auth/session` **only if** the local friend list changed — a friend who
joins next year is found the next time the app asks, not by a background job.

### Unit tests

`visibleProfileFields(profile, viewerFollows, isSelf)` — the `is_private` matrix,
including self-view (everything) and the follower's view. `notificationTargets`
— never self, both-sides for friend_found, none for imported comments.
`chunk(ids, 500)`.

### Done when

```bash
# two profiles, tvtime ids 50248888 and 12137674, each reconciling with the other in their list
npx wrangler d1 execute opentv --local --command \
  "SELECT recipient_id, kind FROM notifications WHERE kind='friend_found'"   # exactly 2 rows
# calling reconcile again:                                                    # still exactly 2 rows
curl -s localhost:8787/v1/profiles/sara | jq .counts     # null when private and not followed
```

---

## Step 5 — maintenance

**Goal:** the counters that requests are allowed to drift are pulled straight
overnight, and soft-deleted accounts stop existing.

**Effort:** 1 session.

### wrangler.jsonc

```jsonc
"triggers": { "crons": ["0 4 * * *"] }
```

04:00 UTC — the trough for a user base concentrated in Europe and the Middle
East. `export default { fetch: app.fetch, scheduled }` in `src/index.ts`;
`src/jobs.ts` holds the work.

### 5a · Counter reconciliation

`comments.like_count` from `comment_likes`:

```sql
UPDATE comments SET like_count = (
  SELECT COUNT(*) FROM comment_likes WHERE comment_id = comments.id)
WHERE like_count <> (SELECT COUNT(*) FROM comment_likes WHERE comment_id = comments.id);
```

`rating_aggregates` from `ratings`:

```sql
UPDATE rating_aggregates AS a SET
  vote_count = (SELECT COUNT(*) FROM ratings r WHERE r.target_source = a.target_source
                  AND r.target_key = a.target_key
                  AND COALESCE(r.season,-1) = a.season AND COALESCE(r.episode,-1) = a.episode),
  score_sum  = (SELECT COALESCE(SUM(r.score),0) FROM ratings r WHERE … same …),
  updated_at = ?;
```

`emotion_counts` is rebuilt in the same pass with
`json_group_object(emotion, n)` over a `GROUP BY emotion` sub-select, skipping
NULL emotions.

Both write a `counter_repair` row afterwards:

```sql
INSERT INTO counter_repair (table_name, last_run_at, rows_checked, rows_corrected)
VALUES (?,?,?,?) ON CONFLICT (table_name) DO UPDATE SET
  last_run_at = excluded.last_run_at, rows_checked = excluded.rows_checked,
  rows_corrected = excluded.rows_corrected;
```

`rows_corrected` comes from `meta.changes`. **Watch it.** A number that is
consistently zero means the write paths are correct; a number that grows means a
handler is losing updates and the job is papering over it. That is the whole
value of recording it.

Batch at 5,000 rows per statement with a `LIMIT`-driven loop while the corpus is
small; revisit when a single pass approaches the 30-second cron CPU limit.

### 5b · Soft-delete purge

```sql
DELETE FROM profiles WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-30 days');
```

Cascades take `identities`, `follows`, `blocks`, `comments`, `comment_likes`,
`ratings`, `lists`, `list_items`, `notifications` and `reports` they filed. At
30 days the moderation queue is long since resolved, which is what makes the
report cascade acceptable here and not at deletion time (Step 1f).

**One trap:** `moderation_actions.moderator_id` has no `ON DELETE` clause, so
purging a profile that ever moderated will fail the whole `DELETE` on a foreign
key. Handle it by excluding those ids (`AND id NOT IN (SELECT moderator_id FROM
moderation_actions)`) and logging them for manual handling — a moderator's
account deletion is rare enough to be a person's problem, and losing the audit
trail is not an option.

R2 avatars are already deleted at `DELETE /v1/me`; the job additionally sweeps
orphaned keys once `avatar_key` is in use — a `list()` over the prefix diffed
against `SELECT avatar_key FROM profiles`, capped and paged. Not needed until
avatars ship.

### 5c · `title` → `tvdb` thread migration — documented stub

When a film that had no id gains a TheTVDB one, its threads sit on a `title` key
while new clients address it by `tvdb`, splitting the conversation.

The migration itself is three `UPDATE`s (`comments`, `ratings`,
`rating_aggregates` — the last needing a merge, not a rename, when both keys
already have rows). What is missing is the **mapping source**: nothing on the
server knows that `amado|2011` is now TheTVDB 428391. The candidates are (a) the
app reporting `{ old_key, new_source, new_key }` when a local movie row gains an
id, which is cheap and self-healing but trusts the client; (b) a periodic
TheTVDB search from the job, which needs the licence that `PLAN.md` §6 lists as
the one item that could invalidate the plan.

**Decision deferred until that licence is settled.** Ship Step 5 with a
`migrateTitleThreads()` that is written, unit-tested against a fixture mapping,
and called with an empty mapping. The mechanism is proven; only the feed is
missing.

### Unit tests

`reconcileSql` fixtures against a real `better-sqlite3` in-memory database (the
statements are plain SQLite; testing them without D1 is legitimate and fast):
seed a deliberately wrong `like_count`, run, assert corrected and that
`rows_corrected` is 1. `mergeAggregates(a, b)` for the 5c merge case.

### Done when

```bash
npx wrangler d1 execute opentv --local --command "UPDATE comments SET like_count = 99"
npx wrangler dev --test-scheduled
curl -s "localhost:8787/__scheduled?cron=0+4+*+*+*"
npx wrangler d1 execute opentv --local --command "SELECT like_count FROM comments"        # back to the true count
npx wrangler d1 execute opentv --local --command "SELECT * FROM counter_repair"           # rows_corrected = 1
```

---

## Step 6 — deployment

**Goal:** a dark API in production, reachable only by a build that knows its
address. Deploying is not launching.

**Effort:** 1 session.

### Secrets and vars

Secrets — `wrangler secret put <NAME>`, never in `wrangler.jsonc`:

| Secret | Purpose |
|---|---|
| `SESSION_SECRET` | HS256 signing key for session tokens. 32 random bytes, base64. Rotating it logs everyone out — acceptable, and the app re-authenticates silently. |
| `REVENUECAT_WEBHOOK_SECRET` | Shared secret on the `Authorization` header of the RevenueCat webhook, the only writer of `plus_until`. |

Vars — plain `"vars"` in `wrangler.jsonc`, because they are public identifiers
that appear in every client binary anyway:

| Var | Value |
|---|---|
| `APPLE_BUNDLE_ID` | `com.insightfy.opentv` |
| `GOOGLE_CLIENT_IDS` | comma-separated: iOS, Android, **and Web** client ids |
| `AVATAR_BASE_URL` | the R2 public domain, used to build avatar URLs at read time |

Add the R2 binding when avatars ship — it is absent from `wrangler.jsonc` today:
`"r2_buckets": [{ "binding": "AVATARS", "bucket_name": "opentv-avatars" }]`.

### Deploy

```bash
npx wrangler d1 migrations apply opentv --remote     # 0001, then 0002 from Step 3
npx wrangler deploy
curl -s https://opentv-api.<subdomain>.workers.dev/health
```

### Domain

**Start on `workers.dev`.** It is free, immediate, and needs no DNS. Move to
`api.opentv.app` before the first public build ships, because a `workers.dev`
hostname baked into an app binary is a hostname you can never move off without an
update cycle, and because `workers.dev` is blocked on some corporate and national
networks. Register the custom domain in the dashboard (Workers → Triggers →
Custom Domains); Cloudflare issues the certificate. Keep the `workers.dev` route
enabled as a fallback the app can be pointed at in an emergency.

Add the WAF rate-limiting rule here: `/v1/*`, 100 requests per minute per IP,
action *block*, 10-second timeout.

### Launch checklist

Deploying a dark API needs none of this. **Turning it on for users needs all of
it** (`PLAN.md` §6):

- [ ] **TheTVDB commercial licence** — the one item that could invalidate the
      plan. It gates public launch, not deployment.
- [ ] TMDB commercial terms.
- [ ] Privacy policy rewritten — it currently states there is no server, and it
      is English-only while the app ships in six languages.
- [ ] Age rating re-review — UGC typically pushes above the current 13+.
- [ ] Published EULA — required for UGC, and Apple 1.2 asks for it by name.
- [ ] In-app report and block, both reachable in two taps (Step 3 ships the API;
      the app must ship the buttons).
- [ ] Account deletion reachable from inside the app — Apple 5.1.1(v).
- [ ] A moderation route that a solo owner can actually answer within 24 hours:
      the auto-hide threshold plus an email alert on the first open report.
- [ ] Upgrade to the $5 Workers paid plan on launch day. The free plan fails
      closed at 100k requests/day, and a good day should not read as an outage.

---

## What is deliberately not in this plan

Images and CSAM scanning (must be live before the first upload ever happens),
the moderation dashboard, public web profiles, and push transport. All are listed
as *Later* in `PLAN.md` §5 and none of them block a first release. The rows for
images exist in the schema and nothing writes to them; `scan_status` defaults to
`pending` and the API serves only `clean`, so the failure direction is already
correct on the day the first upload arrives.
