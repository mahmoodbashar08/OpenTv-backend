/**
 * The dashboard, as one string.
 *
 * NO BUILD STEP AND NO CDN. It is one page read by one person; a bundler, a
 * framework and a second deployment would all be machinery for that. Inline
 * everything so the Worker can answer with it directly and there is nothing
 * else to keep alive.
 *
 * The numbers come from `/v1/admin/stats`, same origin, with an HttpOnly
 * cookie no script here can read — including any script that got onto the page
 * by accident. This file never touches a token.
 */
export const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>OpenTV — dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0d0d0f; color:#e9e9ee;
         font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 40px 20px 80px; }
  h1 { font-size:20px; margin:0 0 4px; color:#ffd400; letter-spacing:.02em; }
  .sub { color:#8a8a92; font-size:13px; margin:0 0 28px; }
  /* An explicit display beats the hidden attribute's display:none, so the
     sign-in form stayed on screen after signing in. Anything hidden is hidden. */
  [hidden] { display:none !important; }
  form { max-width:340px; display:flex; flex-direction:column; gap:10px; }
  input { background:#16161a; border:1px solid #26262b; border-radius:10px;
          padding:12px 14px; color:#e9e9ee; font-size:15px; }
  button { background:#ffd400; color:#000; border:0; border-radius:999px;
           padding:12px 18px; font-weight:800; font-size:15px; cursor:pointer; }
  button.ghost { background:#16161a; color:#8a8a92; font-weight:600; }
  .err { color:#e5484d; font-size:13px; min-height:18px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; }
  .card { background:#16161a; border-radius:12px; padding:14px 16px; }
  .card .n { font-size:26px; font-weight:800; letter-spacing:-.02em; }
  .card .k { color:#8a8a92; font-size:12px; text-transform:uppercase;
             letter-spacing:.05em; margin-top:2px; }
  .card.warn .n { color:#ffd400; }
  .card.bad .n { color:#e5484d; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em;
       color:#8a8a92; margin:30px 0 10px; font-weight:700; }
  .bars { display:flex; align-items:flex-end; gap:6px; height:110px;
          background:#16161a; border-radius:12px; padding:14px; }
  .bar { flex:1; background:#26262b; border-radius:4px 4px 0 0; position:relative;
         min-height:2px; }
  .bar.on { background:#ffd400; }
  .bar span { position:absolute; bottom:-20px; left:0; right:0; text-align:center;
              font-size:10px; color:#6b6b72; }
  .row { display:flex; justify-content:space-between; align-items:center; gap:12px; }
  .acts { display:flex; gap:8px; }
  .foot { color:#6b6b72; font-size:12px; margin-top:34px; }
  table { width:100%; border-collapse:collapse; background:#16161a; border-radius:12px;
          overflow:hidden; font-size:14px; }
  th { text-align:left; color:#8a8a92; font-size:11px; text-transform:uppercase;
       letter-spacing:.05em; padding:10px 12px; background:#1b1b1f; font-weight:700; }
  td { padding:10px 12px; border-top:1px solid #202024; white-space:nowrap; }
  td.num { text-align:right; color:#a7a7ae; }
  .who { color:#e9e9ee; font-weight:700; }
  .name { color:#8a8a92; font-weight:400; }
  .tag { display:inline-block; font-size:11px; padding:1px 7px; border-radius:999px;
         background:#26262b; color:#a7a7ae; }
  .tag.warn { background:#3a3213; color:#ffd400; }
  .scroll { overflow-x:auto; }
  .note { color:#6b6b72; font-size:12px; margin:0 0 10px; }
  .shots { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:12px; }
  .shot { background:#16161a; border-radius:12px; overflow:hidden; display:flex; flex-direction:column; }
  /* Contained, never cropped: a decision about a picture has to be made about
     all of it. Checkerboard so transparent PNGs are not judged on a dark void. */
  .shot img { width:100%; height:190px; object-fit:contain; background:
      repeating-conic-gradient(#1b1b1f 0% 25%, #141417 0% 50%) 50%/16px 16px; }
  .shot .meta { padding:9px 11px; font-size:12px; color:#8a8a92; flex:1; }
  .shot .who { color:#e9e9ee; font-weight:700; font-size:12.5px; }
  .shot .cap { color:#a7a7ae; margin-top:4px; word-break:break-word; }
  .shot .btns { display:flex; gap:6px; padding:0 11px 11px; }
  .shot button { flex:1; padding:8px 0; font-size:12.5px; border-radius:8px; }
  .shot .no { background:#2a1618; color:#e5484d; font-weight:700; }
</style>
</head>
<body>
<div class="wrap">
  <div class="row">
    <div>
      <h1>OpenTV</h1>
      <p class="sub" id="sub">Community dashboard</p>
    </div>
    <div class="acts">
      <button class="ghost" id="refresh" hidden>Refresh</button>
      <button class="ghost" id="out" hidden>Sign out</button>
    </div>
  </div>

  <form id="login">
    <input id="email" type="email" placeholder="Email" autocomplete="username" required />
    <input id="password" type="password" placeholder="Password" autocomplete="current-password" required />
    <button type="submit">Sign in</button>
    <div class="err" id="err"></div>
  </form>

  <div id="panel" hidden>
    <h2>People</h2>
    <div class="grid" id="people"></div>
    <h2>Activity</h2>
    <div class="grid" id="activity"></div>
    <h2>People, newest first</h2>
    <div class="scroll"><table id="users"></table></div>
    <h2>Photos awaiting review</h2>
    <p class="note" id="revnote"></p>
    <div class="shots" id="review"></div>
    <h2>Joins, last 14 days</h2>
    <div class="bars" id="bars"></div>
    <p class="foot" id="foot"></p>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);

// Times land here as UTC and are read in Baghdad. Showing the date alone hid
// which ones happened in the same hour as each other, which is the whole
// question when you are watching people arrive after a post.
function baghdad(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso ?? '');
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Baghdad',
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function cards(el, items) {
  el.innerHTML = items.map(([k, n, cls]) =>
    '<div class="card ' + (cls || '') + '"><div class="n">' + (n ?? 0).toLocaleString() +
    '</div><div class="k">' + k + '</div></div>').join('');
}

async function load() {
  const res = await fetch('/v1/admin/stats', { credentials: 'same-origin' });
  if (res.status === 401) { show(false); return; }
  const d = await res.json();
  const t = d.totals || {};
  show(true);

  cards($('people'), [
    ['Accounts', t.accounts],
    ['With Apple', t.via_apple],
    ['With Google', t.via_google],
    ['With email', t.via_email],
    // Both of these mean somebody is stuck rather than something is popular.
    ['Unconfirmed', t.unconfirmed, t.unconfirmed ? 'warn' : ''],
    ['No username yet', t.placeholder_handles, t.placeholder_handles ? 'warn' : ''],
    ['Deleted', t.deleted],
    ['Push devices', t.push_devices],
  ]);

  cards($('activity'), [
    ['Comments', t.comments],
    ['Ratings', t.ratings],
    ['Character votes', t.character_votes],
    ['Emotion votes', t.emotion_votes],
    ['Likes', t.likes],
    ['Follows', t.follows],
    ['Lists', t.lists],
    ['Photos held', t.images],
    // The only queue on this page a person has to work through by hand: an
    // image is invisible to everybody until somebody here has looked at it.
    ['Photos to review', t.images_pending, t.images_pending ? 'warn' : ''],
    ['Photos shown', t.images_clean],
    // The only number with a clock on it — 24 hours is the moderation promise.
    ['Open reports', t.open_reports, t.open_reports ? 'bad' : ''],
  ]);

  const joins = d.joins || [];
  const max = Math.max(1, ...joins.map((j) => j.n));
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const hit = joins.find((j) => j.day === dt);
    days.push([dt, hit ? hit.n : 0]);
  }
  $('bars').innerHTML = days.map(([day, n]) =>
    '<div class="bar ' + (n ? 'on' : '') + '" style="height:' + Math.round((n / max) * 100) + '%" title="' +
    day + ': ' + n + '"><span>' + day.slice(8) + '</span></div>').join('');

  const people = await (await fetch('/v1/admin/users', { credentials: 'same-origin' })).json();
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  $('users').innerHTML =
    '<tr><th>Handle</th><th>Signs in with</th><th>Joined</th><th class="num">Comments</th>' +
    '<th class="num">Ratings</th><th class="num">Photos</th><th class="num">Lists</th>' +
    '<th class="num">Followers</th></tr>' +
    (people.items || []).map((u) => {
      const placeholder = String(u.handle).startsWith('user_p_');
      const who = '<span class="who">@' + esc(u.handle) + '</span>' +
        (placeholder ? ' <span class="tag warn">no username yet</span>' : '') +
        (u.display_name ? '<div class="name">' + esc(u.display_name) + '</div>' : '');
      const how = esc((u.providers || '').split(',').join(', ')) +
        (u.unconfirmed ? ' <span class="tag warn">unconfirmed</span>' : '');
      return '<tr><td>' + who + '</td><td>' + how + '</td><td>' + esc(baghdad(u.created_at)) +
        '</td><td class="num">' + u.comments + '</td><td class="num">' + u.ratings +
        '</td><td class="num">' + u.images + '</td><td class="num">' + u.lists +
        '</td><td class="num">' + u.followers + '</td></tr>';
    }).join('');

  await loadReview();

  $('foot').textContent = 'This page can see how many, and who — never what anybody wrote. Read ' +
    new Date().toLocaleTimeString();
}

/**
 * The review queue. Nothing else in the system can make an image public, so
 * this is deliberately one picture, one caption, two buttons — no select-all,
 * no "approve the rest", no keyboard shortcut that could run away with a list.
 */
async function loadReview() {
  const res = await fetch('/v1/admin/images?status=pending', { credentials: 'same-origin' });
  if (!res.ok) return;
  const { items = [] } = await res.json();
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  $('revnote').textContent = items.length
    ? 'Nobody can see these until you decide. Shown = visible to everyone on that comment.'
    : 'Nothing waiting.';

  $('review').innerHTML = items.map((i) => {
    const where = i.season == null ? '' :
      ' · S' + i.season + (i.episode == null ? '' : 'E' + i.episode);
    return '<div class="shot" data-id="' + esc(i.comment_id) + '">' +
      '<img loading="lazy" src="/v1/admin/image/' + encodeURIComponent(i.comment_id) + '" alt="">' +
      '<div class="meta"><div class="who">@' + esc(i.handle) + (i.is_gif ? ' · GIF' : '') + '</div>' +
      '<div class="cap">' + esc(i.body || '(no caption)') + esc(where) + '</div></div>' +
      '<div class="btns"><button data-do="clean">Show</button>' +
      '<button class="no" data-do="blocked">Block</button></div></div>';
  }).join('');
}

// Delegated, so buttons rendered after this file loads still work.
$('review').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-do]');
  if (!btn) return;
  const card = btn.closest('.shot');
  btn.disabled = true;
  const res = await fetch('/v1/admin/images/' + encodeURIComponent(card.dataset.id), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ status: btn.dataset.do }),
  });
  if (res.ok) card.remove();
  else btn.disabled = false;
  if (!$('review').children.length) $('revnote').textContent = 'Nothing waiting.';
});

function show(ok) {
  $('login').hidden = ok;
  $('panel').hidden = !ok;
  $('out').hidden = !ok;
  $('refresh').hidden = !ok;
  $('sub').textContent = ok ? 'Community dashboard' : 'Sign in to continue';
  // The password field survives a failed sign-in; it must not survive a
  // successful one, and it must not be sitting in the DOM behind the panel.
  if (ok) { $('email').value = ''; $('password').value = ''; }
}

$('refresh').addEventListener('click', () => {
  $('refresh').textContent = 'Reading…';
  load().finally(() => { $('refresh').textContent = 'Refresh'; });
});

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('err').textContent = '';
  const res = await fetch('/v1/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ email: $('email').value, password: $('password').value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    $('err').textContent = (body.error && body.error.message) || 'That did not work.';
    return;
  }
  $('password').value = '';
  load();
});

$('out').addEventListener('click', async () => {
  await fetch('/v1/admin/logout', { method: 'POST', credentials: 'same-origin' });
  show(false);
});

load();
</script>
</body>
</html>`;
