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
  // The act needs OpenTV Plus. Its own code, not `forbidden`: the app answers
  // it with the paywall, which is a different response from "you may not".
  | 'plus_required'
  | 'not_found'
  | 'invalid_body'
  | 'handle_taken'
  /** The claim volunteered a TV Time id that already sits on another profile.
   *  See the note in `POST /v1/me/handle` for what that does and does not
   *  prove. */
  | 'tvtime_id_claimed'
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
  // The translation model failed or was rate-limited. TRANSIENT, and its own
  // code so the app can offer "try again" rather than hiding the row for good —
  // `unavailable` means the capability is off, which is permanent from the
  // phone's point of view.
  | 'translate_failed'
  // Signed in, but the email address behind the account is still unconfirmed.
  // Its own code rather than a plain `forbidden` because the app has to tell
  // these apart: one is "you may not", the other is "finish this first", and
  // only the second has a screen to send somebody to.
  | 'email_unverified'
  // Sign-in against an address with no account at all. Its own code because
  // "wrong password" sends somebody to try again at a door that is not there,
  // and the only useful reply is "create one".
  | 'no_account'
  // Sign-in against an address whose account uses Apple or Google. The reply
  // carries a `providers` array alongside the envelope so the app can name it.
  | 'use_provider'
  | 'internal';

/** Every failure response in the API. Success responses are the bare resource. */
export function fail(c: Context, status: ContentfulStatusCode, code: ErrorCode, message: string) {
  return c.json({ error: { code, message } }, status);
}
