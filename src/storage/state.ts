import { promises as fs } from 'fs';
import path from 'path';
import type { State, SupportedLanguage, ProcessedJobEntry } from '../types/index.js';

export class StateStore {
  private state: State = { processedJobs: {}, roundRobinCounters: {} };
  private dirty = false;

  constructor(private filePath: string) {}

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      this.state = JSON.parse(content);
      if (!this.state.processedJobs) this.state.processedJobs = {};
      if (!this.state.roundRobinCounters) this.state.roundRobinCounters = {};
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.state = { processedJobs: {}, roundRobinCounters: {} };
        return;
      }
      if (err instanceof SyntaxError) {
        const backup = `${this.filePath}.corrupt.${Date.now()}`;
        await fs.rename(this.filePath, backup).catch(() => {});
        this.state = { processedJobs: {}, roundRobinCounters: {} };
        return;
      }
      throw err;
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
    await fs.rename(tmp, this.filePath);
    this.dirty = false;
  }

  isProcessed(jobId: string): boolean {
    return this.state.processedJobs[jobId]?.status === 'FULL';
  }

  getProcessStatus(jobId: string): 'FULL' | 'PARTIAL' | 'ABANDONED' | undefined {
    return this.state.processedJobs[jobId]?.status;
  }

  getProcessedEntry(jobId: string): ProcessedJobEntry | undefined {
    return this.state.processedJobs[jobId];
  }

  markProcessed(jobId: string, assigned: Partial<Record<SupportedLanguage, string>>): void {
    this.state.processedJobs[jobId] = {
      processedAt: new Date().toISOString(),
      status: 'FULL',
      assigned,
    };
    this.dirty = true;
  }

  markPartial(
    jobId: string,
    assigned: Partial<Record<SupportedLanguage, string>>,
    failed: SupportedLanguage[]
  ): void {
    const prev = this.state.processedJobs[jobId];
    this.state.processedJobs[jobId] = {
      processedAt: new Date().toISOString(),
      status: 'PARTIAL',
      assigned: { ...prev?.assigned, ...assigned },
      failed,
      retryCount: (prev?.retryCount ?? 0) + 1,
    };
    this.dirty = true;
  }

  markAbandoned(jobId: string): void {
    const prev = this.state.processedJobs[jobId];
    if (!prev) return;
    this.state.processedJobs[jobId] = { ...prev, status: 'ABANDONED', processedAt: new Date().toISOString() };
    this.dirty = true;
  }

  getRRIndex(key: string): number {
    return this.state.roundRobinCounters[key] ?? 0;
  }

  incrementRR(key: string): void {
    this.state.roundRobinCounters[key] = (this.state.roundRobinCounters[key] ?? 0) + 1;
    this.dirty = true;
  }

  /** Remove processed-job records older than retainHours. Returns count removed. */
  pruneOldJobs(retainHours: number): number {
    const cutoff = Date.now() - retainHours * 3_600_000;
    let removed = 0;
    for (const [id, entry] of Object.entries(this.state.processedJobs)) {
      if (new Date(entry.processedAt).getTime() < cutoff) {
        delete this.state.processedJobs[id];
        removed += 1;
      }
    }
    if (removed > 0) this.dirty = true;
    return removed;
  }
}
