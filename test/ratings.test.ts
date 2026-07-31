import { describe, expect, it } from 'vitest';
import { aggregateDelta, EMOTIONS, MAX_TARGETS, parseTargets, validateVote } from '@/pure';

/**
 * docs/IMPLEMENTATION.md Step 2, "Unit tests". The delta table is the contract
 * between a vote and every percentage anybody ever sees; it gets a row-for-row
 * test, plus the two cases the table leaves implicit.
 */

describe('aggregateDelta — the six rows of the table', () => {
  it('new vote with a score: +1 vote, +score, no emotion to move', () => {
    expect(aggregateDelta(null, { score: 9, emotion: null })).toEqual({
      dVotes: 1,
      dScore: 9,
      emotionFrom: null,
      emotionTo: null,
    });
  });

  it('new vote with a score and an emotion', () => {
    expect(aggregateDelta(null, { score: 9, emotion: 'touched' })).toEqual({
      dVotes: 1,
      dScore: 9,
      emotionFrom: null,
      emotionTo: 'touched',
    });
  });

  it('new vote, emotion only: still counts as a person', () => {
    expect(aggregateDelta(null, { score: null, emotion: 'touched' })).toEqual({
      dVotes: 1,
      dScore: 0,
      emotionFrom: null,
      emotionTo: 'touched',
    });
  });

  it('changed score 7 → 9: no new person, +2', () => {
    const d = aggregateDelta({ score: 7, emotion: 'touched' }, { score: 9, emotion: 'touched' });
    expect(d).toEqual({ dVotes: 0, dScore: 2, emotionFrom: 'touched', emotionTo: 'touched' });
    // from === to, so the caller skips the emotion clause entirely.
    expect(d.emotionFrom).toBe(d.emotionTo);
  });

  it('score added to an emotion-only vote', () => {
    expect(aggregateDelta({ score: null, emotion: 'sad' }, { score: 8, emotion: 'sad' })).toEqual({
      dVotes: 0,
      dScore: 8,
      emotionFrom: 'sad',
      emotionTo: 'sad',
    });
  });

  it('score removed: -prev.score, person stays counted', () => {
    expect(aggregateDelta({ score: 8, emotion: 'sad' }, { score: null, emotion: 'sad' })).toEqual({
      dVotes: 0,
      dScore: -8,
      emotionFrom: 'sad',
      emotionTo: 'sad',
    });
  });

  it('emotion changed only', () => {
    expect(aggregateDelta({ score: 9, emotion: 'touched' }, { score: 9, emotion: 'frustrated' })).toEqual({
      dVotes: 0,
      dScore: 0,
      emotionFrom: 'touched',
      emotionTo: 'frustrated',
    });
  });
});

describe('aggregateDelta — the cases the table leaves implicit', () => {
  it('emotion-only → score-only clears the emotion (decrement, no increment)', () => {
    const d = aggregateDelta({ score: null, emotion: 'touched' }, { score: 7, emotion: null });
    expect(d).toEqual({ dVotes: 0, dScore: 7, emotionFrom: 'touched', emotionTo: null });
    expect(d.emotionFrom).not.toBe(d.emotionTo); // the clause runs, half of it
  });

  it('an identical re-vote moves nothing at all', () => {
    const d = aggregateDelta({ score: 7, emotion: 'amused' }, { score: 7, emotion: 'amused' });
    expect(d).toEqual({ dVotes: 0, dScore: 0, emotionFrom: 'amused', emotionTo: 'amused' });
  });
});

describe('validateVote', () => {
  it('accepts a score with an emotion', () => {
    const r = validateVote({ score: 9, emotion: 'touched', season: 1, episode: 3 });
    expect(r).toEqual({ ok: true, vote: { score: 9, emotion: 'touched', season: 1, episode: 3 } });
  });

  it('accepts a show-level vote with no season or episode', () => {
    const r = validateVote({ score: 10 });
    expect(r.ok && r.vote).toEqual({ score: 10, emotion: null, season: null, episode: null });
  });

  it('rejects score 0 and score 11 before any SQL is prepared', () => {
    expect(validateVote({ score: 0, emotion: 'touched' })).toEqual({ ok: false, reason: 'score_invalid' });
    expect(validateVote({ score: 11 })).toEqual({ ok: false, reason: 'score_invalid' });
  });

  it('rejects a non-integer score', () => {
    expect(validateVote({ score: 8.5 })).toEqual({ ok: false, reason: 'score_invalid' });
    expect(validateVote({ score: '9' })).toEqual({ ok: false, reason: 'score_invalid' });
  });

  it('rejects an emotion outside the allow-list — it becomes a JSON path', () => {
    expect(validateVote({ emotion: 'shock' })).toEqual({ ok: false, reason: 'emotion_invalid' });
    expect(validateVote({ emotion: "love'] , '$.x" })).toEqual({ ok: false, reason: 'emotion_invalid' });
  });

  it('accepts every emotion on the list', () => {
    for (const e of EMOTIONS) expect(validateVote({ emotion: e }).ok).toBe(true);
  });

  it('rejects a vote that says nothing', () => {
    expect(validateVote({})).toEqual({ ok: false, reason: 'empty_vote' });
    expect(validateVote({ score: null, emotion: null })).toEqual({ ok: false, reason: 'empty_vote' });
  });

  it('rejects negative or fractional season and episode', () => {
    expect(validateVote({ score: 5, season: -1 })).toEqual({ ok: false, reason: 'season_invalid' });
    expect(validateVote({ score: 5, season: 1, episode: 1.5 })).toEqual({
      ok: false,
      reason: 'episode_invalid',
    });
  });

  it('rejects an episode with no season', () => {
    expect(validateVote({ score: 5, episode: 3 })).toEqual({
      ok: false,
      reason: 'episode_without_season',
    });
  });

  it('allows season 0 — specials are a season', () => {
    expect(validateVote({ score: 5, season: 0, episode: 0 }).ok).toBe(true);
  });
});

describe('parseTargets', () => {
  it('parses a single show target', () => {
    expect(parseTargets(['tvdb:121361'])).toEqual([
      { source: 'tvdb', key: '121361', season: -1, episode: -1 },
    ]);
  });

  it('parses season and episode', () => {
    expect(parseTargets(['tvdb:121361:1:3'])).toEqual([
      { source: 'tvdb', key: '121361', season: 1, episode: 3 },
    ]);
  });

  it('keeps the literal | in a title key', () => {
    expect(parseTargets(['title:amado|2011'])).toEqual([
      { source: 'title', key: 'amado|2011', season: -1, episode: -1 },
    ]);
  });

  it('does not mistake a year for a season: title:1917|2019 has no colon after the source', () => {
    // The ambiguity the parsing rule exists for. The key ends in digits, but
    // season/episode are only split off when there are ≥2 colons in the
    // remainder AND both trailing segments are digits. Here there are none.
    expect(parseTargets(['title:1917|2019'])).toEqual([
      { source: 'title', key: '1917|2019', season: -1, episode: -1 },
    ]);
  });

  it('splits a title target that does carry a season and episode', () => {
    expect(parseTargets(['title:1917|2019:2:5'])).toEqual([
      { source: 'title', key: '1917|2019', season: 2, episode: 5 },
    ]);
  });

  it('parses a mixed list', () => {
    expect(parseTargets(['title:amado|2011', 'tvdb:121361', 'tmdb:603:1:1'])).toEqual([
      { source: 'title', key: 'amado|2011', season: -1, episode: -1 },
      { source: 'tvdb', key: '121361', season: -1, episode: -1 },
      { source: 'tmdb', key: '603', season: 1, episode: 1 },
    ]);
  });

  it('caps at 100', () => {
    const hundred = Array.from({ length: MAX_TARGETS }, (_, i) => `tvdb:${i}`);
    expect(parseTargets(hundred)).toHaveLength(MAX_TARGETS);
    expect(parseTargets([...hundred, 'tvdb:101'])).toBeNull();
  });

  it('rejects an empty list', () => {
    expect(parseTargets([])).toBeNull();
  });

  it('rejects malformed members — one bad target poisons the call', () => {
    expect(parseTargets(['121361'])).toBeNull(); // no source
    expect(parseTargets([':121361'])).toBeNull(); // empty source
    expect(parseTargets(['tvdb:'])).toBeNull(); // empty key
    expect(parseTargets(['imdb:tt123'])).toBeNull(); // unknown source
    expect(parseTargets(['tvdb:121361:1'])).toBeNull(); // half a pair
    expect(parseTargets(['tvdb:121361:one:two'])).toBeNull(); // not digits
    expect(parseTargets(['tvdb:121361', 'nonsense'])).toBeNull(); // one bad member
  });
});
