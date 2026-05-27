import { describe, it, expect } from 'vitest';
import { parseCreatedUtc, formatBoardDate } from '../../src/scraper/date-utils.js';

describe('parseCreatedUtc', () => {
  it('parses YYYY-MM-DD HH:mm as UTC', () => {
    expect(parseCreatedUtc('2026-05-27 10:52')).toBe(Date.UTC(2026, 4, 27, 10, 52, 0));
  });
  it('parses YYYY-MM-DD HH:mm:ss as UTC', () => {
    expect(parseCreatedUtc('2026-05-27 10:52:30')).toBe(Date.UTC(2026, 4, 27, 10, 52, 30));
  });
  it('returns null for empty', () => {
    expect(parseCreatedUtc('')).toBeNull();
    expect(parseCreatedUtc('   ')).toBeNull();
  });
  it('returns null for garbage', () => {
    expect(parseCreatedUtc('not a date')).toBeNull();
  });
});

describe('formatBoardDate', () => {
  it('formats as YYYY-MM-DD HH:mm:ss in UTC', () => {
    const d = new Date(Date.UTC(2026, 4, 27, 3, 7, 9));
    expect(formatBoardDate(d)).toBe('2026-05-27 03:07:09');
  });
});
