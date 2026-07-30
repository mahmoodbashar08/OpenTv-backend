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
