import { describe, it, expect } from 'vitest';
import { selectReviewCandidates } from '../../src/scraper/review-candidates.js';
import type { Job } from '../../src/types/index.js';

function job(id: string): Job {
  return {
    id,
    name: `Job ${id}`,
    dueDate: new Date('2026-05-28T00:00:00Z'),
    project: 'p',
    languageCount: 1,
    languagesNeeded: ['lo-LA'],
    wordCount: 100,
    detailUrl: `https://www.translationtms.com/job/${id}`,
  };
}

const never = (): boolean => false;

describe('selectReviewCandidates', () => {
  it('tags survivors reviewOnly', () => {
    const out = selectReviewCandidates([job('100')], new Set(), never);
    expect(out).toHaveLength(1);
    expect(out[0].reviewOnly).toBe(true);
  });

  it('drops jobs already in the translation set (no double-surfacing)', () => {
    const out = selectReviewCandidates([job('100'), job('101')], new Set(['100']), never);
    expect(out.map((j) => j.id)).toEqual(['101']);
  });

  it('dedups repeated ids across the scraped list', () => {
    const out = selectReviewCandidates([job('100'), job('100')], new Set(), never);
    expect(out.map((j) => j.id)).toEqual(['100']);
  });

  it('drops jobs the skip predicate rejects (ABANDONED / cooling down)', () => {
    const out = selectReviewCandidates([job('100'), job('101')], new Set(), (id) => id === '101');
    expect(out.map((j) => j.id)).toEqual(['100']);
  });

  it('returns newest first (descending id) regardless of scan order — recently-translated jobs win the cap', () => {
    const out = selectReviewCandidates([job('100'), job('300'), job('200')], new Set(), never);
    expect(out.map((j) => j.id)).toEqual(['300', '200', '100']);
  });

  it('does not mutate the input jobs (reviewOnly only on the returned copies)', () => {
    const input = [job('100')];
    selectReviewCandidates(input, new Set(), never);
    expect(input[0].reviewOnly).toBeUndefined();
  });
});
