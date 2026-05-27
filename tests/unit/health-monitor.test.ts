import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { HealthMonitor } from '../../src/core/health-monitor.js';

function newMonitor(now: Date) {
  const dir = mkdtempSync(path.join(tmpdir(), 'health-'));
  const file = path.join(dir, 'health.json');
  return { monitor: new HealthMonitor(file, now), file };
}

describe('HealthMonitor', () => {
  it('counts assignments and failures for today', async () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    await monitor.load();
    monitor.recordAssignment(true);
    monitor.recordAssignment(true);
    monitor.recordAssignment(false);
    expect(monitor.snapshot().today.assigned).toBe(2);
    expect(monitor.snapshot().today.failed).toBe(1);
  });

  it('resets consecutiveErrors on success and increments on error', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    monitor.recordTickError();
    monitor.recordTickError();
    expect(monitor.snapshot().consecutiveErrors).toBe(2);
    monitor.recordTickSuccess();
    expect(monitor.snapshot().consecutiveErrors).toBe(0);
  });

  it('shouldAlertErrorRate fires exactly when reaching threshold', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    monitor.recordTickError();
    expect(monitor.shouldAlertErrorRate(3)).toBe(false);
    monitor.recordTickError();
    expect(monitor.shouldAlertErrorRate(3)).toBe(false);
    monitor.recordTickError();
    expect(monitor.shouldAlertErrorRate(3)).toBe(true);
    monitor.recordTickError();
    expect(monitor.shouldAlertErrorRate(3)).toBe(false);
  });

  it('rolls over counters on a new day', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    monitor.recordAssignment(true);
    monitor.recordTickStart(new Date(2026, 4, 8, 0, 5));
    expect(monitor.snapshot().today.assigned).toBe(0);
    expect(monitor.snapshot().today.date).toBe('2026-05-08');
  });

  it('persists and reloads', async () => {
    const { monitor, file } = newMonitor(new Date(2026, 4, 7, 8, 0));
    await monitor.load();
    monitor.recordAssignment(true);
    monitor.markDailySummarySent(new Date(2026, 4, 7, 9, 0));
    await monitor.save();

    const m2 = new HealthMonitor(file, new Date(2026, 4, 7, 10, 0));
    await m2.load();
    expect(m2.snapshot().today.assigned).toBe(1);
    expect(m2.isDailySummaryDue(new Date(2026, 4, 7, 10, 0), '09:00')).toBe(false);
  });

  it('buildDailySummary includes counts', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    monitor.recordAssignment(true);
    monitor.recordAuthEpisode();
    const text = monitor.buildDailySummary(new Date(2026, 4, 7, 9, 0));
    expect(text).toMatch(/assigned/i);
    expect(text).toContain('1');
  });
});
