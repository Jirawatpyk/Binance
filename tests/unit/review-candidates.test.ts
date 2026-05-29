import { describe, it, expect } from 'vitest';
import { selectReviewCandidates } from '../../src/scraper/review-candidates.js';
import type { Job } from '../../src/types/index.js';

// Translation-window cutoff used across these tests. A job created BEFORE this is
// "aged" (review-only); created AT/AFTER it is "fresh" — translatable even if the
// translation scan missed it this tick.
const CUTOFF = Date.parse('2026-05-29T00:00:00Z');

// Default createdMs is 1h BEFORE the cutoff → aged → reviewOnly true.
function job(id: string, createdMs: number | null = CUTOFF - 3_600_000): Job {
  return {
    id,
    name: `Job ${id}`,
    dueDate: new Date('2026-05-28T00:00:00Z'),
    project: 'p',
    languageCount: 1,
    languagesNeeded: ['lo-LA'],
    wordCount: 100,
    detailUrl: `https://www.translationtms.com/job/${id}`,
    createdMs,
  };
}

const never = (): boolean => false;

describe('selectReviewCandidates', () => {
  it('tags an aged survivor (created before the translation window) reviewOnly', () => {
    const out = selectReviewCandidates([job('100')], new Set(), never, CUTOFF);
    expect(out).toHaveLength(1);
    expect(out[0].reviewOnly).toBe(true);
  });

  it('tags a fresh survivor (created within the translation window) reviewOnly=false so it can still be translated', () => {
    const out = selectReviewCandidates([job('100', CUTOFF + 3_600_000)], new Set(), never, CUTOFF);
    expect(out[0].reviewOnly).toBe(false);
  });

  it('treats a job created exactly at the cutoff as fresh (matches the >= translation guard)', () => {
    const out = selectReviewCandidates([job('100', CUTOFF)], new Set(), never, CUTOFF);
    expect(out[0].reviewOnly).toBe(false);
  });

  it('tags a job with an unparseable created date reviewOnly (conservative — review only)', () => {
    const out = selectReviewCandidates([job('100', null)], new Set(), never, CUTOFF);
    expect(out[0].reviewOnly).toBe(true);
  });

  it('drops jobs already in the translation set (no double-surfacing)', () => {
    const out = selectReviewCandidates([job('100'), job('101')], new Set(['100']), never, CUTOFF);
    expect(out.map((j) => j.id)).toEqual(['101']);
  });

  it('dedups repeated ids across the scraped list', () => {
    const out = selectReviewCandidates([job('100'), job('100')], new Set(), never, CUTOFF);
    expect(out.map((j) => j.id)).toEqual(['100']);
  });

  it('drops jobs the skip predicate rejects (ABANDONED / cooling down)', () => {
    const out = selectReviewCandidates([job('100'), job('101')], new Set(), (id) => id === '101', CUTOFF);
    expect(out.map((j) => j.id)).toEqual(['100']);
  });

  it('returns newest first (descending id) regardless of scan order — recently-translated jobs win the cap', () => {
    const out = selectReviewCandidates([job('100'), job('300'), job('200')], new Set(), never, CUTOFF);
    expect(out.map((j) => j.id)).toEqual(['300', '200', '100']);
  });

  it('does not mutate the input jobs (reviewOnly only on the returned copies)', () => {
    const input = [job('100')];
    selectReviewCandidates(input, new Set(), never, CUTOFF);
    expect(input[0].reviewOnly).toBeUndefined();
  });
});
