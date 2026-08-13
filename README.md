# OpenTV — backend

The social layer for [OpenTV](https://github.com/mahmoodbashar08/opentv): a
privacy-first TV & movie tracker that runs entirely on-device.

**This server is a convenience layer, not a dependency.** The phone's SQLite
database is the source of truth for a user's own library. If this server
disappeared, every user would keep their complete watch history and the app
would keep working — they would lose other people's comments and ratings, and
nothing else. There is no watch-history table here, by design.

Users who decline the community never contact this server at all.

## Stack

- **Cloudflare Workers** + **Hono** — scales to zero, free until ~67,000 installs
- **D1** (SQLite) — the same engine the app uses on-device
- **R2** — avatars now, comment images later (behind CSAM scanning)

## Start

```bash
npm install
wrangler d1 create opentv          # put the id in wrangler.jsonc
npm run db:local                   # apply migrations locally
npm run dev
```

## OpenTV Plus

`POST /v1/rc/webhook` is the only thing that may grant Plus — a client that
could set it would make Plus free within a week. RevenueCat authenticates with
a shared string in the `Authorization` header:

```bash
wrangler secret put RC_WEBHOOK_SECRET   # same value in RevenueCat → Integrations → Webhooks
```

Unset means the route answers 503: no secret, no webhook. Grants on
INITIAL_PURCHASE / RENEWAL / UNCANCELLATION / PRODUCT_CHANGE /
NON_RENEWING_PURCHASE naming the `plus` entitlement; revokes on EXPIRATION
alone, because CANCELLATION only means auto-renew is off and the period is
still paid for. Free profiles publish at most 10 lists and 20 favourites per
kind, enforced in `routes/published.ts` and grandfathered so a set published
before Plus existed is never shrunk.

## Read before changing anything

- [`docs/PLAN.md`](docs/PLAN.md) — decisions, reasoning, build order, blockers
- [`docs/schema.dbml`](docs/schema.dbml) — the database (open the DBML preview)
- [`docs/data-layer.md`](docs/data-layer.md) — the same design, in prose
