import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * The stable machine strings the app switches on. `message` is English and for
 * logs and last-resort display only — the app ships in six languages and
 * localises from `code`, so the server has no business guessing which
 * (docs/IMPLEMENTATION.md, "Error envelope").
 *
 * Status codes: 400 invalid body, 401 no/bad session, 403 blocked or not
 * yours, 404 missing, 409 conflict, 429 rate limited, 500 unexpected.
 */
export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_body'
  | 'handle_taken'
  | 'handle_invalid'
  | 'rate_limited'
  | 'target_invalid'
  | 'too_large'
  | 'blocked'
  // The image binding is absent from this deployment — a capability that is
  // off, not a request that was wrong.
  | 'unavailable'
  // An upload that is not one of the image types the bucket accepts.
  | 'unsupported_type'
  | 'internal';

/** Every failure response in the API. Success responses are the bare resource. */
export function fail(c: Context, status: ContentfulStatusCode, code: ErrorCode, message: string) {
  return c.json({ error: { code, message } }, status);
}
