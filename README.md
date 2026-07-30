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

## Read before changing anything

- [`docs/PLAN.md`](docs/PLAN.md) — decisions, reasoning, build order, blockers
- [`docs/schema.dbml`](docs/schema.dbml) — the database (open the DBML preview)
- [`docs/data-layer.md`](docs/data-layer.md) — the same design, in prose
