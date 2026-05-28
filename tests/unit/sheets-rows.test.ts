import { describe, it, expect } from 'vitest';
import { buildSheetRows, formatDueCell, type TabMap } from '../../src/integrations/sheets-rows.js';
import type { AssignmentSummaryItem } from '../../src/notifications/google-chat.js';

const tabs: TabMap = { 'lo-LA': 'Lao Assign', 'km-KH': 'Khmer Assign' };

function noExisting(): Record<string, Set<string>> {
  return { 'Lao Assign': new Set(), 'Khmer Assign': new Set() };
}

describe('formatDueCell', () => {
  it('formats a valid date as YYYY-MM-DD HH:mm UTC', () => {
    expect(formatDueCell(new Date('2026-05-30T14:05:00Z'))).toBe('2026-05-30 14:05 UTC');
  });
  it('returns empty string for null/invalid', () => {
    expect(formatDueCell(null)).toBe('');
    expect(formatDueCell(undefined)).toBe('');
    expect(formatDueCell(new Date('nope'))).toBe('');
  });
  it('zero-pads single-digit month/day/hour/minute', () => {
    expect(formatDueCell(new Date('2026-01-09T03:07:00Z'))).toBe('2026-01-09 03:07 UTC');
  });
});

describe('buildSheetRows', () => {
  it('routes lo-LA to the Lao tab and km-KH to the Khmer tab', () => {
    const items: AssignmentSummaryItem[] = [
      {
        jobId: '100',
        name: 'Job A',
        wordCount: 250,
        assigned: { 'lo-LA': 'LO_T1@eqho.com', 'km-KH': 'kh_t1@eqho.com' },
        dueDate: new Date('2026-05-30T14:05:00Z'),
      },
    ];
    const rows = buildSheetRows(items, noExisting(), tabs);
    expect(rows['Lao Assign']).toEqual([['100', 'Job A', '2026-05-30 14:05 UTC', '250', 'LO_T1@eqho.com']]);
    expect(rows['Khmer Assign']).toEqual([['100', 'Job A', '2026-05-30 14:05 UTC', '250', 'kh_t1@eqho.com']]);
  });

  it('skips a Job ID already present in that tab (dedup)', () => {
    const items: AssignmentSummaryItem[] = [
      { jobId: '200', name: 'Dup', wordCount: 10, assigned: { 'lo-LA': 'LO_T1@eqho.com' } },
    ];
    const existing = { 'Lao Assign': new Set(['200']), 'Khmer Assign': new Set<string>() };
    const rows = buildSheetRows(items, existing, tabs);
    expect(rows['Lao Assign'] ?? []).toEqual([]);
  });

  it('writes an empty Due cell when dueDate is missing', () => {
    const items: AssignmentSummaryItem[] = [
      { jobId: '300', name: 'No due', wordCount: 5, assigned: { 'km-KH': 'kh_t2@eqho.com' } },
    ];
    const rows = buildSheetRows(items, noExisting(), tabs);
    expect(rows['Khmer Assign']).toEqual([['300', 'No due', '', '5', 'kh_t2@eqho.com']]);
  });

  it('dedups the same Job ID appearing twice within one batch', () => {
    const items: AssignmentSummaryItem[] = [
      { jobId: '500', name: 'First', wordCount: 1, assigned: { 'lo-LA': 'LO_T1@eqho.com' } },
      { jobId: '500', name: 'Again', wordCount: 9, assigned: { 'lo-LA': 'LO_T1@eqho.com' } },
    ];
    const rows = buildSheetRows(items, noExisting(), tabs);
    expect(rows['Lao Assign']).toHaveLength(1);
    expect(rows['Lao Assign']?.[0][0]).toBe('500');
  });

  it('skips an assigned language that has no tab mapping', () => {
    const items: AssignmentSummaryItem[] = [
      { jobId: '600', name: 'Unmapped', wordCount: 1, assigned: { 'xx-YY': 'z@eqho.com' } as Record<string, string> },
    ];
    expect(buildSheetRows(items, noExisting(), tabs)).toEqual({});
  });

  it('still emits the mapped language when one item mixes mapped + unmapped languages', () => {
    // Guards against a `break`-instead-of-`continue` regression on the unmapped skip.
    const items: AssignmentSummaryItem[] = [
      { jobId: '700', name: 'Mixed', wordCount: 3, assigned: { 'xx-YY': 'z@eqho.com', 'lo-LA': 'LO_T1@eqho.com' } as Record<string, string> },
    ];
    const rows = buildSheetRows(items, noExisting(), tabs);
    expect(rows['Lao Assign']).toEqual([['700', 'Mixed', '', '3', 'LO_T1@eqho.com']]);
    expect(rows['Khmer Assign']).toBeUndefined();
  });

  it('returns an empty object for no items', () => {
    expect(buildSheetRows([], noExisting(), tabs)).toEqual({});
  });
});
