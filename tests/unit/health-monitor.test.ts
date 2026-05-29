import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
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

  it('counts jobs assigned separately from language assignments', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    // one job with 2 languages
    monitor.recordAssignment(true);
    monitor.recordAssignment(true);
    monitor.recordJobAssigned();
    expect(monitor.snapshot().today.assigned).toBe(2); // languages
    expect(monitor.snapshot().today.jobsAssigned).toBe(1); // jobs
  });

  it('counts reviewer assignments separately and surfaces them in the summary', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    monitor.recordAssignment(true); // a translation
    monitor.recordReview();
    monitor.recordReview();
    expect(monitor.snapshot().today.reviewed).toBe(2);
    expect(monitor.snapshot().today.assigned).toBe(1); // reviews don't inflate translations
    expect(monitor.dailySummaryStats(new Date(2026, 4, 7, 9, 0)).reviewed).toBe(2);
    // rollover resets the reviewed counter with the rest of today
    monitor.recordTickStart(new Date(2026, 4, 8, 0, 5));
    expect(monitor.snapshot().today.reviewed).toBe(0);
  });

  it('resets consecutiveErrors on success and increments on error', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    monitor.recordTickError();
    monitor.recordTickError();
    expect(monitor.snapshot().consecutiveErrors).toBe(2);
    monitor.recordTickSuccess();
    expect(monitor.snapshot().consecutiveErrors).toBe(0);
  });

  it('shouldAlertErrorRate fires once at threshold then suppresses until recovery', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    monitor.recordTickError(); // 1
    expect(monitor.shouldAlertErrorRate(3)).toBe(false);
    monitor.recordTickError(); // 2
    expect(monitor.shouldAlertErrorRate(3)).toBe(false);
    monitor.recordTickError(); // 3 — crosses threshold → fire once
    expect(monitor.shouldAlertErrorRate(3)).toBe(true);
    monitor.recordTickError(); // 4 — already alerted, no alert storm
    expect(monitor.shouldAlertErrorRate(3)).toBe(false);
    monitor.recordTickError(); // 5
    expect(monitor.shouldAlertErrorRate(3)).toBe(false);
    monitor.recordTickError(); // 6 — a multiple of 3, but must NOT re-fire (no alert storm)
    expect(monitor.shouldAlertErrorRate(3)).toBe(false);
    // A success ends the streak and re-arms the alert for the next one.
    monitor.recordTickSuccess();
    monitor.recordTickError();
    monitor.recordTickError();
    monitor.recordTickError();
    expect(monitor.shouldAlertErrorRate(3)).toBe(true);
  });

  it('does not re-alert after a restart while the error streak is unbroken', async () => {
    const { monitor, file } = newMonitor(new Date(2026, 4, 7, 8, 0));
    await monitor.load();
    monitor.recordTickError();
    monitor.recordTickError();
    monitor.recordTickError();
    expect(monitor.shouldAlertErrorRate(3)).toBe(true); // fires + records that it alerted
    await monitor.save();

    // A watchdog hard-exit / service restart reloads the persisted streak.
    const m2 = new HealthMonitor(file, new Date(2026, 4, 7, 8, 5));
    await m2.load();
    expect(m2.snapshot().consecutiveErrors).toBe(3);
    expect(m2.shouldAlertErrorRate(3)).toBe(false); // suppressed — already alerted before restart
  });

  it('rolls over counters on a new day', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    monitor.recordAssignment(true);
    monitor.recordTickStart(new Date(2026, 4, 8, 0, 5));
    expect(monitor.snapshot().today.assigned).toBe(0);
    expect(monitor.snapshot().today.date).toBe('2026-05-08');
  });

  it('rollover clears assigned, jobsAssigned, failed, and authEpisodes', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    monitor.recordAssignment(true);
    monitor.recordJobAssigned();
    monitor.recordAssignment(false);
    monitor.recordAuthEpisode();
    monitor.recordTickStart(new Date(2026, 4, 8, 0, 5));
    const t = monitor.snapshot().today;
    expect([t.assigned, t.jobsAssigned, t.failed, t.authEpisodes]).toEqual([0, 0, 0, 0]);
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

  it('dailySummaryStats returns counts, per-language, polls, uptime, last activity', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    monitor.recordTickStart(new Date(2026, 4, 7, 8, 0));
    monitor.recordPoll(); // 1 real board poll today
    monitor.recordAssignment(true, 'lo-LA', new Date(2026, 4, 7, 8, 30));
    monitor.recordAssignment(true, 'km-KH', new Date(2026, 4, 7, 8, 31));
    monitor.recordJobAssigned();
    monitor.recordAuthEpisode();
    const s = monitor.dailySummaryStats(new Date(2026, 4, 7, 9, 0));
    expect(s.date).toBe('2026-05-07');
    expect(s.assigned).toBe(2);
    expect(s.byLang).toEqual({ 'lo-LA': 1, 'km-KH': 1 });
    expect(s.jobsAssigned).toBe(1);
    expect(s.authEpisodes).toBe(1);
    expect(s.ticks).toBe(1);
    expect(s.uptimeHours).toBe(1); // 08:00 → 09:00
    expect(s.failed).toBe(0);
    expect(s.consecutiveErrors).toBe(0);
    expect(s.lastAssignmentAt).toBe(new Date(2026, 4, 7, 8, 31).toISOString());
  });

  it('dailySummaryStats reports the COMPLETED previous day after a rollover', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    // Monday's work
    monitor.recordAssignment(true, 'lo-LA', new Date(2026, 4, 7, 10, 0));
    monitor.recordAssignment(true, 'km-KH', new Date(2026, 4, 7, 11, 0));
    monitor.recordJobAssigned();
    // Tuesday's first tick rolls over (stashes Monday as previousDay)
    monitor.recordTickStart(new Date(2026, 4, 8, 0, 5));
    monitor.recordAssignment(true, 'lo-LA', new Date(2026, 4, 8, 1, 0)); // a bit of Tuesday
    // The 09:00 Tuesday summary should report MONDAY's full totals, not Tuesday-so-far
    const s = monitor.dailySummaryStats(new Date(2026, 4, 8, 9, 0));
    expect(s.date).toBe('2026-05-07');
    expect(s.assigned).toBe(2);
    expect(s.byLang).toEqual({ 'lo-LA': 1, 'km-KH': 1 });
    expect(s.jobsAssigned).toBe(1);
  });

  it('computes uptime from THIS process start, not the persisted install time', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'health-'));
    const file = path.join(dir, 'health.json');
    // A health.json written by a prior install 10 days ago.
    writeFileSync(
      file,
      JSON.stringify({
        startedAt: '2026-05-01T00:00:00.000Z',
        lastTickAt: null,
        lastSuccessAt: null,
        lastAssignmentAt: null,
        consecutiveErrors: 0,
        consecutiveZeroScans: 0,
        today: { date: '2026-05-11', assigned: 0, jobsAssigned: 0, reviewed: 0, failed: 0, authEpisodes: 0, lo: 0, km: 0, ticks: 0 },
        previousDay: null,
        lastDailySummaryDate: null,
      })
    );
    // This process started at 08:00 today.
    const m = new HealthMonitor(file, new Date(2026, 4, 11, 8, 0));
    await m.load();
    // 09:00 → 1h since THIS process started, not ~240h since the install date.
    expect(m.dailySummaryStats(new Date(2026, 4, 11, 9, 0)).uptimeHours).toBe(1);
  });

  it('defaults jobsAssigned to 0 when loading a pre-jobsAssigned health.json', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'health-'));
    const file = path.join(dir, 'health.json');
    writeFileSync(file, JSON.stringify({
      startedAt: '2026-05-07T00:00:00.000Z', lastTickAt: null, lastSuccessAt: null,
      consecutiveErrors: 0,
      today: { date: '2026-05-07', assigned: 5, failed: 2, authEpisodes: 1 },
      lastDailySummaryDate: null,
    }));
    const m = new HealthMonitor(file, new Date(2026, 4, 7, 8, 0));
    await m.load();
    expect(m.snapshot().today.jobsAssigned).toBe(0);
    expect(m.snapshot().today.assigned).toBe(5);
    m.recordJobAssigned();
    expect(m.snapshot().today.jobsAssigned).toBe(1);
  });

  it('recovers from a corrupt health.json by starting fresh and signals the recovery', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'health-'));
    const file = path.join(dir, 'health.json');
    writeFileSync(file, '{ this is not valid json');
    const m = new HealthMonitor(file, new Date(2026, 4, 7, 8, 0));
    await expect(m.load()).resolves.toBe(true);
    expect(m.snapshot().today.assigned).toBe(0); // fresh
  });

  it('persists the session save-failure streak so escalation survives a restart', async () => {
    const { monitor, file } = newMonitor(new Date(2026, 4, 7, 8, 0));
    await monitor.load();
    expect(monitor.recordSessionSaveResult(false)).toBe(1);
    expect(monitor.recordSessionSaveResult(false)).toBe(2);
    await monitor.save();
    // A restart between failures must NOT reset the streak to 1 (which would
    // defeat the threshold-3 escalation under a restart loop).
    const m2 = new HealthMonitor(file, new Date(2026, 4, 7, 8, 5));
    await m2.load();
    expect(m2.recordSessionSaveResult(false)).toBe(3);
  });

  it('resets the save-failure streak on a successful save', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    monitor.recordSessionSaveResult(false);
    monitor.recordSessionSaveResult(false);
    expect(monitor.recordSessionSaveResult(true)).toBe(0);
    monitor.recordStateSaveResult(false);
    expect(monitor.recordStateSaveResult(true)).toBe(0);
  });

  it('persists expiry alert-suppression flags across a restart (no duplicate alerts)', async () => {
    const { monitor, file } = newMonitor(new Date(2026, 4, 7, 8, 0));
    await monitor.load();
    monitor.setExpiryAlerted(true);
    monitor.setExpiryReadFailedAlerted(true);
    await monitor.save();
    const m2 = new HealthMonitor(file, new Date(2026, 4, 7, 8, 5));
    await m2.load();
    expect(m2.expiryAlerted).toBe(true);
    expect(m2.expiryReadFailedAlerted).toBe(true);
  });

  it('tracks consecutive zero scans and resets', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    monitor.recordZeroScan();
    monitor.recordZeroScan();
    expect(monitor.getConsecutiveZeroScans()).toBe(2);
    monitor.resetZeroScans();
    expect(monitor.getConsecutiveZeroScans()).toBe(0);
  });
});
