/**
 * The shared TV Time film map: uuid → title.
 *
 * WHAT IT IS FOR. A TV Time list names a film by uuid and nothing else, and a
 * phone can only resolve a uuid that also appears in its own tracking rows. So
 * a list of films somebody never watched imports empty — 14 of 22 in one real
 * export. The uuid is the same in everybody's file, so a film one member
 * tracked can name that entry for every member who did not.
 *
 * TWO ROUTES, DELIBERATELY ASYMMETRIC:
 *
 *   RESOLVE is public and anonymous. It answers a question about TV Time's
 *   catalogue, and requiring a session to ask it would mean a device had to
 *   join the community to repair a list it already owns.
 *
 *   CONTRIBUTE requires one. Not because the mapping is sensitive — it is not —
 *   but because the SET of uuids a device offers is a list of films it tracked.
 *   A member has already published their films to their profile, so this server
 *   learns nothing new; somebody who declined never reaches here at all. The
 *   app enforces the same rule before calling, and this is the half that cannot
 *   be bypassed by editing an app.
 *
 * NOTHING RECORDS WHO SUPPLIED A ROW. There is no profile column and there will
 * not be one: the moment this table could say who knew a title, it would be a
 * watch history, which is the one thing this server refuses to keep.
 */
import { Hono } from 'hono';

import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';

export const movieNames = new Hono<App>();

/** As many as one import will ever have to ask about in a single call. */
const MAX_UUIDS = 200;
/** A TV Time uuid, and nothing that merely looks like one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Long enough for any film ever released, short enough to refuse an essay. */
const MAX_TITLE = 200;

/**
 * POST /v1/movie-names/resolve — names for uuids, public.
 *
 * A POST rather than a GET because a list can carry two hundred uuids and they
 * do not belong in a URL — and because the answer is not cacheable per-URL in
 * any useful way when every caller asks about a different set.
 */
movieNames.post('/movie-names/resolve', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const raw = (body as { uuids?: unknown })?.uuids;
  if (!Array.isArray(raw)) return fail(c, 400, 'invalid_body', 'uuids must be an array.');

  const uuids = [...new Set(raw.filter((u): u is string => typeof u === 'string' && UUID.test(u)))].slice(
    0,
    MAX_UUIDS,
  );
  // An empty ask is not an error — a list with nothing unresolved should cost
  // the caller a round trip and no thought.
  if (!uuids.length) return c.json({ names: {} });

  const rows = await c.env.DB.prepare(
    `SELECT uuid, title FROM movie_uuids WHERE uuid IN (${uuids.map(() => '?').join(',')})`,
  )
    .bind(...uuids)
    .all<{ uuid: string; title: string }>();

  const names: Record<string, string> = {};
  for (const r of rows.results ?? []) names[r.uuid] = r.title;
  return c.json({ names });
});

/**
 * POST /v1/movie-names — contribute pairs. Members only.
 *
 * Fire and forget by design: the caller is repairing somebody else's future
 * import, not its own, so a failure here must never surface to the person who
 * happened to be holding the phone.
 */
movieNames.post('/movie-names', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const raw = (body as { pairs?: unknown })?.pairs;
  if (!Array.isArray(raw)) return fail(c, 400, 'invalid_body', 'pairs must be an array.');

  const pairs = raw
    .filter((p): p is { uuid: string; title: string } => {
      const o = p as { uuid?: unknown; title?: unknown };
      return (
        typeof o?.uuid === 'string' &&
        UUID.test(o.uuid) &&
        typeof o?.title === 'string' &&
        o.title.trim().length > 0 &&
        o.title.length <= MAX_TITLE
      );
    })
    .slice(0, MAX_UUIDS);
  if (!pairs.length) return c.json({ stored: 0 });

  const now = new Date().toISOString();
  /*
   * INSERT OR IGNORE — first writer wins, which is the whole conflict policy.
   * A film's title does not change, so a second answer is either identical or
   * wrong, and ignoring it means one mangled export cannot rename a film for
   * everybody who imports after it.
   */
  const stmt = c.env.DB.prepare('INSERT OR IGNORE INTO movie_uuids (uuid, title, created_at) VALUES (?, ?, ?)');
  await c.env.DB.batch(pairs.map((p) => stmt.bind(p.uuid, p.title.trim(), now)));
  return c.json({ stored: pairs.length });
});
