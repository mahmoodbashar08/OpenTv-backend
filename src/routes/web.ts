/**
 * A profile, as a web page.
 *
 * WHY THIS EXISTS. Every OpenTV profile is already public data served over
 * HTTP, and until now the only thing that could read it was the app. So a
 * member sharing "look at my year" had nothing to send — a link to a store
 * page, or a screenshot. This turns `theopentv.com/@amanda` into something a
 * person can open, and something Discord and iMessage can unfurl into a card.
 *
 * READ ONLY, AND SERVER RENDERED. No client JavaScript, no login, no writes.
 * That is not a first version to be replaced later; it is what a profile page
 * should be. Nothing here can change anything, which is the property that makes
 * it safe to leave running.
 *
 * IT REUSES `readProfile` AND `shapeProfile` RATHER THAN QUERYING. Those two
 * carry every visibility rule this server has — soft deletion, blocks in either
 * direction, private accounts, the Plus gate on themes and widgets, and the
 * per-section hiding a member chose in Settings. A second implementation here
 * would be a second place for those rules to be wrong, and the way it would go
 * wrong is by showing a private profile to a stranger. So the page is a
 * rendering of the same answer the app gets, and nothing more.
 *
 * ANONYMOUS, ALWAYS. It passes an empty viewer, so this page sees exactly what
 * a signed-out stranger may see. A private profile therefore renders its name
 * and nothing else — which is the point of it being private, and is also why
 * there is no "log in to see more": that belongs in the app, where the follow
 * request can actually be made.
 */
import { Hono } from 'hono';

import type { Env } from '@/env';
import { readProfile, shapeProfile } from '@/routes/profiles';

export const web = new Hono<{ Bindings: Env }>();

/** Everything that reaches the page goes through this. No exceptions. */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The palette is the app's, deliberately — someone arriving from a shared link
 * should recognise the app when they later install it. Dark only, like the app.
 */
const CSS = `
:root{--bg:#000;--card:#1C1C1E;--panel:#141416;--text:#fff;--dim:#A7A7AE;--faint:#6B6B72;--yellow:#FFD400}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:640px;margin:0 auto;padding:0 20px 64px}
.cover{height:180px;background:var(--panel) center/cover no-repeat}
.head{display:flex;gap:16px;align-items:flex-end;margin-top:-44px}
.avatar{width:88px;height:88px;border-radius:44px;border:3px solid var(--bg);background:var(--card);object-fit:cover;flex:none}
.name{font-size:24px;font-weight:800;margin:0}
.handle{color:var(--dim);margin:2px 0 0}
.plus{display:inline-block;margin-inline-start:8px;padding:2px 8px;border-radius:999px;background:var(--yellow);color:#000;font-size:12px;font-weight:800;vertical-align:middle}
.bio{color:var(--dim);margin:18px 0 0;white-space:pre-wrap}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0 0;padding:0;list-style:none}
.stat{background:var(--card);border-radius:14px;padding:12px 16px;flex:1 1 120px}
.stat b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
.stat span{color:var(--faint);font-size:13px}
.links{display:flex;flex-wrap:wrap;gap:10px;margin:20px 0 0;padding:0;list-style:none}
.links a{display:inline-block;background:var(--card);color:var(--text);text-decoration:none;padding:8px 14px;border-radius:999px;font-size:14px}
.links a:hover{background:#2a2a2d}
.private{background:var(--card);border-radius:14px;padding:20px;margin-top:24px;color:var(--dim)}
.get{display:block;margin:36px 0 0;padding:14px;border-radius:999px;background:var(--yellow);color:#000;font-weight:800;text-align:center;text-decoration:none}
.foot{color:var(--faint);font-size:13px;margin-top:28px;text-align:center}
.foot a{color:var(--faint)}
`;

function page(title: string, description: string, image: string | null, body: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#000000">
<meta property="og:type" content="profile">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<style>${CSS}</style></head><body>${body}</body></html>`;
}

/** A number a person reads, not a number a database returns. */
function nf(n: unknown): string {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v.toLocaleString('en-US') : '0';
}

/*
 * `/@amanda`, and the pattern is regex-constrained rather than the obvious
 * `/@:handle` — Hono does not match a parameter that begins mid-segment, so
 * that form silently fell through to the 404 handler and answered JSON to a
 * browser. The constraint doubles as validation: anything that is not a handle
 * never reaches the database.
 */
web.get('/:handle{@[A-Za-z0-9_.-]{1,40}}', async (c) => {
  // ANONYMOUS. Never the caller's session, even if they send one: this page is
  // a public artefact and must render identically for everybody, or a link
  // would show its author more than it shows the person they sent it to.
  const row = await readProfile(c.env, (c.req.param('handle') ?? '').replace(/^@/, ''), '');

  if (!row || row.blocked === 1) {
    return c.html(
      page('Not found — OpenTV', 'No such profile.', null, `<div class="wrap"><p class="bio" style="margin-top:64px">No such profile.</p><a class="get" href="https://theopentv.com">Get OpenTV</a></div>`),
      404,
    );
  }

  const p = shapeProfile(row, '', new Date().toISOString()) as Record<string, any>;
  const name: string = p.display_name || p.handle;
  const avatar = p.avatar_key ? `/v1/avatars/${encodeURIComponent(p.avatar_key)}` : null;

  /*
   * A PRIVATE PROFILE GETS A NAME AND A FULL STOP. `shapeProfile` has already
   * emptied the counts and the rest for an anonymous viewer; this only decides
   * what to say instead, and says the true thing rather than dangling a
   * "follow to see more" that no web page can deliver.
   */
  if (p.is_private) {
    return c.html(
      page(
        `${name} on OpenTV`,
        'This profile is private.',
        null,
        `<div class="cover"></div><div class="wrap">
          <div class="head">${avatar ? `<img class="avatar" src="${esc(avatar)}" alt="">` : '<div class="avatar"></div>'}
            <div><h1 class="name">${esc(name)}</h1><p class="handle">@${esc(p.handle)}</p></div></div>
          <div class="private">This profile is private.</div>
          <a class="get" href="https://theopentv.com">Get OpenTV</a>
        </div>`,
      ),
    );
  }

  const c_ = p.counts ?? {};
  const stats = [
    ['Shows', c_.shows],
    ['Films', c_.movies],
    ['Comments', c_.comments],
    ['Followers', c_.followers],
  ]
    .filter(([, v]) => v != null)
    .map(([label, v]) => `<li class="stat"><b>${nf(v)}</b><span>${esc(label)}</span></li>`)
    .join('');

  // Only `https:` reaches here — `parseLinks` has already applied the same rule
  // the app applies twice more before anybody taps one.
  const links = Array.isArray(p.links)
    ? p.links
        .filter((l: any) => typeof l?.url === 'string' && l.url.startsWith('https://'))
        .map((l: any) => `<a href="${esc(l.url)}" rel="noopener nofollow ugc" target="_blank">${esc(l.service)}</a>`)
        .join('')
    : '';

  const description = p.bio || `${name} tracks TV and films on OpenTV.`;

  return c.html(
    page(
      `${name} on OpenTV`,
      description,
      p.cover_url || avatar,
      `${p.cover_url ? `<div class="cover" style="background-image:url('${esc(p.cover_url)}')"></div>` : '<div class="cover"></div>'}
       <div class="wrap">
         <div class="head">${avatar ? `<img class="avatar" src="${esc(avatar)}" alt="">` : '<div class="avatar"></div>'}
           <div><h1 class="name">${esc(name)}${p.is_plus ? '<span class="plus">PLUS</span>' : ''}</h1>
             <p class="handle">@${esc(p.handle)}</p></div></div>
         ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
         ${stats ? `<ul class="stats">${stats}</ul>` : ''}
         ${links ? `<ul class="links">${links}</ul>` : ''}
         <a class="get" href="https://theopentv.com">Get OpenTV</a>
         <p class="foot">Your watch history stays on your phone.<br><a href="https://theopentv.com/privacy">Privacy</a></p>
       </div>`,
    ),
  );
});
