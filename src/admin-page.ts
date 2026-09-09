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
  /*
   * 1500, not 900. The people table used to be seven columns and fitted; it is
   * eleven now, and every one of them is a fact you read across a single row —
   * who they are, whether they are Plus, when they last opened it. A narrow
   * column that scrolls sideways turns "read a row" into "read half a row and
   * drag". Capped rather than full width so the stat cards above do not stretch
   * into a line of numbers a metre apart on a big screen.
   */
  .wrap { max-width: 1500px; margin: 0 auto; padding: 40px 20px 80px; }
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
  /* PAID and GIVEN look different on purpose. One is revenue and one is a
     favour, and a single green tick would hide which is which. */
  .tag.paid { background:#13341c; color:#78be3d; }
  .tag.gift { background:#1b2540; color:#7ea6ff; }
  .tag.gone { background:#2a1416; color:#e5484d; }
  .tag.act { background:#3a3213; color:#ffd400; }
  .ev { white-space:nowrap; line-height:1.5; }
  .vb { color:#6b6b72; }
  .plusbox { display:flex; gap:5px; align-items:center; }
  .plusbox select, .plusbox button { font:inherit; font-size:12px; padding:2px 6px;
      border-radius:6px; border:1px solid #34343a; background:#1c1c1f; color:#e9e9ee; }
  .plusbox button { cursor:pointer; }
  .plusbox button:disabled { opacity:.5; cursor:default; }
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
  .tabs { display:flex; gap:6px; margin-bottom:12px; }
  .tab { background:#16161a; color:#8a8a92; font-weight:600; font-size:13px;
         padding:7px 14px; border-radius:999px; }
  .tab.on { background:#26262b; color:#e9e9ee; }
  /* Doing is the accent; opening is not. */
  .did { color:#FFD400; font-weight:600; }
  .bulkbar { margin-top:14px; }
  .bulkbar button { width:auto; }
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
    <h2>Activity by window &mdash; how much</h2>
    <div class="grid" id="windows"></div>
    <h2>Activity by window &mdash; how many people</h2>
    <div class="grid" id="active"></div>
    <h2>People, newest first</h2>
    <!-- OPENED IS NOT USED. The list answered "who exists" and never "who is
         still here". Two buttons, not three: whether somebody DID anything is a
         tag on their name, so it reads down the column without hiding the rest
         of the list behind a filter. -->
    <div class="tabs" id="whotabs">
      <button class="tab on" data-who="all">Everyone</button>
      <button class="tab" data-who="opened">Opened today</button>
    </div>
    <div class="scroll"><table id="users"></table></div>
    <h2>Photos</h2>
    <div class="tabs" id="tabs">
      <button class="tab on" data-status="pending">Waiting</button>
      <button class="tab" data-status="clean">Shown</button>
      <button class="tab" data-status="blocked">Blocked</button>
    </div>
    <p class="note" id="revnote"></p>
    <div class="shots" id="review"></div>
    <div class="bulkbar" id="bulkbar" hidden>
      <button class="ghost" id="showall">Show all on this page</button>
    </div>
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

/**
 * WHAT KIND OF PLUS, and until when.
 *
 * is_plus is a subscription the webhook wrote. plus_until in the future is
 * something given by hand. They are shown differently because they mean
 * different things: one is revenue and might churn, the other is a favour and
 * expires on a date nobody is charged on.
 *
 * A PAST plus_until is shown too, greyed. "Had a month, it ran out" is the
 * thing you want to see before deciding whether to give another.
 */
function plusCell(u) {
  const until = u.plus_until ? new Date(u.plus_until) : null;
  const live = until && !isNaN(until) && until.getTime() > Date.now();
  if (u.is_plus) {
    return '<span class="tag paid">paying</span>' +
      (u.plus_since ? '<div class="name">since ' + baghdad(u.plus_since) + '</div>' : '');
  }
  if (live) {
    const days = Math.ceil((until.getTime() - Date.now()) / 86400000);
    return '<span class="tag gift">given</span>' +
      '<div class="name">ends ' + baghdad(u.plus_until) + ' (' + days + 'd)</div>';
  }
  if (until && !isNaN(until)) {
    return '<span class="tag gone">expired</span><div class="name">' + baghdad(u.plus_until) + '</div>';
  }
  return '<span class="tag">no</span>';
}

/** Never "3 hours ago" with no date under it: a relative age answers "are they
 *  still here", the date answers "when exactly", and both get asked. */
/**
 * WHAT TODAY PRODUCED, beside when they last opened it.
 *
 * "3h ago" says the app launched. It does not say whether the person rated an
 * episode, voted a character or wrote a sentence, and those are the only events
 * that make this a community rather than a list of installs. Opening and doing
 * are drawn differently on purpose: a launch with nothing after it is dim, and
 * anything at all is the accent.
 *
 * Imports are already excluded upstream, so a seeded archive never appears here
 * as a busy afternoon.
 */
function todayCell(u) {
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const rows = u.today || [];
  if (!rows.length) {
    return openedToday(u) ? '<span class="name">opened only</span>' : '<span class="name">&mdash;</span>';
  }
  // The verb first, because the kind of thing they did is what is being scanned
  // for; the title carries the accent because it is what the eye stops on.
  const verb = { comment: 'wrote on', rating: 'rated', character: 'voted', emotion: 'felt' };
  return rows.slice(0, 4).map((r) => {
    const detail = r.kind === 'rating' ? ' ' + esc(r.detail) + '/10'
      : r.kind === 'character' || r.kind === 'emotion' ? ' &middot; ' + esc(r.detail)
      : '';
    return '<div class="ev"><span class="vb">' + (verb[r.kind] || r.kind) + '</span> ' +
      '<span class="did">' + esc(r.title) + (r.where ? ' ' + esc(r.where) : '') + '</span>' +
      '<span class="name">' + detail + '</span></div>';
  }).join('') + (rows.length > 4 ? '<div class="name">+' + (rows.length - 4) + ' more</div>' : '');
}

/**
 * Did the app speak to the server today — the SERVER'S today.
 *
 * This used to work out midnight from the browser's clock, which is three hours
 * away from UTC here, so for three hours every night the cards above counted one
 * day and this table filtered another. The route decides now and sends the
 * answer; the page only reads it.
 */
function openedToday(u) {
  return !!u.opened_today;
}

/** Anything at all today, whatever kind. */
function didToday(u) {
  return !!(u.today && u.today.length);
}

function seenCell(iso) {
  if (!iso) return '<span class="name">never</span>';
  const t = Date.parse(iso);
  if (!isFinite(t)) return '<span class="name">' + baghdad(iso) + '</span>';
  const mins = Math.round((Date.now() - t) / 60000);
  const ago = mins < 60 ? mins + 'm ago'
    : mins < 1440 ? Math.round(mins / 60) + 'h ago'
    : Math.round(mins / 1440) + 'd ago';
  return ago + '<div class="name">' + baghdad(iso) + '</div>';
}

/** Months, then Give. 0 is in the list because removing a grant is the same
 *  action as setting one — the whole feature is a single date. */
function grantCell(handle) {
  const opts = [1, 2, 3, 4, 5, 6, 12, 0].map((m) =>
    '<option value="' + m + '">' + (m === 0 ? 'remove' : m === 12 ? '1 year' : m + ' month' + (m > 1 ? 's' : '')) + '</option>',
  ).join('');
  return '<div class="plusbox"><select data-h="' + handle + '">' + opts + '</select>' +
    '<button data-give="' + handle + '">Give</button></div>';
}

/**
 * Wired once on the table rather than per button: the rows are rebuilt on every
 * refresh, and a listener per row would be re-attached each time or lost.
 */
function wirePlus() {
  $('users').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-give]');
    if (!btn) return;
    const handle = btn.getAttribute('data-give');
    const sel = $('users').querySelector('select[data-h="' + CSS.escape(handle) + '"]');
    const months = Number(sel.value);
    const label = months === 0 ? 'Remove Plus from @' + handle + '?'
      : 'Give @' + handle + ' ' + (months === 12 ? '1 year' : months + ' month(s)') + ' of Plus?';
    if (!confirm(label)) return;
    btn.disabled = true;
    btn.textContent = '...';
    try {
      const res = await fetch('/v1/admin/users/' + encodeURIComponent(handle) + '/plus', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ months }),
      });
      if (!res.ok) throw new Error((await res.json()).error?.message || 'failed');
      await load();
    } catch (err) {
      alert(String(err.message || err));
      btn.disabled = false;
      btn.textContent = 'Give';
    }
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
    // ACTIVE MEMBERS, never "active users". Only members reach this server, so
    // this is the whole of what can honestly be counted — and the people it
    // leaves out are the ones the app promises never to contact.
    ['Opened today', t.active_today],
    ['Last 7 days', t.active_7d],
    ['Last 30 days', t.active_30d],
    // Two cards, never one. See the note on the query: adding a hand-out to a
    // subscription makes the business look like something it is not.
    ['Plus paying', t.plus_paying],
    ['Plus given', t.plus_given],
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
    // THE LIST REPAIR. Films is the number that matters: a call that resolves
    // nothing still counts as a call, so calls alone would look like success.
    ['List fixes asked', t.repair_calls],
    ['Films restored', t.repair_films],
    ['Catalogue films', t.catalogue_films],
    ['Photos held', t.images],
    // The only queue on this page a person has to work through by hand: an
    // image is invisible to everybody until somebody here has looked at it.
    ['Photos to review', t.images_pending, t.images_pending ? 'warn' : ''],
    ['Photos shown', t.images_clean],
    // The only number with a clock on it — 24 hours is the moderation promise.
    ['Open reports', t.open_reports, t.open_reports ? 'bad' : ''],
  ]);

  /* HOW MUCH IS HAPPENING. The Activity totals above only ever grow, so they
     say what the community HOLDS and never what it DID this week. Each row is
     the same three windows the People section uses, plus the per-day average
     over thirty days — the one number that can be compared with last month. */
  const per = (n, days) => Math.round(((n || 0) / days) * 10) / 10;
  /* SAME THREE NOUNS, SAME ORDER, IN BOTH SECTIONS. They were "Comments,
     Ratings, Characters" here and "Rated, Commented, Voted" below — three
     different words in a different order for the same three things, which
     reads as two sections disagreeing rather than as rows against people. */
  cards($('windows'), [
    ['Comments today', t.comments_today],
    ['Comments, 7 days', t.comments_7d],
    ['Comments, 30 days', t.comments_30d],
    ['Comments a day', per(t.comments_30d, 30)],
    ['Ratings today', t.ratings_today],
    ['Ratings, 7 days', t.ratings_7d],
    ['Ratings, 30 days', t.ratings_30d],
    ['Ratings a day', per(t.ratings_30d, 30)],
    ['Character votes today', t.characters_today],
    ['Character votes, 7 days', t.characters_7d],
    ['Character votes, 30 days', t.characters_30d],
    ['Character votes a day', per(t.characters_30d, 30)],
  ]);

  /* THE ONLY NUMBERS HERE A SINGLE IMPORT CANNOT MOVE. One member seeding a
     TV Time archive can put three thousand ratings on the board in a day; they
     are still one person, and this is the row that says so. */
  cards($('active'), [
    ['People commenting today', t.commenters_today],
    ['People commenting, 7 days', t.commenters_7d],
    ['People commenting, 30 days', t.commenters_30d],
    ['People rating today', t.raters_today],
    ['People rating, 7 days', t.raters_7d],
    ['People rating, 30 days', t.raters_30d],
    ['People voting today', t.voters_today],
    ['People voting, 7 days', t.voters_7d],
    ['People voting, 30 days', t.voters_30d],
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
  allPeople = people.items || [];
  drawPeople();

  await loadReview();

  // WAS "never what anybody wrote", and the Today column made that untrue: it
  // names the title somebody rated or voted on. Comment TEXT is still never
  // read here, and that is the line the sentence now draws.
  $('foot').textContent = 'This page reads counts, and the titles today was spent on — never the ' +
    'text of a comment. Read ' + new Date().toLocaleTimeString();
}

/** The rows as fetched. The tabs filter this in the browser rather than asking
 *  the server again: 200 rows is nothing, and a refetch per tap would make the
 *  three buttons feel like page loads. */
let allPeople = [];
let whoFilter = 'all';

function drawPeople() {
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const rows = allPeople.filter((u) => (whoFilter === 'opened' ? openedToday(u) : true));
  $('users').innerHTML =
    '<tr><th>Handle</th><th>Plus</th><th>Give Plus</th><th>Last opened</th><th>Today</th>' +
    '<th>Signs in with</th><th>Joined</th><th class="num">Comments</th>' +
    '<th class="num">Ratings</th><th class="num">Photos</th><th class="num">Lists</th>' +
    '<th class="num">Followers</th></tr>' +
    rows.map((u) => {
      const placeholder = String(u.handle).startsWith('user_p_');
      // THE SAME SHAPE AS THE PLUS TAG, deliberately: both answer "what kind of
      // person is this row" and the eye should find them in one pass down the
      // names rather than two passes across the table.
      const who = '<span class="who">@' + esc(u.handle) + '</span>' +
        (didToday(u) ? ' <span class="tag act">active today</span>' : '') +
        (placeholder ? ' <span class="tag warn">no username yet</span>' : '') +
        (u.display_name ? '<div class="name">' + esc(u.display_name) + '</div>' : '');
      const how = esc((u.providers || '').split(',').join(', ')) +
        (u.unconfirmed ? ' <span class="tag warn">unconfirmed</span>' : '');
      return '<tr><td>' + who + '</td><td>' + plusCell(u) + '</td><td>' + grantCell(u.handle) +
        '</td><td>' + seenCell(u.last_seen_at) +
          (u.app_version ? '<div class="name">v' + esc(u.app_version) + '</div>' : '') +
        '</td><td>' + todayCell(u) + '</td><td>' + how +
        '</td><td>' + esc(baghdad(u.created_at)) +
        '</td><td class="num">' + u.comments + '</td><td class="num">' + u.ratings +
        '</td><td class="num">' + u.images + '</td><td class="num">' + u.lists +
        '</td><td class="num">' + u.followers + '</td></tr>';
    }).join('') ||
    '<tr><td colspan="12" class="name">Nobody yet today.</td></tr>';
}

/**
 * The review queue. Nothing else in the system can make an image public, so
 * this is deliberately one picture, one caption, two buttons — no select-all,
 * no "approve the rest", no keyboard shortcut that could run away with a list.
 */
let reviewStatus = 'pending';

async function loadReview() {
  const res = await fetch('/v1/admin/images?status=' + reviewStatus, { credentials: 'same-origin' });
  if (!res.ok) return;
  const { items = [] } = await res.json();
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  // Each status is a different sentence, because each is a different question:
  // what have I not decided, what am I publishing, what did I refuse.
  const notes = {
    pending: items.length + ' waiting. Nobody can see these until you decide. Scroll them before using "Show all" — that button clears exactly what is on this page, nothing that arrives later.',
    clean: items.length + ' visible to everyone right now, on the comment each belongs to. Block anything here and it stops being served.',
    blocked: items.length + ' refused. The file is still stored; nobody is served it.',
  };
  const empty = { pending: 'Nothing waiting.', clean: 'Nothing is being shown.', blocked: 'Nothing blocked.' };
  $('revnote').textContent = items.length ? notes[reviewStatus] : empty[reviewStatus];
  // "Show all" is a way to clear a backlog, not a way to re-approve or to undo
  // a block, so it belongs to the waiting list alone.
  $('bulkbar').hidden = items.length === 0 || reviewStatus !== 'pending';

  $('review').innerHTML = items.map((i) => {
    const where = i.season == null ? '' :
      ' · S' + i.season + (i.episode == null ? '' : 'E' + i.episode);
    return '<div class="shot" data-id="' + esc(i.comment_id) + '">' +
      '<img loading="lazy" src="/v1/admin/image/' + encodeURIComponent(i.comment_id) + '" alt="">' +
      '<div class="meta"><div class="who">@' + esc(i.handle) + (i.is_gif ? ' · GIF' : '') + '</div>' +
      '<div class="cap">' + esc(i.body || '(no caption)') + esc(where) + '</div></div>' +
      '<div class="btns">' +
      (reviewStatus === 'clean' ? '' : '<button data-do="clean">Show</button>') +
      (reviewStatus === 'blocked' ? '' : '<button class="no" data-do="blocked">Block</button>') +
      '</div></div>';
  }).join('');
}

/* The people filter. Redraws from what is already loaded — see drawPeople. */
$('whotabs').addEventListener('click', (ev) => {
  const tab = ev.target.closest('.tab');
  if (!tab) return;
  whoFilter = tab.dataset.who;
  [...$('whotabs').children].forEach((b) => b.classList.toggle('on', b === tab));
  drawPeople();
});

$('tabs').addEventListener('click', (ev) => {
  const tab = ev.target.closest('.tab');
  if (!tab) return;
  reviewStatus = tab.dataset.status;
  [...$('tabs').children].forEach((b) => b.classList.toggle('on', b === tab));
  void loadReview();
});

$('showall').addEventListener('click', async () => {
  const ids = [...$('review').children].map((el) => el.dataset.id);
  if (!ids.length) return;
  // The one confirm on this page. A bulk approve is the only action here that
  // cannot be taken back one picture at a time.
  if (!confirm('Show all ' + ids.length + ' of these photos to everyone?')) return;
  $('showall').disabled = true;
  $('showall').textContent = 'Working…';
  const res = await fetch('/v1/admin/images/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ ids, status: 'clean' }),
  });
  $('showall').disabled = false;
  $('showall').textContent = 'Show all on this page';
  if (res.ok) { await load(); }
});

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
  if (!$('review').children.length) void loadReview();
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

// Once, before the first render. The rows are replaced on every refresh, so
// the listener lives on the table rather than on the buttons inside it.
wirePlus();
load();
</script>
</body>
</html>`;
