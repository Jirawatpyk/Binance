import { describe, it, expect } from 'vitest';
import { localDateString, isNewDay, isDailySummaryDue } from '../../src/core/health-utils.js';

describe('localDateString', () => {
  it('formats local date as YYYY-MM-DD', () => {
    expect(localDateString(new Date(2026, 4, 7, 13, 5))).toBe('2026-05-07');
  });
});

describe('isNewDay', () => {
  it('true when calendar day differs', () => {
    expect(isNewDay(new Date(2026, 4, 8, 0, 1), '2026-05-07')).toBe(true);
  });
  it('false when same day', () => {
    expect(isNewDay(new Date(2026, 4, 7, 23, 59), '2026-05-07')).toBe(false);
  });
});

describe('isDailySummaryDue', () => {
  it('due when now past time and not sent today', () => {
    expect(isDailySummaryDue(new Date(2026, 4, 7, 9, 30), '09:00', null)).toBe(true);
  });
  it('not due before the time', () => {
    expect(isDailySummaryDue(new Date(2026, 4, 7, 8, 59), '09:00', null)).toBe(false);
  });
  it('not due when already sent today', () => {
    expect(isDailySummaryDue(new Date(2026, 4, 7, 10, 0), '09:00', '2026-05-07')).toBe(false);
  });
  it('due again the next day after past sent date', () => {
    expect(isDailySummaryDue(new Date(2026, 4, 8, 9, 1), '09:00', '2026-05-07')).toBe(true);
  });
});
