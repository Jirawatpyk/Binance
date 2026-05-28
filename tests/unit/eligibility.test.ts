import { describe, it, expect } from 'vitest';
import { isLanguageAssignable, pendingRole } from '../../src/assignment/eligibility.js';
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

describe('pendingRole', () => {
  const reviewers = { 'lo-LA': 'LO_T2@eqho.com' };

  it('translator when WAITING_TRANSLATION and no translator', () => {
    expect(pendingRole(row({ status: 'WAITING_TRANSLATION', translator: null }), reviewers)).toBe('translator');
  });

  it('reviewer when WAITING_REVIEW, no reviewer, and a reviewer is configured', () => {
    expect(pendingRole(row({ status: 'WAITING_REVIEW', translator: 'a@eqho.com', reviewer: null }), reviewers)).toBe('reviewer');
  });

  it('null for WAITING_REVIEW when no reviewer configured for the language', () => {
    expect(pendingRole(row({ code: 'km-KH', status: 'WAITING_REVIEW', reviewer: null }), reviewers)).toBeNull();
  });

  it('null for WAITING_REVIEW when a reviewer is already set', () => {
    expect(pendingRole(row({ status: 'WAITING_REVIEW', reviewer: 'b@eqho.com' }), reviewers)).toBeNull();
  });

  it('null when reviewers config is undefined (feature off)', () => {
    expect(pendingRole(row({ status: 'WAITING_REVIEW', reviewer: null }), undefined)).toBeNull();
  });

  it('null for unrelated statuses', () => {
    expect(pendingRole(row({ status: 'REVIEWING', translator: 'a@eqho.com', reviewer: null }), reviewers)).toBeNull();
  });
});
