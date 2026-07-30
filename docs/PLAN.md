# OpenTV backend — plan and decision record

**Status:** design agreed, scaffold in progress. No production deployment yet.
**Last updated:** 31 July 2026

This file exists so a fresh session — human or AI — can pick the work up without
re-deriving the reasoning. Read it before changing anything in `backend/`.

Related:
- [`schema.dbml`](./schema.dbml) — the database, source of truth for table shape
- [`data-layer.md`](./data-layer.md) — readable write-up of the same design
- [`../../PLAN.md`](../../PLAN.md) — the product roadmap (phases 0–8)
- [`../../INSTRUCTIONS.md`](../../INSTRUCTIONS.md) — rules for the mobile app

---

## 1. What this is

The social layer for OpenTV (Phase 6) and the server half of OpenTV Plus
(Phase 7).

OpenTV is a TV Time replacement whose entire identity is *no server, no account,
your data stays on your phone*. This backend must not break that promise. It is
a **convenience layer**, not a dependency.

---

## 2. The architectural rule everything obeys

> The phone's SQLite database is the source of truth for a user's own library.
> The server stores only what is inherently **shared** between people.

Consequences, all deliberate:

- There is **no watch-history table**, and there never will be.
- If the server disappeared, every user keeps their complete history and the app
  keeps working. They lose other people's comments and ratings. Nothing else.
- There is **no conflict resolution**, because the two sides never store the same
  thing and therefore can never disagree.
- Users who decline the community **never contact the server at all**. No
  anonymous telemetry, no aggregate collection, no exceptions. (Owner decision,
  overriding an earlier suggestion to collect anonymous ratings from everyone.)

---

## 3. Decisions already made — do not re-litigate without a reason

| Decision | Why |
|---|---|
| **Cloudflare Workers + Hono**, not NestJS | NestJS needs a long-lived Node process; Workers is a V8 isolate runtime. NestJS on Cloudflare Containers is possible but the product is in beta, has 2–3s cold starts and no autoscaling. Hono is Express-like and scales to zero. |
| **D1** (SQLite), not Postgres | Free at this scale, same SQLite the app already uses. The server is deliberately non-essential, so a future migration would move comments and ratings — not irreplaceable user history. |
| **Sign in with Apple / Google only** | No email+password: one fewer credential to leak, one fewer support burden. |
| **`identities` separate from `profiles`** | TV Time's own `auth-prod-login.csv` carried provider/external_id/email as rows — one account had apple, facebook and tvtime rows at once. Without this, Apple-on-iPhone + Google-on-tablet creates two unmergeable profiles. |
| **Reconnection keys on `tvtime_user_id`** | `friend.csv` lists friendships as numeric id pairs (`50248888 -> 12137674`). It does **not** contain usernames, so a handle-based match would find nothing. |
| **TV Time email is NOT stored** | Reconnection matches on the numeric id, so the address adds nothing and would be personal data to secure, disclose and delete. |
| **Aggregates computed on WRITE** | Workers allows 10 ms CPU per request on the free plan. Scanning thousands of votes per read would not fit; bumping one row per vote costs nothing. This is the single hardest thing to retrofit. |
| **`target_source` + `target_key` pair** | `movies.name` is the PRIMARY KEY in the app and `tvdbId`/`tmdbId` are nullable — the same weakness that made two "Amado" films collide in 1.2.1. Shows use `tvdb`; films without an id use `title` → `slug(title)\|year`. Recording the *source* means a film that later gains an id can be migrated, not orphaned. |
| **Replies are one level deep** | Deeper threading is a moderation problem wearing a feature costume. |
| **Avatars are free; profile *skins* are Plus** | 10,000 avatars fit in R2's free tier. A community of grey silhouettes is not a community. Skins are on-device, zero running cost. |
| **Images are Plus, and land last** | The only real running cost and the only criminal-liability surface. |
| **`scan_status` defaults to `pending`; API serves only `clean`** | An unscanned image is invisible by default. If the scanner is down, images queue rather than leak. Correct direction to fail. |
| **`plus_until` written only by the RevenueCat webhook** | If the client could set it, Plus would be free within a week. |
| **No lifetime tier** | Owner decision. A one-time payment against a forever cost is a debt. Monthly $1.99 / yearly $12.99, 7-day trial. |
| **Handles are a suggestion, not a claim** | The imported name is pre-filled, confirmed by the user, refused if taken. A claim would let someone import an export that is not theirs and take the name on it. *Decided by default — flag if the owner disagrees.* |
| **Published-only lists** | Confirmed by TV Time's own `lists-prod-lists.csv`, which carried `is_public`. |

---

## 4. Costs (verified against Cloudflare's published pricing, 31 Jul 2026)

Assumes ~5 requests per user per day — the app only calls out to search people,
read ratings and open a thread. Everything else is already on the phone.

| Installs | In community | Requests/day | Plan | Cost/month |
|---|---|---|---|---|
| 10,000 | 3,000 | 15,000 | Free | **$0** |
| 67,000 | 20,000 | 100,000 | Free (at the ceiling) | **$0** |
| 100,000 | 30,000 | 150,000 | Paid | **$5** |
| 500,000 | 150,000 | 750,000 | Paid | **~$22** |

Free tier: Workers 100k req/day · D1 5M reads + 100k writes/day, 5 GB · R2 10 GB,
no egress fees.

**The free plan fails closed** — past 100k requests/day it returns errors rather
than billing. Pay the $5 on launch day as insurance against a good day.

**Infrastructure is not the constraint.** The real costs are moderation time,
the TheTVDB licence, and store commission (15%).

---

## 5. Build order

Each step ends green and is independently shippable.

### Step 1 — Scaffold *(in progress)*
- `wrangler.jsonc`, TypeScript, Hono, Vitest
- D1 binding, first migration generated from `schema.dbml`
- `GET /health`
- Pushed to `OpenTv-backend`

### Step 2 — Auth
- Verify Apple and Google ID tokens in the Worker (JWKS fetch + cache in KV)
- `POST /auth/session` → find-or-create `identities` + `profiles`
- Handle availability check and claim
- **Account deletion from inside the app** — Apple guideline 5.1.1(v), and GDPR
  erasure. Deletes all server rows, leaves the phone untouched.

### Step 3 — Ratings (build before comments)
- `POST /ratings`, `GET /aggregates?…`
- Aggregate updated in the same transaction as the vote
- Highest value per unit of risk: numbers only, no moderation surface

### Step 4 — Comments
- CRUD, likes, spoiler flag, `lang`
- Opt-in seeding from the user's own imported comments (`imported_at`)
- Report + block endpoints ship **with** comments, not after

### Step 5 — Follow, profiles, reconnection
- Follow/unfollow, public profile read, published lists
- `friend_found` notifications when two former TV Time friends both sign in

### Step 6 — Maintenance
- Scheduled Worker: counter reconciliation, soft-delete purge, `title` → `tvdb`
  thread migration

### Later
- Images + CSAM scanning (must be live before the first upload)
- Moderation dashboard (Next.js on Workers)
- Public web profiles

---

## 6. Blocking before anything ships publicly

- [ ] **TheTVDB commercial licence.** The app made TheTVDB primary in 1.2.0. The
      bundled shared key almost certainly does not cover an app selling
      subscriptions. **This is the one item that could invalidate the plan.**
- [ ] **TMDB commercial terms.**
- [ ] **Privacy policy rewrite** — it currently states there is no server, and it
      is English-only while the app ships in six languages.
- [ ] **Age rating re-review** — UGC typically pushes above the current 13+.
- [ ] **Published EULA** — required for UGC.

---

## 7. Work owed on the app side

- `targetKey(source, …)` in `mobile/src/pure.ts`, next to `movieIdentityMatches`,
  so phone and server compute `slug(title)|year` identically. Unit-test it on
  both sides.
- The join prompt fires **after a successful import**, never on first open — the
  moment the user has just watched their history reappear, when the offer can be
  concrete ("you imported 47 comments — bring them with you?").
- Leaving the community must be one action, and must not touch local data.

---

## 8. Open questions

- Free image allowance for non-Plus users, if any.
- Whether monthly recap is in-app only or also shareable.
- Push delivery — rows exist in `notifications`; transport is undecided and an
  in-app badge works without any.
