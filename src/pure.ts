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
