/**
 * The Worker's bindings and the per-request variables handlers set.
 *
 * Lives in its own file rather than in `index.ts` so that `jwks.ts`,
 * `session.ts` and the route modules can name the type without importing the
 * module that imports them.
 */
export type Env = {
  DB: D1Database;
  CACHE: KVNamespace;

  /** HS256 signing key for session tokens. `wrangler secret put` in production. */
  SESSION_SECRET: string;
  /** The iOS bundle id — the `aud` an Apple ID token must carry. */
  APPLE_BUNDLE_ID: string;
  /**
   * Comma-separated Google OAuth client ids: iOS, Android **and Web**. Android
   * sign-in returns the *web* client id as `aud`, which is the classic trap.
   */
  GOOGLE_CLIENT_IDS: string;

  /** Profile pictures and covers. Guarded everywhere it is touched. */
  AVATARS?: R2Bucket;

  /**
   * Shared secret for the `/v1/admin/*` routes — support-bundle requests and
   * downloads. `wrangler secret put ADMIN_SECRET`. Absent means the admin
   * surface is OFF (every admin route 404s), so a deployment without it
   * exposes nothing, and a support bundle can never be requested or pulled
   * until the operator opts in by setting it.
   */
  ADMIN_SECRET?: string;

  /**
   * Sending email — verification and password resets.
   *
   * ALL OPTIONAL, and email sign-in works without them: an account is created
   * and a token issued whether or not a message can go out. Missing means "no
   * mail configured yet", never a failed signup. See `mail.ts`.
   */
  RESEND_API_KEY?: string;
  /** e.g. `OpenTV <hello@opentv.app>`. Must be a verified Resend domain. */
  MAIL_FROM?: string;
  /**
   * "off" closes email SIGN-UP, and nothing else.
   *
   * A kill switch rather than a code change, because the reason to use it is
   * always "right now": 1.3.0 shipped a claim that cannot succeed on an
   * unverified session, so every account made with an address was stranded on a
   * `user_p_…` handle it had no way to change. Blocking new ones for a day
   * costs a few sign-ups; letting them through costs those people their name.
   *
   * Sign-IN stays open — the people already stuck must still be able to get in
   * and be repaired by the next release. Apple and Google are unaffected: they
   * arrive verified, so the bug never applied to them.
   */
  EMAIL_SIGNUP?: string;
  /**
   * The admin dashboard's two credentials, both SECRETS — never vars, because
   * vars live in wrangler.jsonc and wrangler.jsonc lives in git.
   *
   * Unset means the door is closed: `/v1/admin/login` answers 503 rather than
   * comparing against undefined and letting anybody in.
   */
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  /** Deep links the emails point at. Defaults are the app's own scheme. */
  APP_LINK_BASE?: string;
  APP_RESET_LINK_BASE?: string;

  /**
   * Where a rescued TV Time comment photo is kept.
   *
   * OPTIONAL, and every use is guarded, for the same reason `AVATARS` is: a
   * missing binding must degrade to "this feature is off" rather than throw on
   * a request that had nothing to do with images.
   */
  COMMENT_IMAGES?: R2Bucket;

  /**
   * The exact string RevenueCat is configured to send as the `Authorization`
   * header of its webhook — RC has no signature scheme, only this shared
   * secret, so it IS the whole of the authentication.
   *
   * `wrangler secret put RC_WEBHOOK_SECRET`, and paste the same value into
   * RevenueCat → Integrations → Webhooks → Authorization header.
   *
   * Unset means the door is closed, exactly as with ADMIN_PASSWORD: the route
   * answers 503 rather than comparing against undefined and letting anybody
   * grant themselves Plus. A deployment that has not opted in has no webhook.
   */
  RC_WEBHOOK_SECRET?: string;
};

/** What `requireAuth` puts on the context. */
export type Vars = {
  profileId: string;
  /** 'unverified' for an email account that has not entered its code yet. See
   *  `requireVerified` — the claim rides in the token so auth stays zero-I/O. */
  scope: 'full' | 'unverified';
};

export type App = { Bindings: Env; Variables: Vars };
