import type { Env } from '@/env';
import type { Provider } from '@/pure';

/**
 * Provider public keys, cached in KV.
 *
 * Both Apple and Google publish RSA public keys as JWKS and rotate them
 * without notice, so the cache must be able to miss and recover — see the
 * refetch rule below (docs/IMPLEMENTATION.md §1a).
 */

const JWKS_URLS: Record<Provider, string> = {
  apple: 'https://appleid.apple.com/auth/keys',
  google: 'https://www.googleapis.com/oauth2/v3/certs',
};

/** A day is well inside both providers' rotation cadence. */
const JWKS_TTL_SECONDS = 86_400;

/**
 * How long a kid-miss refetch is suppressed for. Without this, a hostile
 * client can make every request fetch Apple by inventing a `kid`.
 */
const REFETCH_GUARD_SECONDS = 60;

type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
type JwkSet = { keys: Jwk[] };

const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

function isJwkSet(v: unknown): v is JwkSet {
  return !!v && typeof v === 'object' && Array.isArray((v as JwkSet).keys);
}

async function fetchSet(provider: Provider): Promise<JwkSet | null> {
  try {
    const res = await fetch(JWKS_URLS[provider]);
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isJwkSet(body) ? body : null;
  } catch {
    return null;
  }
}

async function importKid(set: JwkSet, kid: string): Promise<CryptoKey | null> {
  const jwk = set.keys.find((k) => k.kid === kid);
  if (!jwk) return null;
  try {
    return await crypto.subtle.importKey('jwk', jwk, ALGORITHM, false, ['verify']);
  } catch {
    return null;
  }
}

/**
 * The verification key for `kid`, or null if the provider does not publish it.
 *
 * A missing `kid` in a cached set is the signature of a rotation; refusing to
 * refetch would lock every user out until the TTL expired. So: fetch fresh
 * once, guarded, and give up only if the kid is still unknown afterwards.
 */
export async function getKey(env: Env, provider: Provider, kid: string): Promise<CryptoKey | null> {
  const cacheKey = `jwks:${provider}`;
  const guardKey = `jwks:${provider}:refetch`;

  const cached = await env.CACHE.get(cacheKey, 'json');
  if (isJwkSet(cached)) {
    const key = await importKid(cached, kid);
    if (key) return key;

    // Unknown kid in a cached set. Refetch — at most once a minute.
    const guarded = await env.CACHE.get(guardKey);
    if (guarded) return null;
  }

  await env.CACHE.put(guardKey, '1', { expirationTtl: REFETCH_GUARD_SECONDS });

  const fresh = await fetchSet(provider);
  if (!fresh) return null;
  await env.CACHE.put(cacheKey, JSON.stringify(fresh), { expirationTtl: JWKS_TTL_SECONDS });

  return importKid(fresh, kid);
}
