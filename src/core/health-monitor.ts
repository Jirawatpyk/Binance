import { promises as fs } from 'fs';
import path from 'path';
import { localDateString, isNewDay, isDailySummaryDue } from './health-utils.js';
import type { DailySummaryStats, SupportedLanguage } from '../types/index.js';

interface TodayCounters {
  date: string;
  assigned: number; // language-level (translator) assignments
  jobsAssigned: number; // jobs that received at least one assignment
  reviewed: number; // reviewer assignments (separate from translations)
  failed: number;
  authEpisodes: number;
  lo: number; // lo-LA language assignments
  km: number; // km-KH language assignments
  ticks: number; // polling cycles run today
}

interface HealthState {
  startedAt: string;
  lastTickAt: string | null;
  lastSuccessAt: string | null;
  lastAssignmentAt: string | null;
  consecutiveErrors: number;
  // True once the consecutive-error alert has fired for the current streak.
  // Persisted so a watchdog hard-exit / restart loop doesn't re-fire it every
  // restart; cleared by recordTickSuccess when the streak ends.
  errorAlerted: boolean;
  consecutiveZeroScans: number;
  today: TodayCounters;
  previousDay: TodayCounters | null; // the last completed day, stashed at rollover
  lastDailySummaryDate: string | null;
  // One-shot alert suppression + save-failure streaks, persisted so a watchdog
  // hard-exit / restart loop doesn't re-fire "once" alerts every restart, and so
  // a restart between save failures can't defeat the threshold escalation.
  alerts: {
    expiryAlerted: boolean;
    expiryReadFailedAlerted: boolean;
    sessionSaveFailures: number;
    stateSaveFailures: number;
  };
}

function emptyToday(now: Date): TodayCounters {
  return { date: localDateString(now), assigned: 0, jobsAssigned: 0, reviewed: 0, failed: 0, authEpisodes: 0, lo: 0, km: 0, ticks: 0 };
}

export class HealthMonitor {
  private state: HealthState;
  // When THIS process started. Kept separate from state.startedAt (which load()
  // overwrites with the persisted install time) so uptime reflects the current
  // process — otherwise a watchdog hard-exit / restart loop would keep reporting
  // an ever-growing "uptime" and hide the very failure it should surface.
  private readonly processStartedAt: Date;

  constructor(private filePath: string, now: Date = new Date()) {
    this.processStartedAt = now;
    this.state = {
      startedAt: now.toISOString(),
      lastTickAt: null,
      lastSuccessAt: null,
      lastAssignmentAt: null,
      consecutiveErrors: 0,
      errorAlerted: false,
      consecutiveZeroScans: 0,
      today: emptyToday(now),
      previousDay: null,
      lastDailySummaryDate: null,
      alerts: {
        expiryAlerted: false,
        expiryReadFailedAlerted: false,
        sessionSaveFailures: 0,
        stateSaveFailures: 0,
      },
    };
  }

  /** Returns true if the on-disk file was corrupt and metrics were reset to a
   *  fresh default — the caller should surface it (the daily summary will
   *  under-report until counters rebuild). */
  async load(): Promise<boolean> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as HealthState;
      this.state = {
        ...this.state,
        ...raw,
        today: { ...this.state.today, ...raw.today },
        alerts: { ...this.state.alerts, ...raw.alerts },
      };
      return false;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return false;
      if (err instanceof SyntaxError) {
        const backup = `${this.filePath}.corrupt.${Date.now()}`;
        await fs.rename(this.filePath, backup).catch(() => {});
        return true; // keep the fresh default state from the constructor
      }
      throw err;
    }
  }

  private rollover(now: Date): void {
    if (isNewDay(now, this.state.today.date)) {
      // Stash the day that just ended so the daily summary (sent later, at
      // dailySummaryTime) can report a FULL previous day rather than the few
      // hours of the new day accumulated since midnight.
      this.state.previousDay = this.state.today;
      this.state.today = emptyToday(now);
    }
  }

  recordTickStart(now: Date = new Date()): void {
    this.rollover(now);
    this.state.lastTickAt = now.toISOString();
  }

  /** Count one real board poll (called only when the tick actually scans — not
   *  when it returns early paused for auth), so "polls today" reflects real work. */
  recordPoll(): void {
    this.state.today.ticks += 1;
  }

  recordTickSuccess(now: Date = new Date()): void {
    this.state.consecutiveErrors = 0;
    this.state.errorAlerted = false; // streak ended — re-arm the alert
    this.state.lastSuccessAt = now.toISOString();
  }

  recordTickError(): void {
    this.state.consecutiveErrors += 1;
  }

  recordAssignment(ok: boolean, lang?: SupportedLanguage, now: Date = new Date()): void {
    if (ok) {
      this.state.today.assigned += 1;
      if (lang === 'lo-LA') this.state.today.lo += 1;
      else if (lang === 'km-KH') this.state.today.km += 1;
      this.state.lastAssignmentAt = now.toISOString();
    } else {
      this.state.today.failed += 1;
    }
  }

  /** Count one job that received at least one (real) language assignment. */
  recordJobAssigned(): void {
    this.state.today.jobsAssigned += 1;
  }

  /** Count one real reviewer assignment (tracked separately from translations). */
  recordReview(): void {
    this.state.today.reviewed += 1;
  }

  recordAuthEpisode(): void {
    this.state.today.authEpisodes += 1;
  }

  recordZeroScan(): void { this.state.consecutiveZeroScans += 1; }
  resetZeroScans(): void { this.state.consecutiveZeroScans = 0; }
  getConsecutiveZeroScans(): number { return this.state.consecutiveZeroScans; }

  /** Fire the consecutive-error alert at most once per error streak: returns
   *  true the first time the streak reaches `threshold`, then false until a
   *  success re-arms it (recordTickSuccess). This consuming call records that the
   *  alert fired (persisted), so a restart mid-streak doesn't re-alert and a
   *  sustained outage doesn't produce an alert every Nth tick. */
  shouldAlertErrorRate(threshold: number): boolean {
    if (this.state.consecutiveErrors >= threshold && !this.state.errorAlerted) {
      this.state.errorAlerted = true;
      return true;
    }
    return false;
  }

  // --- Persisted alert-suppression flags (survive restart) ---
  get expiryAlerted(): boolean { return this.state.alerts.expiryAlerted; }
  setExpiryAlerted(v: boolean): void { this.state.alerts.expiryAlerted = v; }
  get expiryReadFailedAlerted(): boolean { return this.state.alerts.expiryReadFailedAlerted; }
  setExpiryReadFailedAlerted(v: boolean): void { this.state.alerts.expiryReadFailedAlerted = v; }

  /** Record a session-save result and return the current consecutive-failure
   *  streak (0 after a success). Persisted so a restart between failures doesn't
   *  reset the streak and defeat the threshold escalation. */
  recordSessionSaveResult(ok: boolean): number {
    this.state.alerts.sessionSaveFailures = ok ? 0 : this.state.alerts.sessionSaveFailures + 1;
    return this.state.alerts.sessionSaveFailures;
  }

  /** Record a state.json-save result and return the current consecutive-failure
   *  streak (0 after a success). */
  recordStateSaveResult(ok: boolean): number {
    this.state.alerts.stateSaveFailures = ok ? 0 : this.state.alerts.stateSaveFailures + 1;
    return this.state.alerts.stateSaveFailures;
  }

  isDailySummaryDue(now: Date, summaryTime: string): boolean {
    return isDailySummaryDue(now, summaryTime, this.state.lastDailySummaryDate);
  }

  markDailySummarySent(now: Date = new Date()): void {
    this.state.lastDailySummaryDate = localDateString(now);
  }

  /** Structured figures for the daily heartbeat card. Reports the last COMPLETED
   *  day (stashed at midnight rollover) when available, so the morning heartbeat
   *  summarises a full day rather than only the hours since midnight; falls back
   *  to the current day before any rollover has happened (first run). */
  dailySummaryStats(now: Date = new Date()): DailySummaryStats {
    const t = this.state.previousDay ?? this.state.today;
    const uptimeHours = Number(
      ((now.getTime() - this.processStartedAt.getTime()) / 3_600_000).toFixed(1)
    );
    return {
      date: t.date,
      assigned: t.assigned,
      jobsAssigned: t.jobsAssigned,
      reviewed: t.reviewed,
      byLang: { 'lo-LA': t.lo, 'km-KH': t.km },
      failed: t.failed,
      authEpisodes: t.authEpisodes,
      ticks: t.ticks,
      uptimeHours,
      lastAssignmentAt: this.state.lastAssignmentAt,
      lastSuccessAt: this.state.lastSuccessAt,
      consecutiveErrors: this.state.consecutiveErrors,
    };
  }

  snapshot(): Readonly<HealthState> {
    return this.state;
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
    await fs.rename(tmp, this.filePath);
  }
}
