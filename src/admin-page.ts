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
  .foot { color:#6b6b72; font-size:12px; margin-top:34px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="row">
    <div>
      <h1>OpenTV</h1>
      <p class="sub" id="sub">Community dashboard</p>
    </div>
    <button class="ghost" id="out" hidden>Sign out</button>
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
    <h2>Joins, last 14 days</h2>
    <div class="bars" id="bars"></div>
    <p class="foot" id="foot"></p>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);

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
    ['Images held', t.images],
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

  $('foot').textContent = 'Counts only — this page can see how many, never what. Read ' +
    new Date().toLocaleTimeString();
}

function show(ok) {
  $('login').hidden = ok;
  $('panel').hidden = !ok;
  $('out').hidden = !ok;
  $('sub').textContent = ok ? 'Community dashboard' : 'Sign in to continue';
}

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
