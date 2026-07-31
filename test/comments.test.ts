import { describe, expect, it } from 'vitest';
import {
  autoHides,
  AUTO_HIDE_REPORTS,
  COMMENT_BODY_MAX,
  COMMENT_PAGE_DEFAULT,
  COMMENT_PAGE_MAX,
  firstAcceptLanguage,
  isReportReason,
  isValidBcp47,
  makeCursor,
  pageSize,
  parseCursor,
  replyDepthOk,
  REPORT_REASONS,
  shouldNotify,
  stableImportId,
  validateCommentBody,
} from '@/pure';

/**
 * docs/IMPLEMENTATION.md Step 3, "Unit tests". The decisions that can be
 * quietly wrong: the derived id that makes re-importing safe, the cursor that
 * survives identical timestamps, the depth rule, and the threshold arithmetic
 * that decides when a comment disappears.
 */

const ITEM = {
  authorId: 'p_abc',
  targetSource: 'title',
  targetKey: 'amado|2011',
  season: null,
  episode: null,
  createdAt: '2019-04-02T10:00:00.000Z',
  body: 'One of the best things I have seen.',
};

describe('stableImportId — dedupe by construction', () => {
  it('is deterministic across calls', async () => {
    expect(await stableImportId(ITEM)).toBe(await stableImportId(ITEM));
  });

  it('has the shape the plan specifies: imp_ + 32 hex characters', async () => {
    const id = await stableImportId(ITEM);
    expect(id).toMatch(/^imp_[0-9a-f]{32}$/);
  });

  it('differs on a one-character body change', async () => {
    const a = await stableImportId(ITEM);
    const b = await stableImportId({ ...ITEM, body: `${ITEM.body}.` });
    expect(a).not.toBe(b);
  });

  it('differs between two users with the same text', async () => {
    const a = await stableImportId(ITEM);
    const b = await stableImportId({ ...ITEM, authorId: 'p_xyz' });
    expect(a).not.toBe(b);
  });

  it('differs on the episode, so a per-episode comment is not folded into the show', async () => {
    const show = await stableImportId({ ...ITEM, season: 1, episode: null });
    const ep = await stableImportId({ ...ITEM, season: 1, episode: 3 });
    expect(show).not.toBe(ep);
  });

  it('differs on created_at, so the same sentence twice is two comments', async () => {
    const a = await stableImportId(ITEM);
    const b = await stableImportId({ ...ITEM, createdAt: '2020-04-02T10:00:00.000Z' });
    expect(a).not.toBe(b);
  });
});

describe('cursors', () => {
  it('round-trips created_at and id', () => {
    const c = makeCursor('2026-07-31T09:12:44.000Z', 'c_1234');
    expect(parseCursor(c)).toEqual({ createdAt: '2026-07-31T09:12:44.000Z', id: 'c_1234' });
  });

  it('round-trips an imported id, which is where the tiebreak actually matters', () => {
    const c = makeCursor('2019-04-02T10:00:00.000Z', 'imp_0123456789abcdef0123456789abcdef');
    expect(parseCursor(c)?.id).toBe('imp_0123456789abcdef0123456789abcdef');
  });

  it('is base64url — no +, / or = to be mangled in a query string', () => {
    for (let i = 0; i < 64; i++) {
      expect(makeCursor(`2026-07-31T09:12:44.${String(i).padStart(3, '0')}Z`, `c_${i}`)).toMatch(
        /^[A-Za-z0-9_-]+$/,
      );
    }
  });

  it('returns null rather than throwing on anything malformed', () => {
    // A URL is edited by hand, by proxies and by link previewers. A bad cursor
    // is a first page, not a 500.
    for (const bad of ['', '!!!!', 'not-base64!', makeCursor('', ''), 'YQ', null, undefined, '%%%']) {
      expect(parseCursor(bad as string)).toBeNull();
    }
  });

  it('rejects a well-formed base64 payload with no separator', () => {
    expect(parseCursor(makeCursor('2026-07-31T09:12:44.000Z', ''))).toBeNull();
  });
});

describe('pageSize', () => {
  it('defaults to 25 and clamps at 50', () => {
    expect(pageSize(null)).toBe(COMMENT_PAGE_DEFAULT);
    expect(pageSize('abc')).toBe(COMMENT_PAGE_DEFAULT);
    expect(pageSize('0')).toBe(COMMENT_PAGE_DEFAULT);
    expect(pageSize('-5')).toBe(COMMENT_PAGE_DEFAULT);
    expect(pageSize('10')).toBe(10);
    expect(pageSize('500')).toBe(COMMENT_PAGE_MAX);
  });
});

describe('validateCommentBody', () => {
  it('rejects empty and whitespace-only', () => {
    expect(validateCommentBody('')).toEqual({ ok: false, reason: 'empty' });
    expect(validateCommentBody('   \n\t ')).toEqual({ ok: false, reason: 'empty' });
    expect(validateCommentBody(null)).toEqual({ ok: false, reason: 'empty' });
    expect(validateCommentBody(42)).toEqual({ ok: false, reason: 'empty' });
  });

  it('trims and keeps the trimmed form', () => {
    expect(validateCommentBody('  hello  ')).toEqual({ ok: true, body: 'hello' });
  });

  it('accepts exactly 2,000 and rejects 2,001', () => {
    expect(validateCommentBody('a'.repeat(COMMENT_BODY_MAX)).ok).toBe(true);
    expect(validateCommentBody('a'.repeat(COMMENT_BODY_MAX + 1))).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });

  it('allows an emoji-only body, and counts code points not UTF-16 units', () => {
    expect(validateCommentBody('😭😭😭')).toEqual({ ok: true, body: '😭😭😭' });
    // 2,000 emoji are 4,000 UTF-16 units and must still be accepted.
    expect(validateCommentBody('😭'.repeat(COMMENT_BODY_MAX)).ok).toBe(true);
    expect(validateCommentBody('😭'.repeat(COMMENT_BODY_MAX + 1)).ok).toBe(false);
  });

  it('accepts Arabic, which is the audience half this app was built for', () => {
    expect(validateCommentBody('  حلقة رهيبة  ')).toEqual({ ok: true, body: 'حلقة رهيبة' });
  });
});

describe('replyDepthOk — one level only', () => {
  it('allows a reply to a top-level comment', () => {
    expect(replyDepthOk({ parent_id: null })).toBe(true);
  });

  it('refuses a reply to a reply', () => {
    expect(replyDepthOk({ parent_id: 'c_top' })).toBe(false);
  });

  it('refuses a parent that does not resolve', () => {
    expect(replyDepthOk(null)).toBe(false);
    expect(replyDepthOk(undefined)).toBe(false);
  });
});

describe('auto-hide arithmetic', () => {
  it('is five', () => {
    expect(AUTO_HIDE_REPORTS).toBe(5);
  });

  it('does not hide on the fourth report and does on the fifth', () => {
    // `autoHides(n)` is n reports already recorded PLUS the one being filed,
    // which is why the SQL runs before the report_count increment.
    expect(autoHides(3)).toBe(false); // this is the 4th
    expect(autoHides(4)).toBe(true); // this is the 5th
    expect(autoHides(0)).toBe(false);
    expect(autoHides(9)).toBe(true);
  });
});

describe('isValidBcp47', () => {
  it('accepts ordinary tags', () => {
    for (const tag of ['ar', 'en', 'pt-BR', 'zh-Hant-TW', 'de-DE']) {
      expect(isValidBcp47(tag)).toBe(true);
    }
  });

  it('rejects garbage, and anything that could reach a column as junk', () => {
    for (const tag of ['', 'e', 'english-language-tag-far-too-long', '*', 'ar_SA', "ar'; DROP", 12, null]) {
      expect(isValidBcp47(tag)).toBe(false);
    }
  });
});

describe('firstAcceptLanguage', () => {
  it('takes the first tag and drops the quality value', () => {
    expect(firstAcceptLanguage('ar-SA,ar;q=0.9,en;q=0.8')).toBe('ar-SA');
    expect(firstAcceptLanguage('en-GB')).toBe('en-GB');
  });

  it('skips a leading wildcard and returns null when there is nothing usable', () => {
    expect(firstAcceptLanguage('*,fr;q=0.5')).toBe('fr');
    expect(firstAcceptLanguage('*')).toBeNull();
    expect(firstAcceptLanguage(null)).toBeNull();
    expect(firstAcceptLanguage(undefined)).toBeNull();
  });
});

describe('REPORT_REASONS', () => {
  it('is the fixed list, exactly', () => {
    expect([...REPORT_REASONS]).toEqual([
      'spam',
      'harassment',
      'hate',
      'sexual',
      'violence',
      'spoiler',
      'other',
    ]);
  });

  it('membership is checked, not assumed', () => {
    expect(isReportReason('spam')).toBe(true);
    expect(isReportReason('spoiler')).toBe(true);
    expect(isReportReason('because-i-disagree')).toBe(false);
    expect(isReportReason('')).toBe(false);
    expect(isReportReason(null)).toBe(false);
  });
});

describe('shouldNotify — never yourself', () => {
  it('notifies someone else', () => {
    expect(shouldNotify('p_a', 'p_b')).toBe(true);
  });

  it('never notifies the actor', () => {
    expect(shouldNotify('p_a', 'p_a')).toBe(false);
  });

  it('refuses an empty side rather than writing a dangling row', () => {
    expect(shouldNotify('', 'p_b')).toBe(false);
    expect(shouldNotify('p_a', '')).toBe(false);
  });
});
