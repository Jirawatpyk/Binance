import { describe, it, expect } from 'vitest';
import { AssignmentEngine } from '../../src/assignment/engine.js';
import type { TranslatorsConfig } from '../../src/types/index.js';

const config: TranslatorsConfig = {
  'lo-LA': {
    rules: [
      { maxWords: 500, translators: ['LO_T1@eqho.com'] },
      { maxWords: 2000, translators: ['LO_T3@eqho.com'] },
      { maxWords: null, translators: ['LO_T3@eqho.com', 'LO_T4@eqho.com'] },
    ],
  },
  'km-KH': {
    rules: [
      { maxWords: 500, translators: ['KM_T1@eqho.com'] },
      { maxWords: null, translators: ['KM_T1@eqho.com', 'KM_T2@eqho.com'] },
    ],
  },
};

function makeEngine(rrCounters: Record<string, number> = {}) {
  return new AssignmentEngine(config, {
    getRRIndex: (k) => rrCounters[k] ?? 0,
  });
}

describe('AssignmentEngine.pick', () => {
  it('picks first-tier translator for low word count', () => {
    const r = makeEngine().pick('lo-LA', 100);
    expect(r.translator).toBe('LO_T1@eqho.com');
    expect(r.ruleIndex).toBe(0);
    expect(r.useRoundRobin).toBe(false);
  });

  it('picks second-tier at the upper boundary (inclusive)', () => {
    const r = makeEngine().pick('lo-LA', 500);
    expect(r.translator).toBe('LO_T1@eqho.com');
  });

  it('picks middle-tier when word count fits middle rule', () => {
    const r = makeEngine().pick('lo-LA', 1500);
    expect(r.translator).toBe('LO_T3@eqho.com');
    expect(r.ruleIndex).toBe(1);
  });

  it('uses round-robin for tier with multiple translators (idx 0)', () => {
    const r = makeEngine({ 'lo-LA:rule2': 0 }).pick('lo-LA', 5000);
    expect(r.translator).toBe('LO_T3@eqho.com');
    expect(r.useRoundRobin).toBe(true);
    expect(r.rrKey).toBe('lo-LA:rule2');
  });

  it('uses round-robin for tier with multiple translators (idx 1)', () => {
    const r = makeEngine({ 'lo-LA:rule2': 1 }).pick('lo-LA', 5000);
    expect(r.translator).toBe('LO_T4@eqho.com');
  });

  it('round-robin wraps using modulo', () => {
    const r = makeEngine({ 'lo-LA:rule2': 3 }).pick('lo-LA', 5000);
    expect(r.translator).toBe('LO_T4@eqho.com'); // 3 % 2 = 1
  });

  it('handles km-KH separately', () => {
    const r = makeEngine().pick('km-KH', 300);
    expect(r.translator).toBe('KM_T1@eqho.com');
  });

  it('throws if language has no config', () => {
    const engine = new AssignmentEngine({}, { getRRIndex: () => 0 });
    expect(() => engine.pick('lo-LA', 100)).toThrow();
  });

  it('picks the middle tier just above the lower boundary (501)', () => {
    const r = makeEngine().pick('lo-LA', 501);
    expect(r.translator).toBe('LO_T3@eqho.com'); // 501 > 500 → tier 2 (maxWords: 2000)
    expect(r.ruleIndex).toBe(1);
  });
});
