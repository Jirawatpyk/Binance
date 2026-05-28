import { describe, it, expect } from 'vitest';
import { isLanguageAssignable } from '../../src/assignment/eligibility.js';
import type { TargetLanguage } from '../../src/types/index.js';

function row(partial: Partial<TargetLanguage>): TargetLanguage {
  return { code: 'lo-LA', status: 'WAITING_TRANSLATION', translator: null, reviewer: null, rowIndex: 0, ...partial };
}

describe('isLanguageAssignable', () => {
  it('assignable when waiting for translation and unassigned', () => {
    expect(isLanguageAssignable(row({ status: 'WAITING_TRANSLATION', translator: null }))).toBe(true);
  });

  it('NOT assignable when a translator is already set', () => {
    expect(isLanguageAssignable(row({ status: 'WAITING_TRANSLATION', translator: 'a@eqho.com' }))).toBe(false);
  });

  it('NOT assignable for WAITING_REVIEW (must not over-match "WAITING")', () => {
    expect(isLanguageAssignable(row({ status: 'WAITING_REVIEW', translator: null }))).toBe(false);
  });

  it('NOT assignable for other workflow statuses', () => {
    for (const status of ['IN_PROGRESS', 'TRANSLATING', 'REVIEWING', 'PUBLISHED', 'UNKNOWN']) {
      expect(isLanguageAssignable(row({ status, translator: null }))).toBe(false);
    }
  });
});
