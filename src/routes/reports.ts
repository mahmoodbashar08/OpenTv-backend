import { Hono } from 'hono';
import type { App } from '@/env';
import { fail } from '@/http';
import { requireAuth } from '@/middleware';
import { AUTO_HIDE_REPORTS, isReportReason, isReportTargetType, REPORTS_PER_DAY } from '@/pure';

/**
 * Reporting, and the auto-hide that makes a 24-hour moderation promise
 * survivable for one person. docs/IMPLEMENTATION.md Step 3, "Reports and
 * auto-hide".
 */

export const reports = new Hono<App>();

reports.post('/reports', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid_body', 'Body must be JSON.');
  }
  const b = (body ?? {}) as Record<string, unknown>;

  if (!isReportTargetType(b.target_type)) {
    return fail(c, 400, 'invalid_body', 'target_type must be comment, profile or list.');
  }
  if (typeof b.target_id !== 'string' || b.target_id.length === 0) {
    return fail(c, 400, 'invalid_body', 'target_id is required.');
  }
  if (!isReportReason(b.reason)) {
    return fail(c, 400, 'invalid_body', 'reason is not one of the accepted reasons.');
  }

  const db = c.env.DB;
  const me = c.get('profileId');
  const now = new Date();
  const nowIso = now.toISOString();
  const targetType = b.target_type;
  const targetId = b.target_id;

  // One report per reporter per target, guarded by a SELECT rather than a
  // unique index — a person may legitimately re-report after a `dismissed`
  // outcome, and an index would forbid that forever (docs/IMPLEMENTATION.md
  // Step 3).
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const gate = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM reports
                WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'open') AS open_already,
              (SELECT COUNT(*) FROM reports WHERE reporter_id = ? AND created_at > ?) AS today`,
    )
    .bind(me, targetType, targetId, me, dayAgo)
    .first<{ open_already: number; today: number }>();

  if (gate && gate.today >= REPORTS_PER_DAY) {
    return fail(c, 429, 'rate_limited', 'Too many reports today.');
  }
  // Already filed: accepted and dropped. Reporting twice must not read as an
  // error to the person doing the right thing, and must not count twice
  // towards the auto-hide threshold.
  if (gate && gate.open_already > 0) return c.body(null, 202);

  const id = `rep_${crypto.randomUUID().replace(/-/g, '')}`;
  const statements = [
    db
      .prepare(
        `INSERT INTO reports (id, reporter_id, target_type, target_id, reason, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      )
      .bind(id, me, targetType, targetId, b.reason, nowIso),
  ];

  if (targetType === 'comment') {
    // ORDER MATTERS, and the plan's SQL says why. The auto-hide predicate is
    // `report_count + 1 >= AUTO_HIDE_REPORTS` — the count as it stands PLUS
    // this report. It therefore runs BEFORE the increment; run after, it would
    // hide on the fourth report. Five distinct reporters, no fewer.
    statements.push(
      db
        .prepare(
          `UPDATE comments SET hidden_at = ?
           WHERE id = ? AND hidden_at IS NULL AND report_count + 1 >= ?`,
        )
        .bind(nowIso, targetId, AUTO_HIDE_REPORTS),
      db.prepare('UPDATE comments SET report_count = report_count + 1 WHERE id = ?').bind(targetId),
    );
  }
  // `profile` and `list` reports are RECORD-ONLY. There is no auto-hide for an
  // account: five reports must never be able to remove a person from the
  // service without a human looking.

  await db.batch(statements);

  // 202: filed, not yet judged. The queue is a person, and the client should
  // not be told a decision has been made.
  return c.body(null, 202);
});
