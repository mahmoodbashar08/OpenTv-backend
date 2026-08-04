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
   * Sending email — verification and password resets.
   *
   * ALL OPTIONAL, and email sign-in works without them: an account is created
   * and a token issued whether or not a message can go out. Missing means "no
   * mail configured yet", never a failed signup. See `mail.ts`.
   */
  RESEND_API_KEY?: string;
  /** e.g. `OpenTV <hello@opentv.app>`. Must be a verified Resend domain. */
  MAIL_FROM?: string;
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

};

/** What `requireAuth` puts on the context. */
export type Vars = {
  profileId: string;
  /** 'unverified' for an email account that has not entered its code yet. See
   *  `requireVerified` — the claim rides in the token so auth stays zero-I/O. */
  scope: 'full' | 'unverified';
};

export type App = { Bindings: Env; Variables: Vars };
