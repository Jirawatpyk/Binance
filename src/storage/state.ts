import { promises as fs } from 'fs';
import path from 'path';
import type { State, SupportedLanguage } from '../types/index.js';

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
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.state = { processedJobs: {}, roundRobinCounters: {} };
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

  getProcessStatus(jobId: string): 'FULL' | 'PARTIAL' | undefined {
    return this.state.processedJobs[jobId]?.status;
  }

  getProcessedEntry(jobId: string) {
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
    this.state.processedJobs[jobId] = {
      processedAt: new Date().toISOString(),
      status: 'PARTIAL',
      assigned,
      failed,
    };
    this.dirty = true;
  }

  getRRIndex(key: string): number {
    return this.state.roundRobinCounters[key] ?? 0;
  }

  incrementRR(key: string): void {
    this.state.roundRobinCounters[key] = (this.state.roundRobinCounters[key] ?? 0) + 1;
    this.dirty = true;
  }
}
