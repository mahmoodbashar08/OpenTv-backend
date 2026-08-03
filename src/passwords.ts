/**
 * Passwords, and the tokens that stand in for them.
 *
 * PBKDF2-SHA256 RATHER THAN BCRYPT OR ARGON2, because this runs on workerd:
 * WebCrypto is what exists, and a pure-JS bcrypt would be both slower and
 * easier to get wrong. PBKDF2 with a high iteration count is the accepted
 * answer where nothing better is available, and OWASP's current figure for
 * PBKDF2-HMAC-SHA256 is what `ITERATIONS` tracks.
 *
 * THE PARAMETERS TRAVEL WITH THE HASH — `pbkdf2$<iterations>$<salt>$<hash>` —
 * so raising the cost later is a one-line change that re-hashes each user on
 * their next sign-in, rather than a migration that cannot be written because
 * the old passwords are gone.
 *
 * EVERY COMPARISON IS CONSTANT TIME. A `===` on a hash leaks how much of it
 * matched through timing, and the same applies to the verification and reset
 * tokens, which are passwords by another name for as long as they live.
 */

/**
 * THE CEILING IS WORKERD'S, NOT A CHOICE.
 *
 * OWASP's figure for PBKDF2-HMAC-SHA256 is 600,000, and this started at
 * 210,000. Both are refused at runtime:
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000
 *   are not supported (requested 210000).
 *
 * Node's WebCrypto has no such cap, so every test passed against a limit
 * production enforces and the runner does not — the registration endpoint
 * returned a 500 for a reason no suite could see. `MAX_ITERATIONS` exists so a
 * test can assert the ceiling even where it is not enforced.
 *
 * What this costs: 100,000 rounds is weaker than the current recommendation,
 * and it is the most the platform will run. The mitigations that do not depend
 * on it — a per-account lockout, a screening list, hashed tokens — are in place
 * for that reason. If it ever matters more than it does, the answer is a
 * dedicated hashing service, not a higher number this runtime will refuse.
 */
export const MAX_ITERATIONS = 100_000;
const ITERATIONS = MAX_ITERATIONS;
const SALT_BYTES = 16;
const HASH_BITS = 256;

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

/** Constant-time byte comparison. Length is compared first — it is not secret. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Does this password match that stored hash?
 *
 * A malformed or unknown-scheme hash is `false`, never a throw: a corrupt row
 * must fail the sign-in, not the whole request with a 500 that says the row is
 * interesting.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  // Above the platform ceiling `deriveBits` throws rather than returning, so a
  // hash written by some other runtime is rejected here instead of surfacing as
  // a 500 on somebody's sign-in.
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > MAX_ITERATIONS) return false;
  try {
    const salt = unb64(parts[2]!);
    const expected = unb64(parts[3]!);
    const actual = await derive(password, salt, iterations);
    return sameBytes(actual, expected);
  } catch {
    return false;
  }
}

/** True when a hash was made with fewer rounds than we now use — re-hash on sign-in. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  return parts[0] !== 'pbkdf2' || Number(parts[1]) < ITERATIONS;
}

// ── one-time tokens ─────────────────────────────────────────────────────────

/**
 * A verification or reset token: 32 random bytes, URL-safe.
 *
 * Returned in the clear ONCE, to be emailed, and stored only as a SHA-256
 * digest. A database that leaks then contains no usable tokens — the same
 * reasoning as the password hash, and it matters more here because a reset
 * token is a password that types itself.
 */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return b64(new Uint8Array(digest));
}

/** Constant time, for the same reason `verifyPassword` is. */
export function sameToken(a: string, b: string): boolean {
  return sameBytes(new TextEncoder().encode(a), new TextEncoder().encode(b));
}
