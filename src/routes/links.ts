import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { isSafeLinkUrl } from '@/pure';

export const EVENT_KEY = 'event:active';
export const EVENTS = ['halloween', 'muertos', 'christmas', 'newyear', 'valentine', 'ramadan', 'awards'] as const;

/** A `profile_templates` row (0053). */
export type TemplateRow = {
  id: string;
  name: string;
  layout: string;
  colours: string;
  blocks: string;
  persona: string;
  banner_key: string;
  event: string | null;
  hidden: number;
  created_at: string;
};

export const TEMPLATE_COLUMNS = 'id, name, layout, colours, blocks, persona, banner_key, event, hidden, created_at';

/**
 * A template as the phone (and the dashboard) receives it: the two colours
 * unpacked, the blocks as a list, and the banner as an address on THIS origin
 * — `GET /v1/templates/:name` below — so the phone downloads it once and never
 * needs to know where it is kept.
 */
export function templateOut(row: TemplateRow, origin: string) {
  const [primary, secondary] = JSON.parse(row.colours) as [string, string];
  return {
    id: row.id,
    name: row.name,
    banner: `${origin}/v1/${row.banner_key}`,
    primary,
    secondary,
    layout: row.layout,
    persona: row.persona,
    blocks: JSON.parse(row.blocks) as unknown,
    event: row.event,
    hidden: row.hidden === 1,
    created_at: row.created_at,
  };
}

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

/** Five minutes at the edge (was an hour): the seasonal event rides this
 *  response, and switching it on the dashboard should reach phones while the
 *  owner is still watching. Still one edge hit per five minutes, not per launch. */
const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=600';

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
  /*
   * THE SEASONAL EVENT (8 Oct): one of `EVENTS` or null — switched on
   * the dashboard, never by date, so a decoration reaches phones only when the
   * owner says so. Rides this response because it is the one read every
   * member's phone already makes; cached five minutes, so a switch takes up to
   * five minutes to arrive.
   */
  const event = (await c.env.CACHE.get(EVENT_KEY)) || null;

  /*
   * THE SERVER'S PROFILE TEMPLATES (2.0.0, 0053), on this same read, so a
   * Ramadan template ships on the day with no new request and no app update.
   * The visible ones; an event-tied one only while its event is the one
   * switched on, so it arrives and leaves with the decorations — up to five
   * minutes late, like the event itself. Newest first: the one just made
   * leads its section on the phone.
   *
   * ONLY TO A PHONE WITH AN ACCOUNT, the same way the event is: not by auth
   * here (this read is the same for everybody and cached hard, see above) but
   * because the app only ever asks when it is signed in — a phone without an
   * account keeps the twelve built in and reaches nothing.
   */
  const origin = new URL(c.req.url).origin;
  const templates = (
    await c.env.DB.prepare(
      `SELECT ${TEMPLATE_COLUMNS} FROM profile_templates
        WHERE hidden = 0 AND (event IS NULL OR event = ?)
        ORDER BY created_at DESC`,
    )
      .bind(event ?? '')
      .all<TemplateRow>()
  ).results.map((r) => templateOut(r, origin));

  return c.json({ links: safe, event, templates });
});

// ── GET /v1/templates/:name — a template's banner ───────────────────────────

/**
 * Public and unauthenticated like an avatar: the address ends up inside an
 * `<Image>` on the templates screen and an image request carries no session.
 * The owner's own artwork, uploaded from the dashboard — never a user's
 * picture, so none of the scanning caveat that hangs over every other image
 * route. Immutable because a template's banner never changes: there is no
 * edit, only make, hide and delete, and a new template is a new key.
 */
links.get('/templates/:name', async (c) => {
  const bucket = c.env.COMMENT_IMAGES;
  if (!bucket) return fail(c, 503, 'unavailable', 'Image storage is not configured.');

  // The key is rebuilt from a name that can only be a file name, never a path.
  const name = c.req.param('name');
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return fail(c, 404, 'not_found', 'No such image.');

  const obj = await bucket.get(`templates/${name}`);
  if (!obj) return fail(c, 404, 'not_found', 'No such image.');

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
