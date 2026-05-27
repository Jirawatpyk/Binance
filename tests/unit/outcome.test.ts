import { describe, it, expect } from 'vitest';
import { classifyOutcome } from '../../src/assignment/outcome.js';

describe('classifyOutcome', () => {
  it('PROCESSED when everything attempted was assigned', () => {
    expect(classifyOutcome({ assignedCount: 2, failedCount: 0, targetLanguageCount: 2 })).toBe('PROCESSED');
    expect(classifyOutcome({ assignedCount: 1, failedCount: 0, targetLanguageCount: 1 })).toBe('PROCESSED');
  });

  it('PARTIAL when some assigned and some failed', () => {
    expect(classifyOutcome({ assignedCount: 1, failedCount: 1, targetLanguageCount: 2 })).toBe('PARTIAL');
  });

  it('ALL_FAILED when nothing assigned but rows were attempted and failed', () => {
    expect(classifyOutcome({ assignedCount: 0, failedCount: 2, targetLanguageCount: 2 })).toBe('ALL_FAILED');
  });

  it('EMPTY_PARSE when no target-language rows were parsed at all', () => {
    expect(classifyOutcome({ assignedCount: 0, failedCount: 0, targetLanguageCount: 0 })).toBe('EMPTY_PARSE');
  });

  it('COOLDOWN_FULL when rows exist but none assignable and the job is not already PARTIAL', () => {
    expect(classifyOutcome({ assignedCount: 0, failedCount: 0, targetLanguageCount: 2 })).toBe('COOLDOWN_FULL');
    expect(
      classifyOutcome({ assignedCount: 0, failedCount: 0, targetLanguageCount: 1, prevStatus: 'FULL' })
    ).toBe('COOLDOWN_FULL');
  });

  it('COOLDOWN_PARTIAL preserves a PARTIAL job (does not demote to FULL)', () => {
    expect(
      classifyOutcome({ assignedCount: 0, failedCount: 0, targetLanguageCount: 2, prevStatus: 'PARTIAL' })
    ).toBe('COOLDOWN_PARTIAL');
  });

  it('a productive assign on a previously-PARTIAL job still resolves to PROCESSED (cross-tick completion)', () => {
    expect(
      classifyOutcome({ assignedCount: 1, failedCount: 0, targetLanguageCount: 1, prevStatus: 'PARTIAL' })
    ).toBe('PROCESSED');
  });
});
