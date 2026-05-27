import { promises as fs } from 'fs';
import path from 'path';
import { localDateString, isNewDay, isDailySummaryDue } from './health-utils.js';
import type { DailySummaryStats } from '../types/index.js';

interface TodayCounters {
  date: string;
  assigned: number; // language-level assignments
  jobsAssigned: number; // jobs that received at least one assignment
  failed: number;
  authEpisodes: number;
}

interface HealthState {
  startedAt: string;
  lastTickAt: string | null;
  lastSuccessAt: string | null;
  consecutiveErrors: number;
  consecutiveZeroScans: number;
  today: TodayCounters;
  lastDailySummaryDate: string | null;
}

export class HealthMonitor {
  private state: HealthState;

  constructor(private filePath: string, now: Date = new Date()) {
    this.state = {
      startedAt: now.toISOString(),
      lastTickAt: null,
      lastSuccessAt: null,
      consecutiveErrors: 0,
      consecutiveZeroScans: 0,
      today: { date: localDateString(now), assigned: 0, jobsAssigned: 0, failed: 0, authEpisodes: 0 },
      lastDailySummaryDate: null,
    };
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as HealthState;
      this.state = { ...this.state, ...raw, today: { ...this.state.today, ...raw.today } };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if (err instanceof SyntaxError) {
        const backup = `${this.filePath}.corrupt.${Date.now()}`;
        await fs.rename(this.filePath, backup).catch(() => {});
        return; // keep the fresh default state from the constructor
      }
      throw err;
    }
  }

  private rollover(now: Date): void {
    if (isNewDay(now, this.state.today.date)) {
      this.state.today = { date: localDateString(now), assigned: 0, jobsAssigned: 0, failed: 0, authEpisodes: 0 };
    }
  }

  recordTickStart(now: Date = new Date()): void {
    this.rollover(now);
    this.state.lastTickAt = now.toISOString();
  }

  recordTickSuccess(now: Date = new Date()): void {
    this.state.consecutiveErrors = 0;
    this.state.lastSuccessAt = now.toISOString();
  }

  recordTickError(): void {
    this.state.consecutiveErrors += 1;
  }

  recordAssignment(ok: boolean): void {
    if (ok) this.state.today.assigned += 1;
    else this.state.today.failed += 1;
  }

  /** Count one job that received at least one (real) language assignment. */
  recordJobAssigned(): void {
    this.state.today.jobsAssigned += 1;
  }

  recordAuthEpisode(): void {
    this.state.today.authEpisodes += 1;
  }

  recordZeroScan(): void { this.state.consecutiveZeroScans += 1; }
  resetZeroScans(): void { this.state.consecutiveZeroScans = 0; }
  getConsecutiveZeroScans(): number { return this.state.consecutiveZeroScans; }

  shouldAlertErrorRate(threshold: number): boolean {
    return this.state.consecutiveErrors > 0 && this.state.consecutiveErrors % threshold === 0;
  }

  isDailySummaryDue(now: Date, summaryTime: string): boolean {
    return isDailySummaryDue(now, summaryTime, this.state.lastDailySummaryDate);
  }

  markDailySummarySent(now: Date = new Date()): void {
    this.state.lastDailySummaryDate = localDateString(now);
  }

  /** Structured figures for the daily heartbeat card. */
  dailySummaryStats(now: Date = new Date()): DailySummaryStats {
    const t = this.state.today;
    const uptimeHours = Number(
      ((now.getTime() - new Date(this.state.startedAt).getTime()) / 3_600_000).toFixed(1)
    );
    return {
      date: t.date,
      assigned: t.assigned,
      jobsAssigned: t.jobsAssigned,
      failed: t.failed,
      authEpisodes: t.authEpisodes,
      uptimeHours,
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
