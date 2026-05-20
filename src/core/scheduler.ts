import type winston from 'winston';

export interface SchedulerConfig {
  intervalMinutes: number;
  jitterSeconds: number;
}

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopRequested = false;

  constructor(
    private config: SchedulerConfig,
    private tickFn: () => Promise<void>,
    private logger: winston.Logger
  ) {}

  start(): void {
    this.logger.info('scheduler started', { intervalMinutes: this.config.intervalMinutes });
    this.scheduleNext(0);
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopRequested) return;
    this.timer = setTimeout(async () => {
      if (this.running) {
        this.logger.warn('previous tick still running; skipping');
        this.scheduleNext(this.calcDelay());
        return;
      }
      this.running = true;
      try {
        await this.tickFn();
      } catch (err) {
        this.logger.error('scheduler tick failed', { error: (err as Error).message });
      } finally {
        this.running = false;
      }
      this.scheduleNext(this.calcDelay());
    }, delayMs);
  }

  private calcDelay(): number {
    const base = this.config.intervalMinutes * 60 * 1000;
    const jitter = Math.random() * this.config.jitterSeconds * 1000;
    return base + jitter;
  }

  stop(reason: string): void {
    this.logger.info('scheduler stopping', { reason });
    this.stopRequested = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
