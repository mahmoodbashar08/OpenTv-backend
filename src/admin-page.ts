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
  /* A heading that needs a sentence gets one, rather than leaving the reader to
     work out why two sections counting "comments" disagree. */
  .note { color:#6b6b72; font-size:12px; margin:-4px 0 10px; line-height:1.5; }
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
  /* A link, not a button: it reveals what is already on the row rather than
     doing anything, and the row is dense enough without another control. */
  .more { background:none; border:0; padding:0; font:inherit; color:#2e65f2; cursor:pointer; }
  .more:hover { text-decoration:underline; }
  dialog#evdlg { background:#141416; color:#fff; border:1px solid #26262b; border-radius:12px;
    padding:18px 20px; max-width:min(560px,92vw); max-height:80vh; overflow:auto; font:inherit; }
  dialog#evdlg::backdrop { background:rgba(0,0,0,.6); }
  dialog#evdlg h3 { margin:0 0 12px; font-size:15px; }
  dialog#evdlg .ev { white-space:normal; }
  dialog#evdlg .close { margin-top:14px; font:inherit; font-size:12px; padding:5px 12px;
    background:#1c1c1e; color:#fff; border:1px solid #2e2e34; border-radius:7px; cursor:pointer; }
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
  .daynav { margin-left:auto; display:flex; align-items:center; gap:6px; }
  .daynav #dlabel { color:#e9e9ee; font-weight:600; font-size:13px; min-width:92px; text-align:center; }
  .daynav .tab:disabled { opacity:.35; cursor:default; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 12px; }
  .chip { font:inherit; font-size:12.5px; font-weight:600; color:#a7a7ae; background:#16161a;
    border:1px solid #2a2a30; border-radius:999px; padding:6px 12px; cursor:pointer; }
  .chip .n { color:#6b6b72; margin-left:6px; font-weight:500; }
  .chip.on { color:#111; background:#ffd400; border-color:#ffd400; }
  .chip.on .n { color:#4a3f00; }
  .chip.clear { background:transparent; border-style:dashed; }
  .chip:focus-visible { outline:2px solid #ffd400; outline-offset:2px; }
  .shown { color:#8a8a92; font-size:12.5px; margin:-4px 0 10px; }
  /* Doing is the accent; opening is not. */
  .did { color:#FFD400; font-weight:600; }
  /* The linked variant, where nobody has sent a name — underlined so it is
     visibly clickable, same colour so the row still reads as one thing. */
  a.did { text-decoration:underline; text-underline-offset:2px; }
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
      <!-- Refresh may answer from the ten-minute copy; this one never does. -->
      <button class="ghost" id="hard" hidden title="Read everything from the database now">Hard refresh</button>
      <!-- Every phone at once, no app update: off means no CommsUni comments anywhere. -->
      <button class="ghost" id="commsuni" hidden title="Show CommsUni comments in the app">CommsUni: …</button>
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
    <p class="note">Everything the community holds, imports included. These only grow.</p>
    <div class="grid" id="activity"></div>
    <h2>Activity by window &mdash; how much</h2>
    <p class="note">Written in the app, in the window shown. A seeded TV&nbsp;Time archive
       keeps its original dates and is never counted here &mdash; which is why these can read
       zero while the totals above are in the thousands.</p>
    <div class="grid" id="windows"></div>
    <h2>Activity by window &mdash; how many people</h2>
    <p class="note">The same windows, counted as people rather than rows. One member
       seeding an archive cannot move these.</p>
    <div class="grid" id="active"></div>
    <h2>People, newest first</h2>
    <!-- OPENED IS NOT USED. The list answered "who exists" and never "who is
         still here". Two buttons, not three: whether somebody DID anything is a
         tag on their name, so it reads down the column without hiding the rest
         of the list behind a filter. -->
    <!-- FILTERS, NOT TABS: each button is on or off, several at once, and a
         person must match every one that is on. Drawn in the browser from the
         list already loaded — never another request. -->
    <div class="chips" id="chips"></div>
    <div class="shown" id="shown"></div>
    <div class="tabs" id="whotabs">
      <!-- Steps the Opened filter and the day column back one day at a time. -->
      <span class="daynav">
        <button class="tab" id="dprev" title="Previous day">&lsaquo;</button>
        <span id="dlabel">Today</span>
        <button class="tab" id="dnext" title="Next day" disabled>&rsaquo;</button>
      </span>
    </div>
    <div class="scroll"><table id="users"></table></div>
    <!-- One dialog for the whole table: the rows are rebuilt on every refresh,
         so a dialog per row would be thrown away with them. -->
    <dialog id="evdlg"><h3 id="evdlgt"></h3><div id="evdlgb"></div>
      <button class="close" onclick="document.getElementById('evdlg').close()">Close</button></dialog>
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
  // THE PHONE SAYS PAID, THE SERVER DOES NOT. What cost a subscriber their
  // Cloud Backup and Sync on 3 Oct, with every column reading "no". The phone's
  // word grants nothing; it is here so the disagreement is seen.
  const mismatch = u.device_plus === 1 && !u.is_plus && !live
    ? '<div class="tag gone" title="Apple or Google says this account is subscribed; the server does not">&#9888; paid on phone, not on server</div>'
    : '';
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
    return '<span class="tag gone">expired</span><div class="name">' + baghdad(u.plus_until) + '</div>' + mismatch;
  }
  return '<span class="tag">no</span>' + mismatch;
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
  const everything = u.today || [];
  // TITLES NEWLY ON THEIR PUBLIC SHELF (shelf_seen): named, unless it is a
  // whole library arriving at once — a first sync or an import — which is one
  // line, not a hundred.
  const added = everything.filter((r) => r.kind === 'added');
  const rows = everything.filter((r) => r.kind !== 'added');
  // Library work (shows added, episodes marked) is not an event this server
  // keeps — only that the phone republished its totals on this day.
  // WHAT CHANGED, not the whole library: the totals minus where the day
  // started (profile_stats.day_base_*). On the joining day there is no start,
  // so it says what they arrived with. A sync that moved neither count was a
  // favourite, a list or Plus changing.
  const joinedThatDay = typeof u.created_at === 'string' && typeof u.library_at === 'string' && u.created_at.slice(0, 10) === u.library_at.slice(0, 10);
  const signed = (d, one, many) => (d > 0 ? '+' : '') + d + ' ' + (Math.abs(d) === 1 ? one : many);
  let libraryVerb = '';
  let libraryText = '';
  if (u.library_on_day) {
    if (joinedThatDay || u.day_base_episodes == null) {
      libraryVerb = joinedThatDay ? 'joined with' : 'synced';
      libraryText = esc(u.episodes_watched ?? 0) + ' episodes &middot; ' + esc(u.movies_watched ?? 0) + ' films';
    } else {
      const de = (u.episodes_watched ?? 0) - u.day_base_episodes;
      const dm = (u.movies_watched ?? 0) - (u.day_base_movies ?? u.movies_watched ?? 0);
      const parts = [];
      if (de !== 0) parts.push(signed(de, 'episode', 'episodes'));
      if (dm !== 0) parts.push(signed(dm, 'film', 'films'));
      libraryVerb = parts.length ? 'library' : 'changed';
      libraryText = parts.length ? parts.join(' &middot; ') : 'favourites, lists or Plus';
    }
  }
  const libraryLine = libraryVerb
    ? '<div class="ev"><span class="vb">' + libraryVerb + '</span> <span class="did">' + libraryText + '</span></div>'
    : '';
  const shelfLines = !added.length ? ''
    : added.length > 15 || joinedThatDay
      ? '<div class="ev"><span class="vb">added</span> <span class="did">' + added.length + ' titles</span><span class="name"> to their shelves</span></div>'
      : added.map((r) => '<div class="ev"><span class="vb">added</span> <span class="did">' + esc(r.title) +
          '</span><span class="name"> &middot; ' + (r.detail === 'movie' ? 'film' : 'show') + '</span></div>').join('');
  const library = libraryLine + shelfLines;
  if (!rows.length) {
    if (library) return library;
    return openedToday(u) ? '<span class="name">opened only</span>' : '<span class="name">&mdash;</span>';
  }
  // The verb first, because the kind of thing they did is what is being scanned
  // for; the title carries the accent because it is what the eye stops on.
  const verb = { comment: 'wrote on', rating: 'rated', character: 'voted', emotion: 'felt', added: 'added' };
  const one = (r) => {
    const detail = r.kind === 'rating' ? ' ' + esc(r.detail) + '/10'
      : r.kind === 'character' || r.kind === 'emotion' ? ' &middot; ' + esc(r.detail)
      : '';
    // An unnamed TheTVDB id is a link rather than a dead number: nobody has
    // sent this server a name for it, and one click beats copying it out.
    const what = esc(r.title) + (r.where ? ' ' + esc(r.where) : '');
    const did = r.tvdbId
      ? '<a class="did" target="_blank" rel="noopener" href="https://thetvdb.com/dereferrer/series/' +
        esc(r.tvdbId) + '">' + what + '</a>'
      : '<span class="did">' + what + '</span>';
    return '<div class="ev"><span class="vb">' + (verb[r.kind] || r.kind) + '</span> ' + did +
      '<span class="name">' + detail + '</span></div>';
  };
  const all = library + rows.map(one).join('');
  if (rows.length <= 4) return all;
  // The full list travels with the row rather than being fetched again: it is
  // already here, and the dashboard refreshes often enough that a second
  // request would race the rebuild.
  return library + rows.slice(0, 4).map(one).join('') +
    '<button class="more" data-more="' + esc(u.handle || '') + '">+' + (rows.length - 4) + ' more</button>' +
    '<div class="allev" hidden>' + all + '</div>';
}

/**
 * "+12 more" opens the rest, rather than being a fact nobody can act on.
 *
 * Delegated on the table for the same reason wirePlus is: these rows are
 * replaced wholesale on every refresh, so a listener bound per button would be
 * re-attached each time or lost with the row it was on.
 */
function wireMore() {
  $('users').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-more]');
    if (!btn) return;
    const cell = btn.closest('td');
    const all = cell && cell.querySelector('.allev');
    if (!all) return;
    $('evdlgt').textContent = dayName(viewDay || serverToday) + ' — @' + btn.getAttribute('data-more');
    $('evdlgb').innerHTML = all.innerHTML;
    $('evdlg').showModal();
  });
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

/**
 * Cloud backup to OpenTV and sync between devices: when each last happened.
 * "on" is a sync within 30 days — a phone with sync on pushes whenever
 * something changes. Backups also show their size, which says a real library
 * went up rather than an empty one.
 */
function backupSyncCell(u) {
  const short = (iso) => {
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return mins < 60 ? mins + 'm ago' : mins < 1440 ? Math.round(mins / 60) + 'h ago' : Math.round(mins / 1440) + 'd ago';
  };
  const mb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const backup = u.backup_at
    ? '<div><span class="tag paid">backup</span> ' + short(u.backup_at) + (u.backup_bytes ? ' &middot; ' + mb(u.backup_bytes) : '') + '</div>'
    : '<div><span class="tag">backup</span> <span class="name">never</span></div>';
  const syncOn = u.sync_at && Date.now() - Date.parse(u.sync_at) < 30 * 86400000;
  const sync = u.sync_at
    ? '<div><span class="tag ' + (syncOn ? 'paid' : 'gone') + '">sync ' + (syncOn ? 'on' : 'idle') + '</span> ' + short(u.sync_at) + '</div>'
    : '<div><span class="tag">sync</span> <span class="name">never</span></div>';
  return backup + sync;
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
/** A message from OpenTV to one person, in their bell. One way — no replies. */
function wireMessage() {
  $('users').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-msg]');
    if (!btn) return;
    const handle = btn.getAttribute('data-msg');
    const text = prompt('Message to @' + handle + ' (shows in their notifications, max 500 characters). Sign it — Noddy.');
    if (text == null || !text.trim()) return;
    if (text.trim().length > 500) { alert('That is over 500 characters.'); return; }
    btn.disabled = true;
    try {
      const res = await fetch('/v1/admin/users/' + encodeURIComponent(handle) + '/message', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error?.message || 'failed');
      btn.textContent = out.devices > 0 ? 'Sent ✓' : 'Saved — no phone';
      if (!out.devices) alert('Saved, but this person never allowed notifications, so no phone will ring.');
    } catch (err) {
      alert('Not sent: ' + err.message);
      btn.disabled = false;
    }
  });
}

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
    // Google's pre-launch test phones sign in on every Play upload. Shown so
    // they are visible, and left out of Accounts and the Opened counts.
    ['Test robots', t.robots],
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

  await loadPeople();

  await loadReview();

  // WAS "never what anybody wrote", and the Today column made that untrue: it
  // names the title somebody rated or voted on. Comment TEXT is still never
  // read here, and that is the line the sentence now draws.
  $('foot').textContent = 'This page reads counts, and the titles today was spent on — never the ' +
    'text of a comment. Read ' + new Date().toLocaleTimeString();
}

/** Which UTC day the people table is showing; '' is today. */
let viewDay = '';
let serverToday = '';

function dayName(d) {
  if (!d || d === serverToday) return 'Today';
  const y = new Date(Date.parse(serverToday + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  if (d === y) return 'Yesterday';
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

async function loadPeople() {
  const q = viewDay ? '?day=' + viewDay : '';
  const people = await (await fetch('/v1/admin/users' + q, { credentials: 'same-origin' })).json();
  allPeople = people.items || [];
  serverToday = people.today || serverToday;
  const shown = people.day || serverToday;
  const name = dayName(shown);
  $('dlabel').textContent = name;
  openedLabel = 'Opened ' + (name === 'Today' || name === 'Yesterday' ? name.toLowerCase() : 'on ' + name);
  $('dnext').disabled = shown >= serverToday;
  drawPeople();
}

function stepDay(delta) {
  const base = viewDay || serverToday;
  if (!base) return;
  const d = new Date(Date.parse(base + 'T00:00:00Z') + delta * 86400000).toISOString().slice(0, 10);
  viewDay = d >= serverToday ? '' : d;
  void loadPeople();
}

/** The rows as fetched. The tabs filter this in the browser rather than asking
 *  the server again: 200 rows is nothing, and a refetch per tap would make the
 *  three buttons feel like page loads. */
let allPeople = [];
/**
 * The people filters. Every one is a question about a person the list already
 * answers; a person shows when they match ALL the filters that are on.
 */
let openedLabel = 'Opened today';
const FILTERS = [
  { id: 'opened', label: () => openedLabel, test: (u) => openedToday(u) },
  { id: 'did', label: () => 'Did something', test: (u) => didToday(u) || !!u.library_on_day },
  { id: 'paying', label: () => 'Paying', test: (u) => !!u.is_plus },
  { id: 'given', label: () => 'Plus given', test: (u) => !u.is_plus && !!u.plus_until && Date.parse(u.plus_until) > Date.now() },
  { id: 'expired', label: () => 'Plus expired', test: (u) => !u.is_plus && !!u.plus_until && Date.parse(u.plus_until) <= Date.now() },
  { id: 'mismatch', label: () => '\u26A0 Paid on phone', test: (u) => u.device_plus === 1 && !u.is_plus },
  { id: 'backup', label: () => 'Backs up', test: (u) => !!u.backup_at },
  { id: 'sync', label: () => 'Sync on', test: (u) => !!u.sync_at && Date.now() - Date.parse(u.sync_at) < 30 * 86400000 },
  { id: 'library', label: () => 'Has a library', test: (u) => u.episodes_watched != null },
  { id: 'nolibrary', label: () => 'No library yet', test: (u) => u.episodes_watched == null },
  { id: 'nousername', label: () => 'No username', test: (u) => String(u.handle || '').startsWith('user_p_') },
  { id: 'week', label: () => 'Joined this week', test: (u) => Date.now() - Date.parse(u.created_at) < 7 * 86400000 },
  { id: 'apple', label: () => 'Apple', test: (u) => String(u.providers || '').includes('apple') },
  { id: 'google', label: () => 'Google', test: (u) => String(u.providers || '').includes('google') },
  { id: 'email', label: () => 'Email', test: (u) => !!u.email },
  { id: 'robot', label: () => 'Test robots', test: (u) => !!u.robot },
];
const activeFilters = new Set();

function drawChips() {
  $('chips').innerHTML = FILTERS.map((f) =>
    '<button class="chip' + (activeFilters.has(f.id) ? ' on' : '') + '" data-f="' + f.id + '" aria-pressed="' + activeFilters.has(f.id) + '">' +
    f.label() + '<span class="n">' + allPeople.filter(f.test).length + '</span></button>').join('') +
    (activeFilters.size ? '<button class="chip clear" data-f="__clear">Clear</button>' : '');
}

function drawPeople() {
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  /*
   * A COUNT THAT MAY NOT EXIST, said in words.
   *
   * Never published is not the same as zero: a person who opened the app once
   * and closed it may hold a decade of history on their phone, and this server
   * has simply never been told. It was an em dash, which read as a rendering
   * fault twice -- so it says what it means instead. Zero would be the one
   * genuinely wrong answer of the three.
   */
  // Null means their phone has never sent totals: no library of their own yet
  // (a new install shows a demo library, which is never sent) or not opened
  // since signing in. Nothing failed, so it should not read like a fault.
  // "imported" = the server holds TV Time ratings or comments from them, so a
  // library exists on the phone and only the totals are owed.
  const num = (v, u) =>
    v != null ? String(v)
    : u.imported_archive ? '<span class="name">imported, not sent yet</span>'
    : '<span class="name">no library yet</span>';
  const on = FILTERS.filter((f) => activeFilters.has(f.id));
  const rows = allPeople.filter((u) => on.every((f) => f.test(u)));
  drawChips();
  $('shown').textContent = on.length ? 'Showing ' + rows.length + ' of ' + allPeople.length : allPeople.length + ' people';
  $('users').innerHTML =
    '<tr><th>Handle</th><th>Plus</th><th>Give Plus</th><th>Last opened</th><th>Backup / Sync</th><th>' + esc(dayName(viewDay || serverToday)) + '</th>' +
    '<th>Signs in with</th><th>Joined</th><th class="num">Comments</th>' +
    '<th class="num">Ratings</th><th class="num">Feelings</th><th class="num">Characters</th>' +
    '<th class="num">Photos</th><th class="num">Lists</th>' +
    // A LIFETIME TOTAL, NOT AN EVENT. There is no watch history on this server,
    // so nothing here can say what somebody watched today. What a phone sends
    // when it publishes a profile is how many -- which is real, and was sitting
    // unread in profile_stats. Em dash where a profile has never published:
    // that is the truth about it, where 0 would be a claim.
    '<th class="num">Episodes</th><th class="num">Films</th>' +
    '<th class="num">Followers</th></tr>' +
    rows.map((u) => {
      const placeholder = String(u.handle).startsWith('user_p_');
      // THE SAME SHAPE AS THE PLUS TAG, deliberately: both answer "what kind of
      // person is this row" and the eye should find them in one pass down the
      // names rather than two passes across the table.
      const who = '<span class="who">@' + esc(u.handle) + '</span>' +
        (didToday(u) ? ' <span class="tag act">active ' + esc(dayName(viewDay || serverToday).toLowerCase()) + '</span>' : '') +
        ' <button class="more" data-msg="' + esc(u.handle) + '">Message</button>' +
        (u.robot ? ' <span class="tag">Google test robot</span>'
          : placeholder ? ' <span class="tag warn">no username yet</span>' : '') +
        (u.display_name ? '<div class="name">' + esc(u.display_name) + '</div>' : '');
      const how = esc((u.providers || '').split(',').join(', ')) +
        (u.unconfirmed ? ' <span class="tag warn">unconfirmed</span>' : '');
      return '<tr><td>' + who + '</td><td>' + plusCell(u) + '</td><td>' + grantCell(u.handle) +
        '</td><td>' + seenCell(u.last_seen_at) +
          (u.app_version ? '<div class="name">v' + esc(u.app_version) + '</div>' : '') +
        '</td><td>' + backupSyncCell(u) + '</td><td>' + todayCell(u) + '</td><td>' + how +
        '</td><td>' + esc(baghdad(u.created_at)) +
        '</td><td class="num">' + u.comments + '</td><td class="num">' + u.ratings +
        '</td><td class="num">' + u.feelings + '</td><td class="num">' + u.characters +
        '</td><td class="num">' + u.images + '</td><td class="num">' + u.lists +
        '</td><td class="num">' + num(u.episodes_watched, u) +
        '</td><td class="num">' + num(u.movies_watched, u) +
        '</td><td class="num">' + u.followers + '</td></tr>';
    }).join('') ||
    '<tr><td colspan="17" class="name">' + (on.length ? 'Nobody matches these filters.' : 'Nobody yet.') + '</td></tr>';
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

$('dprev').addEventListener('click', () => stepDay(-1));
$('dnext').addEventListener('click', () => stepDay(1));

/* The people filter. Redraws from what is already loaded — see drawPeople. */
$('chips').addEventListener('click', (ev) => {
  const chip = ev.target.closest('.chip[data-f]');
  if (!chip) return;
  const id = chip.dataset.f;
  if (id === '__clear') activeFilters.clear();
  else if (activeFilters.has(id)) activeFilters.delete(id);
  else activeFilters.add(id);
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
  $('hard').hidden = !ok;
  $('commsuni').hidden = !ok;
  if (ok) readCommsuni();
  $('sub').textContent = ok ? 'Community dashboard' : 'Sign in to continue';
  // The password field survives a failed sign-in; it must not survive a
  // successful one, and it must not be sitting in the DOM behind the panel.
  if (ok) { $('email').value = ''; $('password').value = ''; }
}

$('hard').addEventListener('click', async () => {
  $('hard').textContent = 'Reading…';
  try {
    await fetch('/v1/admin/cache/clear', { method: 'POST', credentials: 'same-origin' });
    await load();
  } finally {
    $('hard').textContent = 'Hard refresh';
  }
});

let commsuniOn = null;
function drawCommsuni() {
  $('commsuni').textContent = commsuniOn == null ? 'CommsUni: …' : commsuniOn ? 'CommsUni: on' : 'CommsUni: OFF';
}
async function readCommsuni() {
  const res = await fetch('/v1/admin/commsuni', { credentials: 'same-origin' });
  commsuniOn = res.ok ? (await res.json()).on : null;
  drawCommsuni();
}
$('commsuni').addEventListener('click', async () => {
  if (commsuniOn == null) return;
  const next = !commsuniOn;
  if (!confirm(next
    ? 'Turn CommsUni back on? Every community member sees the archive again.'
    : 'Turn CommsUni off for everybody? No phone will show or send CommsUni comments until you turn it back on.')) return;
  const res = await fetch('/v1/admin/commsuni', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ on: next }),
  });
  if (res.ok) commsuniOn = (await res.json()).on;
  drawCommsuni();
});

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
wireMore();
wireMessage();
load();
</script>
</body>
</html>`;
