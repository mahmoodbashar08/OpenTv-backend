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
 * The emotion allow-list — TV Time's own set, so an imported reaction has
 * somewhere to land and the app's existing icons keep their meaning.
 *
 * This list is not decoration. Emotion names are interpolated into a JSON path
 * (`'$.' || :name`) in the aggregate upsert, so an unvalidated emotion is a
 * JSON-path injection. Nothing reaches that SQL without passing through here.
 */
export const EMOTIONS = ['love', 'fun', 'wow', 'sad', 'scared', 'angry'] as const;
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

/** null for absent, the number for a valid one, `undefined` for invalid. */
function numberOrNull(v: unknown): number | null | undefined {
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
