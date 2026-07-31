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

  /** Not bound yet — avatars ship later. Guarded everywhere it is touched. */
  AVATARS?: R2Bucket;

  /**
   * Where a rescued TV Time comment photo is kept.
   *
   * OPTIONAL, and every use is guarded, for the same reason `AVATARS` is: a
   * missing binding must degrade to "this feature is off" rather than throw on
   * a request that had nothing to do with images.
   */
  COMMENT_IMAGES?: R2Bucket;

  /**
   * The test sign-in's key, and the switch that decides whether it exists.
   *
   * ABSENT IN PRODUCTION — that is the whole design. `POST /v1/auth/dev`
   * answers 404 unless this is set, so a deployment that never sets it does not
   * have the route at all. Set it with `wrangler secret put DEV_AUTH_SECRET`
   * for a multi-account test and DELETE it afterwards: while it exists, anyone
   * holding it can mint a session for a test account here.
   */
  DEV_AUTH_SECRET?: string;
};

/** What `requireAuth` puts on the context. */
export type Vars = {
  profileId: string;
};

export type App = { Bindings: Env; Variables: Vars };
