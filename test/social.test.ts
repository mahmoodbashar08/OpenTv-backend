import { describe, expect, it } from 'vitest';
import {
  chunk,
  coveredByWatermark,
  type FullProfileView,
  isPlus,
  RECONCILE_MAX_IDS,
  validateFriendIds,
  visibleProfileFields,
} from '@/pure';

/**
 * docs/IMPLEMENTATION.md Step 4, "Unit tests". The decisions that can be
 * quietly wrong: who sees what on a private profile, a Plus flag that must
 * never leak a billing date, the watermark boundary that decides whether a
 * badge ever clears, and the input guard on the one endpoint that reads other
 * people's ids.
 */

const PROFILE: FullProfileView = {
  id: 'p_b',
  handle: 'sara',
  display_name: 'Sara',
  avatar_key: 'av/sara.jpg',
  bio: 'Watching everything twice.',
  is_private: true,
  links: ['https://example.com'],
  is_plus: false,
  counts: { followers: 12, following: 30, comments: 88, lists: 2 },
  followed_by_me: false,
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('visibleProfileFields — the is_private matrix', () => {
  it('shows a stranger of a PRIVATE profile the shell, and only the shell', () => {
    const v = visibleProfileFields(PROFILE, false, false);
    // The shell must exist, or you cannot request to follow someone.
    expect(v.handle).toBe('sara');
    expect(v.display_name).toBe('Sara');
    expect(v.avatar_key).toBe('av/sara.jpg');
    expect(v.is_private).toBe(true);
    // And nothing else.
    expect(v.counts).toBeNull();
    expect(v.bio).toBeNull();
    expect(v.links).toBeNull();
  });

  it('shows a FOLLOWER of a private profile the counts, bio and links', () => {
    const v = visibleProfileFields({ ...PROFILE, followed_by_me: true }, true, false);
    expect(v.counts).toEqual(PROFILE.counts);
    expect(v.bio).toBe(PROFILE.bio);
    expect(v.links).toEqual(PROFILE.links);
  });

  it('shows the owner everything, private or not', () => {
    const v = visibleProfileFields(PROFILE, false, true);
    expect(v.counts).toEqual(PROFILE.counts);
    expect(v.bio).toBe(PROFILE.bio);
    expect(v.links).toEqual(PROFILE.links);
    expect(v.is_private).toBe(true);
  });

  it('shows a stranger of a PUBLIC profile everything', () => {
    const v = visibleProfileFields({ ...PROFILE, is_private: false }, false, false);
    expect(v.counts).toEqual(PROFILE.counts);
    expect(v.bio).toBe(PROFILE.bio);
  });

  it('never mutates the profile it was handed', () => {
    const input = { ...PROFILE };
    visibleProfileFields(input, false, false);
    expect(input.counts).toEqual(PROFILE.counts);
    expect(input.bio).toBe(PROFILE.bio);
  });

  it('carries is_plus and followed_by_me through the shell — both are needed to render it', () => {
    const v = visibleProfileFields({ ...PROFILE, is_plus: true }, false, false);
    expect(v.is_plus).toBe(true);
    expect(v.followed_by_me).toBe(false);
  });
});

describe('isPlus — a boolean, never a date', () => {
  const now = '2026-07-31T12:00:00.000Z';

  it('is false when nothing was ever purchased', () => {
    expect(isPlus(null, now)).toBe(false);
    expect(isPlus(undefined, now)).toBe(false);
    expect(isPlus('', now)).toBe(false);
  });

  it('is false for an entitlement that has run out', () => {
    expect(isPlus('2026-07-30T12:00:00.000Z', now)).toBe(false);
  });

  it('is true for an entitlement still running', () => {
    expect(isPlus('2026-08-30T12:00:00.000Z', now)).toBe(true);
  });

  it('is false at the exact instant of expiry', () => {
    expect(isPlus(now, now)).toBe(false);
  });
});

describe('coveredByWatermark — the read boundary', () => {
  const upTo = '2026-07-31T12:00:00.000Z';

  it('marks a notification stamped EXACTLY at the watermark', () => {
    // Exclusive would leave the newest row unread every time, because that is
    // precisely the timestamp the client sends back.
    expect(coveredByWatermark(upTo, upTo)).toBe(true);
  });

  it('marks everything older', () => {
    expect(coveredByWatermark('2026-07-31T11:59:59.999Z', upTo)).toBe(true);
  });

  it('leaves anything newer unread', () => {
    expect(coveredByWatermark('2026-07-31T12:00:00.001Z', upTo)).toBe(false);
  });
});

describe('validateFriendIds — the reconcile input guard', () => {
  it('accepts a list at the cap', () => {
    const ids = Array.from({ length: RECONCILE_MAX_IDS }, (_, i) => i + 1);
    const r = validateFriendIds(ids);
    expect(r.ok).toBe(true);
  });

  it('refuses 501 ids — the app chunks, the server does not stretch', () => {
    const ids = Array.from({ length: RECONCILE_MAX_IDS + 1 }, (_, i) => i + 1);
    const r = validateFriendIds(ids);
    expect(r).toEqual({ ok: false, reason: 'too_many' });
  });

  it('refuses non-integers, including numeric strings and floats', () => {
    expect(validateFriendIds(['12137674'])).toEqual({ ok: false, reason: 'not_an_integer' });
    expect(validateFriendIds([1.5])).toEqual({ ok: false, reason: 'not_an_integer' });
    expect(validateFriendIds([Number.NaN])).toEqual({ ok: false, reason: 'not_an_integer' });
  });

  it('refuses negatives and zero', () => {
    expect(validateFriendIds([-1])).toEqual({ ok: false, reason: 'not_an_integer' });
    expect(validateFriendIds([0])).toEqual({ ok: false, reason: 'not_an_integer' });
  });

  it('refuses anything that is not an array', () => {
    expect(validateFriendIds(undefined)).toEqual({ ok: false, reason: 'not_an_array' });
    expect(validateFriendIds({ 0: 1 })).toEqual({ ok: false, reason: 'not_an_array' });
  });

  it('dedupes, because an export repeats ids', () => {
    const r = validateFriendIds([12137674, 12137674, 9912]);
    expect(r.ok && r.ids).toEqual([12137674, 9912]);
  });

  it('accepts an empty list', () => {
    const r = validateFriendIds([]);
    expect(r.ok && r.ids).toEqual([]);
  });
});

describe('chunk', () => {
  it('slices at the boundary', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns one chunk when the input fits', () => {
    expect(chunk([1, 2], 500)).toEqual([[1, 2]]);
  });

  it('returns nothing for nothing', () => {
    expect(chunk([], 500)).toEqual([]);
  });
});
