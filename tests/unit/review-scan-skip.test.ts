import { describe, it, expect } from 'vitest';
import { isReviewScanSkippable } from '../../src/scraper/review-scan-skip.js';
import type { ProcessedJobEntry } from '../../src/types/index.js';

const now = Date.parse('2026-05-28T12:00:00.000Z');

function entry(p: Partial<ProcessedJobEntry>): ProcessedJobEntry {
  return { processedAt: '2026-05-27T00:00:00.000Z', status: 'FULL', assigned: {}, ...p };
}

describe('isReviewScanSkippable', () => {
  it('does not skip when there is no entry (never processed)', () => {
    expect(isReviewScanSkippable(undefined, now)).toBe(false);
  });

  it('does not skip a FULL job with no recheckAfter (translated, awaiting review)', () => {
    expect(isReviewScanSkippable(entry({ status: 'FULL' }), now)).toBe(false);
  });

  it('skips an ABANDONED job', () => {
    expect(isReviewScanSkippable(entry({ status: 'ABANDONED' }), now)).toBe(true);
  });

  it('skips a job still inside its cooldown window', () => {
    expect(isReviewScanSkippable(entry({ recheckAfter: '2026-05-28T13:00:00.000Z' }), now)).toBe(true);
  });

  it('does not skip once the cooldown window has passed', () => {
    expect(isReviewScanSkippable(entry({ recheckAfter: '2026-05-28T11:00:00.000Z' }), now)).toBe(false);
  });

  it('does not skip when recheckAfter is unparseable (fail-open toward doing work)', () => {
    expect(isReviewScanSkippable(entry({ recheckAfter: 'not-a-date' }), now)).toBe(false);
  });

  it('does not skip a PARTIAL job with no recheckAfter (re-checked live next tick)', () => {
    expect(isReviewScanSkippable(entry({ status: 'PARTIAL' }), now)).toBe(false);
  });

  it('skips an ABANDONED job even with a future recheckAfter (ABANDONED takes precedence)', () => {
    expect(
      isReviewScanSkippable(entry({ status: 'ABANDONED', recheckAfter: '2026-05-28T13:00:00.000Z' }), now)
    ).toBe(true);
  });
});
