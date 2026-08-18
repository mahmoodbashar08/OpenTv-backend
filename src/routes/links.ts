import { Hono } from 'hono';
import type { App } from '@/env';
import { isSafeLinkUrl } from '@/pure';

/**
 * Where to find us — Discord, Reddit, Instagram, TikTok, X — as rows this
 * server owns rather than text compiled into an app.
 *
 * A LINK IN A SHIPPED BUILD CANNOT BE FIXED, and that is the whole reason this
 * exists. A Discord invite expires after seven days unless somebody remembers
 * to set otherwise; compiled into a release, it is dead in every copy already
 * on a phone and the only cure is a store update that takes days to arrive.
 * One row here changes it everywhere, immediately.
 *
 * NO AUTH, and edge-cached hard. This is the same for every reader on earth,
 * which makes it the one thing a shared cache is genuinely right about —
 * unlike `/v1/aggregates`, where a cache shared by everyone cannot answer the
 * one person whose vote it does not yet contain.
 *
 * THE APP ONLY EVER TAKES THIS AS AN OVERRIDE. It ships its own defaults and
 * refreshes them when it is already talking to this server, because somebody
 * who declined the community must never contact it — so a decliner keeps the
 * bundled list and reaches nothing here at all.
 */

export const links = new Hono<App>();

/** An hour at the edge, a day while revalidating. The list changes rarely and
 *  a stale row for an hour is invisible; a request per launch is not. */
const CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=86400';

links.get('/links', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT key, label, url FROM links WHERE enabled = 1 ORDER BY sort ASC, key ASC',
  ).all<{ key: string; label: string; url: string }>();

  /*
   * FILTERED HERE, NOT ONLY WHEN IT WAS WRITTEN. The app hands these straight
   * to `Linking.openURL`, which will open anything it is given — a `javascript:`
   * or a custom scheme included. The table is ours and should never hold one,
   * but "should never" is not a guarantee, and this is the last place that can
   * still refuse. A bad row disappears rather than reaching a phone.
   */
  const safe = (rows.results ?? []).filter((r) => isSafeLinkUrl(r.url));

  c.header('Cache-Control', CACHE_CONTROL);
  return c.json({ links: safe });
});
