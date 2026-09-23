import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';

/**
 * The CommsUni consent record.
 *
 * WHY THE SERVER HOLDS THIS AND NOT THE PHONE. The phone keeps a copy so it
 * can behave correctly offline, but a copy on a device somebody can reinstall
 * is not a record of anything. The backfill guide requires the decision to
 * exist server-side BEFORE any of that user's comments are sent, because the
 * question it answers is asked later and by somebody else: what did this
 * person agree to, when, and to which words.
 *
 * APPEND-ONLY. Every decision is a new row and nothing is ever updated, so a
 * withdrawal cannot erase the evidence that consent was once given, and
 * consent cannot erase a withdrawal. "Their current answer" is the newest row;
 * everything before it is the history that makes the current answer provable.
 *
 * PENDING IS NOT STORED. A dismissed or unanswered prompt writes nothing. The
 * guide is explicit that it stays `pending` and is not `keep_private` —
 * inactivity is neither permission nor refusal — so "no row" is the honest
 * representation and the app may ask again without having recorded an answer
 * nobody gave.
 */
export const commsuni = new Hono<App>();

type Decision = 'share' | 'keep_private';
type Identity = 'profile' | 'persona';

type Body = {
  decision?: unknown;
  identity?: unknown;
  promptVersion?: unknown;
  coversExisting?: unknown;
};

commsuni.post('/commsuni/consent', requireAuth, async (c) => {
  let body: Body;
  try {
    body = (await c.req.json()) as Body;
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }

  const decision = body.decision;
  if (decision !== 'share' && decision !== 'keep_private') {
    // 'pending' is deliberately not accepted. It is the absence of a record,
    // not a value, and letting a client write it would turn "we never asked"
    // into something indistinguishable from an answer.
    return fail(c, 400, 'invalid_body', 'decision must be share or keep_private.');
  }

  const identity = body.identity === 'persona' ? 'persona' : body.identity === 'profile' ? 'profile' : null;
  if (decision === 'share' && identity === null) {
    // The guide asks the identity question only of somebody who has agreed to
    // share — but it does ask it, and a shared comment has to be attributed
    // one way or the other before it is written.
    return fail(c, 400, 'invalid_body', 'identity is required when sharing.');
  }

  const promptVersion = Number(body.promptVersion);
  if (!Number.isInteger(promptVersion) || promptVersion < 1) {
    return fail(c, 400, 'invalid_body', 'promptVersion must be a positive integer.');
  }

  await c.env.DB.prepare(
    `INSERT INTO commsuni_consent (id, profile_id, decision, identity, prompt_version, covers_existing, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      c.get('profileId'),
      decision,
      // Never stored on a refusal: there is no identity to choose when nothing
      // is being shared, and a value here would imply one was offered.
      decision === 'share' ? identity : null,
      promptVersion,
      body.coversExisting === true ? 1 : 0,
      new Date().toISOString(),
    )
    .run();

  return c.json({ ok: true, decision, identity: decision === 'share' ? identity : null });
});

/**
 * The current answer, and whether history may be sent.
 *
 * `backfillAllowed` is computed here rather than left to a caller to work out,
 * because getting it wrong means publishing somebody's years of writing on the
 * strength of a prompt that never mentioned it. The guide's rule: consent to
 * the shared feature authorises backfill ONLY when the prompt disclosed that
 * existing comments were included.
 */
commsuni.get('/commsuni/consent', requireAuth, async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT decision, identity, prompt_version, covers_existing, decided_at
       FROM commsuni_consent WHERE profile_id = ?
      ORDER BY decided_at DESC LIMIT 1`,
  )
    .bind(c.get('profileId'))
    .first<{
      decision: Decision;
      identity: Identity | null;
      prompt_version: number;
      covers_existing: number;
      decided_at: string;
    }>();

  if (!row) return c.json({ decision: 'pending', backfillAllowed: false });

  return c.json({
    decision: row.decision,
    identity: row.identity,
    promptVersion: row.prompt_version,
    coversExisting: row.covers_existing === 1,
    decidedAt: row.decided_at,
    backfillAllowed: row.decision === 'share' && row.covers_existing === 1,
  });
});
