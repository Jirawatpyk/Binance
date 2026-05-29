import { promises as fs } from 'fs';
import path from 'path';
import type { State, SupportedLanguage, ProcessedJobEntry } from '../types/index.js';

export class StateStore {
  private state: State = { processedJobs: {}, roundRobinCounters: {} };
  private dirty = false;
  private saveSeq = 0; // unique temp-file suffix so concurrent saves don't clobber a shared .tmp

  constructor(private filePath: string) {}

  /** Returns true if the on-disk file was corrupt and the store was reset to
   *  empty (losing round-robin counters + processed history) — the caller should
   *  alert, since it can cause re-assignment of already-handled jobs. */
  async load(): Promise<boolean> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      this.state = JSON.parse(content);
      if (!this.state.processedJobs) this.state.processedJobs = {};
      if (!this.state.roundRobinCounters) this.state.roundRobinCounters = {};
      return false;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.state = { processedJobs: {}, roundRobinCounters: {} };
        return false;
      }
      if (err instanceof SyntaxError) {
        const backup = `${this.filePath}.corrupt.${Date.now()}`;
        await fs.rename(this.filePath, backup).catch(() => {});
        this.state = { processedJobs: {}, roundRobinCounters: {} };
        return true;
      }
      throw err;
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // Unique temp name per call: the watchdog hang-flush can run state.save()
    // concurrently with the still-running tick's own save, and a shared
    // `${filePath}.tmp` would let the two interleave (half-written tmp renamed,
    // or rename ENOENT). Distinct tmp files + atomic rename make it last-write-
    // wins with no corruption (both writers serialise the same in-memory state).
    const tmp = `${this.filePath}.${process.pid}.${this.saveSeq++}.tmp`;
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

  markProcessed(
    jobId: string,
    assigned: Partial<Record<SupportedLanguage, string>>,
    recheckAfter?: string
  ): void {
    // Merge with any prior assignment: a job's languages can be assigned across
    // separate ticks (e.g. km-KH now, lo-LA once it becomes claimable), so
    // re-marking FULL must not drop the earlier language.
    const prev = this.state.processedJobs[jobId];
    this.state.processedJobs[jobId] = {
      processedAt: new Date().toISOString(),
      status: 'FULL',
      assigned: { ...prev?.assigned, ...assigned },
      // Present only when re-opening found nothing assignable (cooldown); a
      // productive assign omits it so the job stays immediately re-checkable.
      ...(recheckAfter ? { recheckAfter } : {}),
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
    // Always persist the give-up decision, even if the prior entry was pruned
    // between ticks — otherwise the job would be re-scanned and retried forever
    // with no ABANDONED record.
    const processedAt = new Date().toISOString();
    this.state.processedJobs[jobId] = prev
      ? { ...prev, status: 'ABANDONED', processedAt }
      : { assigned: {}, status: 'ABANDONED', processedAt };
    this.dirty = true;
  }

  /** Set/refresh the recheck cooldown on an existing entry without changing its
   *  status or assignment record (used to cool down a PARTIAL job that re-opened
   *  to nothing assignable, preserving its retryCount/failed). */
  setRecheckAfter(jobId: string, recheckAfter: string): void {
    const prev = this.state.processedJobs[jobId];
    if (!prev) return;
    this.state.processedJobs[jobId] = { ...prev, recheckAfter };
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
      // Never age-prune ABANDONED records: we gave up on these, but the job may
      // still be listed on the board, and dropping the record would let it be
      // re-scanned, re-attempted from scratch, and re-alerted. They're few, so
      // keeping them is cheap and preserves the "give up forever" guarantee.
      if (entry.status === 'ABANDONED') continue;
      if (new Date(entry.processedAt).getTime() < cutoff) {
        delete this.state.processedJobs[id];
        removed += 1;
      }
    }
    if (removed > 0) this.dirty = true;
    return removed;
  }
}
