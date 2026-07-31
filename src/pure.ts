/**
 * Pure functions: no imports, no bindings, no clock. Everything here is a
 * decision that can be wrong, which is why it is here and unit-tested rather
 * than buried in a handler (docs/IMPLEMENTATION.md, "Testing philosophy").
 *
 * THE SHARED IDENTITY RULE
 * -----------------------
 * `slug` / `movieBaseName` / `movieYearOf` / `targetKey` below are mirrored
 * **character-for-character** in `mobile/src/pure.ts`. Phone and server must
 * compute the same key for the same film or they build two threads for it.
 * Change one side and you have split the conversation for every film whose
 * title is touched by the change.
 *
 * The test vectors that pin the rule live in `test/pure.test.ts` here and must
 * exist identically on the app side (docs/IMPLEMENTATION.md, "The shared
 * identity rule" — the table of eleven vectors).
 *
 * The single most important line in this file is the character class
 * `[^\p{L}\p{N}]+` with the `u` flag. An ASCII-only `[^a-z0-9]` would reduce
 * every Arabic title to the empty string and collapse the entire Arabic
 * catalogue into one thread.
 */

/** slug: lowercase · NFKD-fold diacritics · non-alphanumerics → single hyphen · trim hyphens */
export function slug(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '') // drop combining marks: é → e, مُ → م
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-') // Unicode-aware: Arabic and CJK survive
    .replace(/^-+|-+$/g, '');
}

/**
 * The title with a trailing "(YYYY)" removed, lowercased and with runs of
 * whitespace collapsed.
 *
 * TV Time spells the same film two ways — "Dune (2021)" from the watched rows
 * and a bare "Dune" from the watchlist — and the trailing year is the only
 * thing separating them, as it is the only thing separating a genuine remake.
 * So it is stripped here and decided on separately in `movieYearOf`.
 */
export function movieBaseName(name: string): string {
  return name
    .replace(/\s*\((\d{4})\)\s*$/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * The film's year: the stored column if it starts with four digits, else a
 * "(YYYY)" suffix on the title, else null.
 *
 * The `.slice(0, 4)` is deliberate and is the app's `movieYear()` behaviour:
 * the column often carries a full release date, so "2021-10-22" yields 2021.
 */
export function movieYearOf(name: string, year?: string | null): string | null {
  const col = (year ?? '').trim().slice(0, 4);
  if (/^\d{4}$/.test(col)) return col;
  const m = /\((\d{4})\)\s*$/.exec(name);
  return m ? m[1]! : null;
}

/** The address of a thread. Shows are an id; films without one are slug|year. */
export function targetKey(
  source: 'tvdb' | 'tmdb' | 'title',
  a: { id?: number | string | null; title?: string | null; year?: string | null },
): string {
  if (source === 'tvdb' || source === 'tmdb') return String(a.id);
  const base = movieBaseName(a.title ?? ''); // strips a trailing "(YYYY)"
  const year = movieYearOf(a.title ?? '', a.year); // column first, then suffix
  return `${slug(base)}|${year ?? ''}`;
}

// ── ID-token claims ──────────────────────────────────────────────────────────
//
// The crypto lives in `src/auth.ts`; only the *rules* live here, because the
// rules are what can be quietly wrong. The table below is
// docs/IMPLEMENTATION.md §1b, claim for claim.

export type Provider = 'apple' | 'google';

/** A decoded — NOT yet trusted — ID-token payload. */
export type IdTokenPayload = {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  sub?: unknown;
  email?: unknown;
};

export type ExpectedClaims = {
  provider: Provider;
  /** Apple: the bundle id. Google: every configured client id. */
  audiences: readonly string[];
};

export type ClaimsResult =
  | { ok: true; sub: string; email: string | null }
  | { ok: false; reason: ClaimFailure };

export type ClaimFailure =
  | 'bad_issuer'
  | 'bad_audience'
  | 'expired'
  | 'issued_in_future'
  | 'missing_sub';

/** Google emits both spellings of its issuer, and has done for years. */
const ISSUERS: Record<Provider, readonly string[]> = {
  apple: ['https://appleid.apple.com'],
  google: ['https://accounts.google.com', 'accounts.google.com'],
};

/** Clock-skew allowance on `iat`, in seconds. */
export const IAT_SKEW_SECONDS = 300;

/**
 * Validate every claim, no exceptions. `nowMs` is a parameter so this stays
 * testable and this file stays clock-free.
 *
 * Not checked, deliberately: `nonce` (the app is not a browser, there is no
 * redirect to replay) and `email_verified` (email is stored for support only
 * and is never trusted for identity).
 */
export function verifyClaims(
  payload: IdTokenPayload,
  expected: ExpectedClaims,
  nowMs: number,
): ClaimsResult {
  const nowSec = Math.floor(nowMs / 1000);

  const iss = typeof payload.iss === 'string' ? payload.iss : '';
  if (!ISSUERS[expected.provider].includes(iss)) return { ok: false, reason: 'bad_issuer' };

  // `aud` is a string for both providers today, but the JWT spec allows an
  // array and accepting one costs a line.
  const auds: string[] = Array.isArray(payload.aud)
    ? payload.aud.filter((a): a is string => typeof a === 'string')
    : typeof payload.aud === 'string'
      ? [payload.aud]
      : [];
  const allowed = expected.audiences.filter((a) => a.length > 0);
  if (allowed.length === 0 || !auds.some((a) => allowed.includes(a))) {
    return { ok: false, reason: 'bad_audience' };
  }

  if (typeof payload.exp !== 'number' || !(payload.exp > nowSec)) {
    return { ok: false, reason: 'expired' };
  }

  if (typeof payload.iat !== 'number' || payload.iat > nowSec + IAT_SKEW_SECONDS) {
    return { ok: false, reason: 'issued_in_future' };
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    return { ok: false, reason: 'missing_sub' };
  }

  return {
    ok: true,
    sub: payload.sub,
    email: typeof payload.email === 'string' && payload.email.length > 0 ? payload.email : null,
  };
}

// ── handles ──────────────────────────────────────────────────────────────────

/** Reserved for the placeholder handles a fresh profile is born with. */
export const HANDLE_PLACEHOLDER_PREFIX = 'user_';

/** Small and deliberate. Names that would let someone impersonate the service. */
export const RESERVED_HANDLES: readonly string[] = [
  'admin',
  'opentv',
  'support',
  'help',
  'api',
  'moderator',
];

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;

/** NFKC, lowercase, trim. Everything downstream sees only this form. */
export function normaliseHandle(input: string): string {
  return input.normalize('NFKC').trim().toLowerCase();
}

export type HandleFailure = 'too_short' | 'too_long' | 'bad_characters' | 'reserved';

/**
 * `[a-z0-9_]` only, and that is not an oversight. A handle is an address people
 * type and read aloud; homograph attacks on a follow-someone-by-name flow are
 * not theoretical. A Cyrillic "а" fails here, which is the point.
 *
 * Takes the RAW input and normalises internally, so a caller cannot forget to.
 */
export function isHandleValid(input: string): { ok: true; handle: string } | { ok: false; reason: HandleFailure } {
  const h = normaliseHandle(input);
  if (h.length < HANDLE_MIN) return { ok: false, reason: 'too_short' };
  if (h.length > HANDLE_MAX) return { ok: false, reason: 'too_long' };
  if (!/^[a-z0-9_]+$/.test(h)) return { ok: false, reason: 'bad_characters' };
  if (h.startsWith(HANDLE_PLACEHOLDER_PREFIX)) return { ok: false, reason: 'reserved' };
  if (RESERVED_HANDLES.includes(h)) return { ok: false, reason: 'reserved' };
  return { ok: true, handle: h };
}

/**
 * The handle a brand-new profile is born with. Never invent a pretty one
 * server-side: the user picks it, and a taken name must be refused
 * (docs/PLAN.md §3, "Handles are a suggestion, not a claim").
 */
export function placeholderHandle(profileId: string): string {
  return `${HANDLE_PLACEHOLDER_PREFIX}${profileId.slice(0, 10)}`;
}

/** True when the app must run the handle flow before anything social. */
export function needsHandle(handle: string): boolean {
  return handle.startsWith(HANDLE_PLACEHOLDER_PREFIX);
}

// ── ratings ──────────────────────────────────────────────────────────────────

/** The three addressable kinds of thing. Mirrors the CHECK constraints in 0001. */
export const TARGET_SOURCES = ['tvdb', 'tmdb', 'title'] as const;
export type TargetSource = (typeof TARGET_SOURCES)[number];

export function isTargetSource(v: unknown): v is TargetSource {
  return typeof v === 'string' && (TARGET_SOURCES as readonly string[]).includes(v);
}

/**
 * The emotion allow-list — TV Time's own twelve, exactly as the app presents
 * them, so an imported reaction has somewhere to land and every tap a user
 * makes actually counts for something.
 *
 * These names and this ORDER are index-locked to `EMOTIONS` in
 * `mobile/src/app/episode/[id].tsx`, which is in turn index-locked to the
 * local database. Reorder one and you must reorder all three.
 *
 * An earlier draft of this list had six invented names and the app folded its
 * twelve onto them, which silently dropped reflective, bored, understood and
 * confused and merged shocked with thrilled. Widening it costs nothing —
 * `emotion_counts` is a JSON object, so new keys need no migration — and it
 * means the community mirrors what TV Time actually had.
 *
 * This list is not decoration. Emotion names are interpolated into a JSON path
 * (`'$.' || :name`) in the aggregate upsert, so an unvalidated emotion is a
 * JSON-path injection. Nothing reaches that SQL without passing through here.
 */
export const EMOTIONS = [
  'shocked',
  'frustrated',
  'sad',
  'reflective',
  'touched',
  'amused',
  'scared',
  'bored',
  'understood',
  'thrilled',
  'confused',
  'tense',
] as const;
export type Emotion = (typeof EMOTIONS)[number];

export function isEmotion(v: unknown): v is Emotion {
  return typeof v === 'string' && (EMOTIONS as readonly string[]).includes(v);
}

export const SCORE_MIN = 1;
export const SCORE_MAX = 10;

/** A vote as it is stored: either half may be null, never both. */
export type Vote = { score: number | null; emotion: string | null };

/**
 * How a vote moves the rollup. `emotionFrom`/`emotionTo` are names, not counts:
 * the caller turns them into the `json_set` pair, skipping the decrement when
 * `emotionFrom` is null, the increment when `emotionTo` is null, and both when
 * they are equal.
 */
export type AggregateDelta = {
  dVotes: number;
  dScore: number;
  emotionFrom: string | null;
  emotionTo: string | null;
};

/**
 * docs/IMPLEMENTATION.md Step 2, "The delta logic", row for row:
 *
 * | new vote with a score        | +1 | +next.score  | null → next.emotion |
 * | new vote, emotion only       | +1 |  0           | null → next.emotion |
 * | changed score 7 → 9          |  0 | +2           | unchanged           |
 * | score added to emotion-only  |  0 | +next.score  | unchanged           |
 * | score removed (score → null) |  0 | -prev.score  | unchanged           |
 * | emotion changed only         |  0 |  0           | prev → next         |
 *
 * `vote_count` counts *people*, which is why an emotion-only vote still adds
 * one and a re-vote adds none. The two extra cases the table does not name fall
 * out of the same arithmetic: emotion-only → score-only clears the emotion
 * (from = e, to = null, so only the decrement runs), and an identical re-vote
 * is all zeroes with from === to, so the emotion clause is skipped entirely.
 */
export function aggregateDelta(prev: Vote | null, next: Vote): AggregateDelta {
  const prevScore = prev?.score ?? null;
  const nextScore = next.score ?? null;
  return {
    dVotes: prev ? 0 : 1,
    dScore: (nextScore ?? 0) - (prevScore ?? 0),
    emotionFrom: prev?.emotion ?? null,
    emotionTo: next.emotion ?? null,
  };
}

export type VoteFailure =
  | 'score_invalid'
  | 'emotion_invalid'
  | 'empty_vote'
  | 'season_invalid'
  | 'episode_invalid'
  | 'episode_without_season';

export type ValidatedVote = {
  score: number | null;
  emotion: Emotion | null;
  season: number | null;
  episode: number | null;
};

/**
 * Everything a vote body must satisfy before a statement is prepared. Score 0
 * and score 11 die here, not at the CHECK constraint, so the client gets
 * `invalid_body` rather than a 500 wearing a database error's clothes.
 */
export function validateVote(input: {
  score?: unknown;
  emotion?: unknown;
  season?: unknown;
  episode?: unknown;
}): { ok: true; vote: ValidatedVote } | { ok: false; reason: VoteFailure } {
  const rawScore = input.score ?? null;
  let score: number | null = null;
  if (rawScore !== null) {
    if (typeof rawScore !== 'number' || !Number.isInteger(rawScore)) {
      return { ok: false, reason: 'score_invalid' };
    }
    if (rawScore < SCORE_MIN || rawScore > SCORE_MAX) return { ok: false, reason: 'score_invalid' };
    score = rawScore;
  }

  const rawEmotion = input.emotion ?? null;
  let emotion: Emotion | null = null;
  if (rawEmotion !== null) {
    if (!isEmotion(rawEmotion)) return { ok: false, reason: 'emotion_invalid' };
    emotion = rawEmotion;
  }

  // A vote that says nothing is not a vote; it is a delete, and deleting is
  // not this endpoint's job.
  if (score === null && emotion === null) return { ok: false, reason: 'empty_vote' };

  const season = numberOrNull(input.season);
  if (season === undefined) return { ok: false, reason: 'season_invalid' };
  const episode = numberOrNull(input.episode);
  if (episode === undefined) return { ok: false, reason: 'episode_invalid' };
  // Episode 3 of nothing in particular is not addressable.
  if (episode !== null && season === null) return { ok: false, reason: 'episode_without_season' };

  return { ok: true, vote: { score, emotion, season, episode } };
}

/**
 * null for absent, the number for a valid one, `undefined` for invalid.
 * Exported because comments address the same season/episode space as ratings
 * and must reject the same bodies.
 */
export function numberOrNull(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return undefined;
  return v;
}

/** The `t=` form of GET /v1/aggregates, parsed. */
export type ParsedTarget = {
  source: TargetSource;
  key: string;
  season: number;
  episode: number;
};

export const MAX_TARGETS = 100;

/**
 * `t=source:key[:season:episode]`, repeated, capped at 100. Any malformed
 * member poisons the whole call and returns null — a silently dropped target
 * would show a film with no votes rather than an error, which is worse.
 *
 * THE PARSING RULE, and it is not obvious.
 *
 * A `title:` key is `slug|year`, so it always contains a literal `|` and may
 * end in digits (`title:1917|2019`). It can never contain a `:` — `slug()`
 * replaces every non-alphanumeric with `-`, and the year is digits. So:
 *
 *   1. split on the FIRST `:` — everything before it is the source;
 *   2. season/episode are taken from the LAST two `:`-separated segments of the
 *      remainder, and only when there are at least two `:` in the remainder AND
 *      both trailing segments are pure digits;
 *   3. otherwise the whole remainder is the key.
 *
 * `title:1917|2019` therefore keeps its year: the remainder holds no `:` at
 * all, so rule 2 never fires. `tvdb:121361:1:3` splits into key 121361,
 * season 1, episode 3. Season and episode are normalised to -1 here, matching
 * `rating_aggregates`' primary key, which cannot hold NULLs.
 */
export function parseTargets(raw: readonly string[]): ParsedTarget[] | null {
  if (raw.length === 0 || raw.length > MAX_TARGETS) return null;

  const out: ParsedTarget[] = [];
  for (const t of raw) {
    const firstColon = t.indexOf(':');
    if (firstColon <= 0) return null;
    const source = t.slice(0, firstColon);
    if (!isTargetSource(source)) return null;

    let rest = t.slice(firstColon + 1);
    let season = -1;
    let episode = -1;

    const parts = rest.split(':');
    if (parts.length >= 3) {
      const ep = parts[parts.length - 1]!;
      const se = parts[parts.length - 2]!;
      if (/^\d+$/.test(ep) && /^\d+$/.test(se)) {
        season = Number(se);
        episode = Number(ep);
        rest = parts.slice(0, -2).join(':');
      } else {
        return null; // a `:` in the remainder that is not a season/episode pair
      }
    } else if (parts.length === 2) {
      return null; // half a pair: unparseable, and guessing would be worse
    }

    if (rest.length === 0) return null;
    out.push({ source, key: rest, season, episode });
  }
  return out;
}

// ── comments ─────────────────────────────────────────────────────────────────

/** 1–2,000 characters after trim. Emoji-only is a legitimate comment. */
export const COMMENT_BODY_MAX = 2000;

/** The thread page. 25 by default, never more than 50 (docs/IMPLEMENTATION.md Step 3). */
export const COMMENT_PAGE_DEFAULT = 25;
export const COMMENT_PAGE_MAX = 50;

/** Per-user write limits, enforced in D1 where the data already lives. */
export const COMMENTS_PER_HOUR = 30;
export const REPORTS_PER_DAY = 20;

/** One call's worth of seeding. The app chunks; the server refuses more. */
export const IMPORT_MAX_ITEMS = 200;

export type BodyFailure = 'empty' | 'too_long';

/**
 * Counted in code points, not UTF-16 units: an emoji-only body is allowed, and
 * a limit that counted surrogate halves would make "2,000 characters" mean
 * something different for Arabic and for emoji than it does for English.
 */
export function validateCommentBody(
  input: unknown,
): { ok: true; body: string } | { ok: false; reason: BodyFailure } {
  if (typeof input !== 'string') return { ok: false, reason: 'empty' };
  const body = input.trim();
  if (body.length === 0) return { ok: false, reason: 'empty' };
  if ([...body].length > COMMENT_BODY_MAX) return { ok: false, reason: 'too_long' };
  return { ok: true, body };
}

/**
 * Replies are one level deep (docs/PLAN.md §3 — "deeper threading is a
 * moderation problem wearing a feature costume"). A reply to a reply is
 * refused, never silently re-parented: the client that sent it is wrong and
 * needs to hear so.
 *
 * Takes the parent row as loaded (or null when the id resolved to nothing).
 */
export function replyDepthOk(parent: { parent_id: string | null } | null | undefined): boolean {
  return !!parent && parent.parent_id === null;
}

// ── cursors ──────────────────────────────────────────────────────────────────
//
// `base64url(created_at + '|' + id)`. The id is in there because an imported
// seeding batch writes hundreds of rows in the same second, and `created_at`
// alone would then skip or repeat rows across a page boundary. The pair is a
// total order; `created_at` alone is not.

export type Cursor = { createdAt: string; id: string };

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function makeCursor(createdAt: string, id: string): string {
  return toBase64Url(`${createdAt}|${id}`);
}

/**
 * null for anything that is not a cursor this server made. NEVER throws: a
 * cursor arrives in a URL, and a URL is edited by hand, by proxies and by
 * link previewers. A malformed one is a first page, not a 500.
 */
export function parseCursor(raw: string | null | undefined): Cursor | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const decoded = fromBase64Url(raw);
  if (decoded === null) return null;
  const bar = decoded.indexOf('|');
  if (bar <= 0) return null;
  const createdAt = decoded.slice(0, bar);
  const id = decoded.slice(bar + 1);
  if (createdAt.length === 0 || id.length === 0) return null;
  return { createdAt, id };
}

/** The page size a `limit` param asks for, clamped. Anything unparseable is the default. */
export function pageSize(raw: string | null | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return COMMENT_PAGE_DEFAULT;
  return Math.min(n, COMMENT_PAGE_MAX);
}

// ── seeding ──────────────────────────────────────────────────────────────────

/**
 * DEDUPE BY CONSTRUCTION, NOT BY QUERY.
 *
 * The id of an imported comment is derived from its content, so re-importing
 * the same GDPR export is a no-op no matter how many times it runs — with no
 * read-before-write and no unique index to add. `INSERT OR IGNORE` does the
 * rest. This mirrors the app's own merge-safe import rule.
 *
 *   'imp_' + hex(SHA-256(author ‖ ' ' ‖ source ‖ ' ' ‖ key ‖ ' ' ‖ season
 *                        ‖ ' ' ‖ episode ‖ ' ' ‖ created_at ‖ ' ' ‖ body))[0..32]
 *
 * A null season or episode renders as the empty string. Async because WebCrypto
 * is; it hashes and nothing else, so this file stays free of bindings.
 */
export async function stableImportId(input: {
  authorId: string;
  targetSource: string;
  targetKey: string;
  season: number | null;
  episode: number | null;
  createdAt: string;
  body: string;
}): Promise<string> {
  const material = [
    input.authorId,
    input.targetSource,
    input.targetKey,
    input.season ?? '',
    input.episode ?? '',
    input.createdAt,
    input.body,
  ].join(' ');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `imp_${hex.slice(0, 32)}`;
}

// ── language ─────────────────────────────────────────────────────────────────

/**
 * Loose on purpose. `lang` is a hint for filtering a thread, not a
 * localisation decision, and a strict registry check would reject valid tags
 * the day IANA adds one. It exists to keep junk — and anything with a quote in
 * it — out of the column.
 *
 * Never guessed from the text: language detection does not fit in a Worker's
 * 10 ms CPU budget, and a wrong stamp is worse than none.
 */
export function isValidBcp47(v: unknown): v is string {
  return typeof v === 'string' && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(v);
}

/**
 * The first tag of an `Accept-Language` header, quality values and whitespace
 * removed, or null. `*` is not a language.
 */
export function firstAcceptLanguage(header: string | null | undefined): string | null {
  if (typeof header !== 'string') return null;
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]!.trim();
    if (isValidBcp47(tag)) return tag;
  }
  return null;
}

// ── moderation ───────────────────────────────────────────────────────────────

/**
 * Five distinct reporters hide a comment pending human review. A constant, not
 * a literal in SQL, so it can be tuned without hunting through statements.
 *
 * This is the mechanism that makes Apple's 24-hour response requirement
 * survivable for a solo moderator: the bad comment is invisible within minutes,
 * and `reports.first_seen_at` still starts the clock when a human opens the
 * queue.
 */
export const AUTO_HIDE_REPORTS = 5;

export const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate',
  'sexual',
  'violence',
  'spoiler',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export function isReportReason(v: unknown): v is ReportReason {
  return typeof v === 'string' && (REPORT_REASONS as readonly string[]).includes(v);
}

/** Only a comment can be auto-hidden; profiles and lists are recorded for a human. */
export const REPORT_TARGET_TYPES = ['comment', 'profile', 'list'] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

export function isReportTargetType(v: unknown): v is ReportTargetType {
  return typeof v === 'string' && (REPORT_TARGET_TYPES as readonly string[]).includes(v);
}

/** Whether `n` reports in the table plus this one is enough to hide. */
export function autoHides(existingReports: number): boolean {
  return existingReports + 1 >= AUTO_HIDE_REPORTS;
}

// ── notifications ────────────────────────────────────────────────────────────

/**
 * Never notify yourself. Every write path checks this first
 * (docs/IMPLEMENTATION.md Step 4, "Notification write paths"). Imported
 * comments never notify anybody at all, which is the caller's business.
 */
export function shouldNotify(actorId: string, recipientId: string): boolean {
  return actorId.length > 0 && recipientId.length > 0 && actorId !== recipientId;
}

/**
 * The inbox is marked read by WATERMARK, not by a list of ids: the badge then
 * clears in one request regardless of how many rows are behind it
 * (docs/IMPLEMENTATION.md Step 4).
 *
 * This mirrors the `created_at <= ?` in that statement, boundary included — a
 * notification stamped exactly at the watermark IS covered. Exclusive would
 * leave the newest row unread every single time, because that is precisely the
 * timestamp a client sends back.
 */
export function coveredByWatermark(createdAt: string, upTo: string): boolean {
  return createdAt <= upTo;
}

// ── follow, profiles, reconnection (Step 4) ─────────────────────────────────

/** Followers and following. Bigger than a thread page: a name list is cheap to render. */
export const FOLLOW_PAGE = 50;

/**
 * `plus_until > now` — a BOOLEAN, never the date. The date is an entitlement
 * detail and belongs to RevenueCat (docs/IMPLEMENTATION.md Step 4); handing it
 * to every reader of a public profile publishes a stranger's billing cycle.
 *
 * Compared as ISO strings, which sort correctly as long as both are UTC — and
 * every timestamp this server writes is `toISOString()`.
 */
export function isPlus(plusUntil: string | null | undefined, nowIso: string): boolean {
  return typeof plusUntil === 'string' && plusUntil.length > 0 && plusUntil > nowIso;
}

export type ProfileCounts = {
  followers: number;
  following: number;
  comments: number;
  lists: number;
};

/** Everything a profile read gathers, before the privacy rule is applied. */
export type FullProfileView = {
  id: string;
  handle: string;
  display_name: string | null;
  avatar_key: string | null;
  bio: string | null;
  is_private: boolean;
  links: unknown;
  is_plus: boolean;
  counts: ProfileCounts;
  followed_by_me: boolean;
  created_at: string;
};

/** What a given viewer is allowed to see of it. `null` where a field is withheld. */
export type VisibleProfile = Omit<FullProfileView, 'bio' | 'links' | 'counts'> & {
  bio: string | null;
  links: unknown;
  counts: ProfileCounts | null;
};

/**
 * The `is_private` matrix, in one place because it is the rule most easily got
 * subtly wrong in three handlers.
 *
 * A private profile still returns its SHELL — handle, display name, avatar and
 * `is_private: true`. It has to: you cannot ask to follow someone you cannot
 * find. What it withholds is counts, bio and links, and it withholds them from
 * everyone who is neither the owner nor an accepted follower.
 *
 * The withheld fields come back as explicit `null` rather than as missing keys,
 * so the client renders one shape and the plan's `jq .counts` reads `null`.
 */
export function visibleProfileFields(
  profile: FullProfileView,
  viewerFollows: boolean,
  isSelf: boolean,
): VisibleProfile {
  if (!profile.is_private || isSelf || viewerFollows) return { ...profile };
  return {
    ...profile,
    bio: null,
    links: null,
    counts: null,
  };
}

/** One reconcile call's worth of friend ids. The app loops; the server refuses more. */
export const RECONCILE_MAX_IDS = 500;

export type FriendIdsFailure = 'not_an_array' | 'too_many' | 'not_an_integer';

/**
 * TV Time ids are positive integers and nothing else. A float, a numeric
 * string or a negative is a client bug, and answering it with a 400 is how the
 * client's author finds out — silently coercing would send junk into an `IN`
 * over a partial index and return nothing, forever, for no visible reason.
 */
export function validateFriendIds(
  v: unknown,
): { ok: true; ids: number[] } | { ok: false; reason: FriendIdsFailure } {
  if (!Array.isArray(v)) return { ok: false, reason: 'not_an_array' };
  if (v.length > RECONCILE_MAX_IDS) return { ok: false, reason: 'too_many' };
  const ids: number[] = [];
  for (const raw of v) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
      return { ok: false, reason: 'not_an_integer' };
    }
    ids.push(raw);
  }
  // Duplicates in an export are real; deduping here keeps the `IN` list honest.
  return { ok: true, ids: [...new Set(ids)] };
}

/** Fixed-size slices. The app chunks `friend_ids` at 500; this is the same rule, server-side. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── maintenance ──────────────────────────────────────────────────────────────

/**
 * Merge two `rating_aggregates.emotion_counts` blobs, JSON string in, JSON
 * string out. The 5c merge case (docs/IMPLEMENTATION.md Step 5c): when a
 * `title` thread's aggregate row moves onto a `tvdb` key that already has one,
 * the counts are summed rather than one side overwriting the other.
 *
 * Anything that is not a positive-integer count is dropped rather than trusted:
 * the write path leaves zeroed keys behind (`json_set(..., MAX(0, n - 1))`), and
 * a merge is the natural place to stop carrying them. Malformed JSON — which
 * only a hand-edited row could produce — is treated as empty, because failing a
 * whole overnight migration over one bad blob would be the worse outcome.
 */
export function mergeEmotionCounts(a: string | null, b: string | null): string {
  const out: Record<string, number> = {};
  for (const raw of [a, b]) {
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
      out[key] = (out[key] ?? 0) + Math.floor(value);
    }
  }
  return JSON.stringify(out);
}
