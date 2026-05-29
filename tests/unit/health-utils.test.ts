import { describe, it, expect } from 'vitest';
import { localDateString, isNewDay, isDailySummaryDue, summaryGapDays } from '../../src/core/health-utils.js';

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
  it('is due at exactly the summary time (>= boundary)', () => {
    expect(isDailySummaryDue(new Date(2026, 4, 7, 9, 0), '09:00', null)).toBe(true);
  });
  it('summaryTime 00:00 is due at midnight', () => {
    expect(isDailySummaryDue(new Date(2026, 4, 7, 0, 0), '00:00', null)).toBe(true);
  });
  it('not due before the window when yesterday was already sent', () => {
    // sent yesterday, now early today before the window — just wait for it
    expect(isDailySummaryDue(new Date(2026, 4, 8, 8, 0), '09:00', '2026-05-07')).toBe(false);
  });
  it('catches up before the window if a full prior day was missed', () => {
    // last sent two days ago (bot was down across yesterday's window) — fire now
    expect(isDailySummaryDue(new Date(2026, 4, 9, 8, 0), '09:00', '2026-05-07')).toBe(true);
  });
});

describe('summaryGapDays', () => {
  it('is 0 when never sent', () => {
    expect(summaryGapDays(null, new Date(2026, 4, 11, 9, 0))).toBe(0);
  });
  it('is 1 for a normal next-day summary (no gap)', () => {
    expect(summaryGapDays('2026-05-10', new Date(2026, 4, 11, 9, 0))).toBe(1);
  });
  it('counts the days skipped across a multi-day outage', () => {
    expect(summaryGapDays('2026-05-07', new Date(2026, 4, 11, 9, 0))).toBe(4);
  });
});
