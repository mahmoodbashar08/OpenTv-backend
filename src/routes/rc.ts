import { Hono } from 'hono';
import type { App, Env } from '@/env';
import { fail } from '@/http';
import { constantTimeEqual } from '@/pure';

/**
 * The RevenueCat webhook — the only thing on this server that may grant Plus.
 *
 * WHY A WEBHOOK AT ALL. The phone knows whether it has an entitlement, but the
 * phone is not a source this server can believe: if the client could set the
 * flag, Plus would be free within a week (docs/PLAN.md). RevenueCat talks to
 * Apple and Google, and this route is the one place its answer lands.
 *
 * WHAT IS STORED: one bit and one date. `is_plus`, and `plus_since` the first
 * time it was granted. Not the product, not the store, not the price, not the
 * receipt, not the period — none of it is needed to draw a badge or lift a cap,
 * and a table of what everybody pays is exactly the kind of thing this server
 * exists not to keep. Nothing here is logged beyond the event type; the body
 * carries amounts and country codes, and those must not reach the log.
 *
 * ALWAYS 200 ON A SHAPE WE UNDERSTOOD. RevenueCat retries a 4xx or 5xx for
 * hours, so "this event does not concern us" and "we have never heard of this
 * profile" both answer 200 with `matched: false`. The only failures that answer
 * an error are the ones a retry could genuinely fix or must not be waved
 * through: no secret configured (503), a wrong secret (401), unreadable body
 * (400).
 */
export const rc = new Hono<App>();

/** The entitlement id configured in RevenueCat. One product, one entitlement. */
const PLUS_ENTITLEMENT = 'plus';

/**
 * RevenueCat's own id for a user who was never identified — the app was signed
 * out of the community when it bought. There is no profile to attach it to, and
 * there may never be one; the app calls `logIn()` with the profile id at
 * sign-in and RC then sends an alias/TRANSFER we can act on.
 */
const ANON_PREFIX = '$RCAnonymousID:';

type RcEvent = {
  type?: unknown;
  app_user_id?: unknown;
  entitlement_id?: unknown;
  entitlement_ids?: unknown;
  transferred_from?: unknown;
  transferred_to?: unknown;
};

/**
 * GRANT on the four events that mean "there is money and access right now".
 *
 * PRODUCT_CHANGE is here because a plan switch (monthly → yearly) is not a
 * lapse; UNCANCELLATION because turning auto-renew back on is the opposite of
 * leaving.
 */
const GRANTS = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'NON_RENEWING_PURCHASE']);

/**
 * REVOKE ON EXPIRATION AND NOTHING ELSE, and this is the decision most easily
 * got wrong.
 *
 * CANCELLATION in RevenueCat means auto-renew was switched off — the person has
 * paid for a period they are still inside, and taking Plus away the moment they
 * cancel bills them for a month they cannot use. RC sends EXPIRATION when that
 * period actually ends, which is the event that means access ended.
 *
 * BILLING_ISSUE is a failed charge, not a lapse: the stores retry through a
 * grace period and the great majority recover. If it does not recover,
 * EXPIRATION follows and this route acts then. Being late to revoke costs a few
 * days of a feature; being early takes away something somebody paid for.
 */
const REVOKES = new Set(['EXPIRATION']);

/** True when the event names the entitlement this server sells. */
function namesPlus(ev: RcEvent): boolean {
  if (Array.isArray(ev.entitlement_ids)) return ev.entitlement_ids.includes(PLUS_ENTITLEMENT);
  return ev.entitlement_id === PLUS_ENTITLEMENT;
}

/** Profile ids only: an anonymous RC id, or anything that is not a string, is not one. */
function profileIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0 && !v.startsWith(ANON_PREFIX));
}

/**
 * `plus_since` is set only when it is still null — the FIRST grant. A renewal
 * must not move it, or "member since" would read as today, every month.
 * Idempotent by construction: running the same event twice writes the same row.
 */
async function setPlus(env: Env, profileId: string, on: boolean, nowIso: string): Promise<boolean> {
  const res = on
    ? await env.DB.prepare(
        `UPDATE profiles SET is_plus = 1, plus_since = COALESCE(plus_since, ?)
          WHERE id = ? AND deleted_at IS NULL`,
      )
        .bind(nowIso, profileId)
        .run()
    : await env.DB.prepare('UPDATE profiles SET is_plus = 0 WHERE id = ? AND deleted_at IS NULL')
        .bind(profileId)
        .run();
  return res.meta.changes > 0;
}

rc.post('/rc/webhook', async (c) => {
  // NO SECRET CONFIGURED MEANS NO WEBHOOK, the same rule the admin door
  // follows: an unset secret must refuse everything rather than accept
  // everything, which is what comparing against undefined would quietly do.
  const expected = c.env.RC_WEBHOOK_SECRET;
  if (!expected) return fail(c, 503, 'unavailable', 'No webhook secret is configured.');

  // RevenueCat has no signatures — it sends back the literal string configured
  // in its dashboard. Compared constant-time all the same: this header is the
  // only thing between a stranger and free Plus for every account.
  if (!constantTimeEqual(c.req.header('Authorization') ?? '', expected)) {
    return fail(c, 401, 'unauthenticated', 'Bad webhook secret.');
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const ev = (((body ?? {}) as Record<string, unknown>).event ?? {}) as RcEvent;
  const type = typeof ev.type === 'string' ? ev.type : '';
  // The type, and only the type. The body around it carries price, currency,
  // country and store — none of that goes anywhere near the log.
  console.log(`[rc] ${type || 'unknown'}`);

  const nowIso = new Date().toISOString();

  // ── TRANSFER: the subscription moved between two accounts ─────────────────
  //
  // The flag moves with it, rather than being granted afresh: if the source
  // never had Plus (an anonymous id, or an account whose subscription had
  // already lapsed) the destination gets nothing. Sources are cleared either
  // way — that side of a transfer is always a loss of access.
  if (type === 'TRANSFER') {
    const from = profileIds(ev.transferred_from);
    const to = profileIds(ev.transferred_to);
    let had = false;
    for (const id of from) {
      const row = await c.env.DB.prepare('SELECT is_plus FROM profiles WHERE id = ? AND deleted_at IS NULL')
        .bind(id)
        .first<{ is_plus: number }>();
      if (row?.is_plus === 1) had = true;
      await setPlus(c.env, id, false, nowIso);
    }
    let matched = false;
    for (const id of to) if (await setPlus(c.env, id, had, nowIso)) matched = true;
    return c.json({ ok: true, matched });
  }

  const grant = GRANTS.has(type) && namesPlus(ev);
  const revoke = REVOKES.has(type);
  // Everything else — an event type we do not act on, or one about an
  // entitlement that is not ours — is understood and ignored.
  if (!grant && !revoke) return c.json({ ok: true, matched: false });

  // An anonymous id, a missing one, or a profile that has been deleted: nothing
  // to map, and a 200 so RevenueCat stops asking.
  const [profileId] = profileIds(ev.app_user_id);
  if (!profileId) return c.json({ ok: true, matched: false });

  const matched = await setPlus(c.env, profileId, grant, nowIso);
  return c.json({ ok: true, matched });
});
