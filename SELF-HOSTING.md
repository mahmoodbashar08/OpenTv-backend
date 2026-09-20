# Running your own OpenTV server

One container. One directory. No database server, no cache server, no object
store, no reverse proxy required.

That is not a minimal example — it is the actual deployment. Cloudflare D1 *is*
SQLite, so the data is a file; the only bytes this server stores are pictures,
so they are a folder.

```bash
git clone https://github.com/mahmoodbashar08/OpenTv-backend.git
cd OpenTv-backend

echo "SESSION_SECRET=$(openssl rand -base64 48)" > .env

docker compose up -d
curl http://localhost:8787/v1/links      # {"links":[]}
```

That is a running server. Point the app at it: **Settings → Your data →
Community server**, and enter the address along with your own TMDB token and
TheTVDB key — running everything yourself means running it on your own keys,
so the app asks for all three together.

**Needs OpenTV 1.6.2 or later.** On Android now; the iOS build is in review as
of 7 September 2026, and the setting is not in 1.6.1.

---

## What you are responsible for

**`./data` is everything.** The SQLite file, every comment picture, every
avatar, and every library backup. Back that directory up and you have backed up the server; lose it and
nothing else will bring it back.

```bash
# a nightly copy, while the server is running (SQLite is in WAL mode)
0 4 * * * sqlite3 /srv/opentv/data/opentv.db ".backup '/backups/opentv-$(date +\%F).db'" \
  && tar czf /backups/opentv-images-$(date +\%F).tgz /srv/opentv/data/comment-images
```

**HTTPS.** Nothing here terminates TLS. Put it behind whatever you already run —
Caddy, nginx, Traefik, a Cloudflare tunnel. The app will refuse a plain `http://`
server URL on iOS anyway, because App Transport Security does.

---

## Configuration

Everything optional is genuinely optional: leave it blank and the feature is
absent rather than broken. That is not special-casing for self-hosting — it is
the same path the hosted Worker takes when a binding is missing.

| Variable | Required | Missing means |
|---|---|---|
| `SESSION_SECRET` | **yes** | refuses to start |
| `GOOGLE_CLIENT_IDS` | no | Google sign-in button hidden. Apple is offered on iOS only, so on **Android** this leaves email and password as the only way in — which works: `/v1/backup` sits behind `requireAuth`, never `requireVerified`, so an account whose address was never confirmed still backs up and restores. Set it if you want the button. |
| `APPLE_BUNDLE_ID` | no | defaults to `com.insightfy.opentv` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | no | moderation dashboard unreachable — pictures stay stored and unserved |
| `RC_WEBHOOK_SECRET` | no | no subscription webhook; grant Plus by hand (below) |
| `DATA_DIR` | no | `/data` |
| `PORT` | no | `8787` |

`SESSION_SECRET` signs every session token. Anybody holding it can mint a token
for any account on your instance. Generate it, never reuse one from elsewhere,
never commit it.

## Your library, on your own server

The strongest reason to run this. With the app pointed at your instance,
**Settings → Your data → Cloud backup** puts a copy of your library in
`./data/backups` — one ZIP per profile, overwritten in place, so it grows by one
file per person and no more. Lose the phone, install the app on a new one, sign
in against your own server, and it comes back.

It is the same TV Time-format ZIP the exporter builds, and this server never
opens it. Plus gates uploading and nothing else; downloading and deleting need
only a session, so a copy of your own history can never become unreachable.

## Pick one way to sign in, and stay with it

**On an instance with no mail configured, email and Google are two different
accounts even with the same address**, and the reason is a deliberate one worth
understanding before you tell your users which button to press.

A provider sign-in only JOINS an existing email account when BOTH sides have
proved the address: the provider vouches for it, and the local account
confirmed it. Without that second half the classic takeover works — register
`victim@example.com` with a password you know, wait for them to sign in with
Google, and you are inside their account. An unconfirmed registration reserves
nothing.

Your instance has no mail, so an address can never be confirmed BY ITS OWNER.
Registrations there are confirmed on creation — otherwise nobody could finish
signing up at all, since an unverified token is refused by every route but the
handful that let you enter a code that is never coming — and they are marked as
confirmed without proof. A provider sign-in refuses to land in one of those, so
the link never happens. Register by email, back a library up, then sign in with Google
on a new phone, and you land in a second empty profile with no backup in it.
The server is not wrong; it is refusing to hand one person's account to
another.

**Email and password is the simplest choice** and needs nothing configured.
Apple works out of the box on iOS. Google needs `GOOGLE_CLIENT_IDS`. Whichever
you pick, tell the people on your instance to use that one.

## What a self-hosted instance does not have

- **Comment translation.** It runs on Workers AI, which is Cloudflare's. The app
  hides the Translate row, exactly as it does on a Worker without that binding.
- **Edge caching.** Aggregate reads go to SQLite every time. On one household's
  instance that is faster than the cache would have been.
- **Subscriptions.** There is no store to buy from. Give yourself and anyone else
  the paid tier directly:

  ```bash
  docker compose exec opentv \
    sqlite3 /data/opentv.db "UPDATE profiles SET is_plus = 1 WHERE handle = 'you';"
  ```

Push notifications are unaffected — they go through Expo, not Cloudflare.

## Upgrading

```bash
git pull && docker compose up -d --build
```

Each migration runs **once**, recorded in a `_migrations` table, so starting the
container is the whole upgrade procedure. The schema comes from the same
`migrations/*.sql` the hosted server applies; there is no separate self-hosted
schema to drift.

## How this works, briefly

The server is [Hono](https://hono.dev), which runs on Node unchanged — so every
route and every middleware here is the same code the hosted Worker runs. Only
four bindings differ, and each has an adapter in `src/adapters/`:

| Cloudflare | Self-hosted |
|---|---|
| D1 | `better-sqlite3` — the same adapter 558 tests run against |
| R2 | a directory |
| KV | a table in the same SQLite file |
| Workers AI | absent |

Nothing in `src/` knows which it got. That is what stops the two from drifting.

## Licence

Source-available, not open source. You may run and modify this for **your own
personal use**. You may not host it for other people, offer it as a service, or
use it commercially. See `LICENSE`.
