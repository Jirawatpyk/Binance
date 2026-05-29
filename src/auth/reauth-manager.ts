import type winston from 'winston';
import { LoginFailedError } from '../core/errors.js';

export type AuthState = 'AUTHED' | 'PAUSED_AUTH';

export interface ReAuthDeps {
  /** Throws LoginFailedError when the session is expired/absent. */
  ensureLoggedIn: () => Promise<void>;
  /** Fire-and-forget notification (never throws). Any resolved value (e.g. a
   *  delivered boolean) is ignored. */
  notify: (text: string, severity: 'info' | 'warn' | 'error') => Promise<unknown>;
  logger: winston.Logger;
  /** Called once when transitioning AUTHED -> PAUSED_AUTH (e.g., health metric). */
  onPause?: () => void;
  /** Optional: try to auto-renew the session (resolves true on success, false on
   *  any failure; should not throw — a throw is caught and treated as failure).
   *  Attempted once before pausing, to recover an expired session (e.g. one that
   *  lapsed while the bot was down, or mid-run) without a manual capture-cookies. */
  tryRefresh?: () => Promise<boolean>;
}

export class ReAuthManager {
  private state: AuthState = 'AUTHED';
  // Consecutive ensureReady() calls that hit a LoginFailedError, reset to 0 the
  // moment the session is healthy again. Used to back off tryRefresh while paused
  // (see isRefreshAttemptDue) so a genuinely-dead refresh_token isn't re-POSTed
  // to the refresh endpoint on every polling cycle for the whole outage.
  private failingStreak = 0;

  constructor(private deps: ReAuthDeps) {}

  get authState(): AuthState {
    return this.state;
  }

  /** Attempt a token refresh only on failing-streak 1, 2, 4, 8, … (powers of
   *  two) — i.e. exponential backoff while paused. The first two failing ticks
   *  still attempt (so a transient endpoint blip recovers promptly), then the
   *  cadence thins out, turning a multi-hour outage from one refresh POST per
   *  tick into a logarithmic number of attempts. */
  private isRefreshAttemptDue(): boolean {
    return (this.failingStreak & (this.failingStreak - 1)) === 0;
  }

  /** Returns true if the session is ready for work, false if paused awaiting re-auth. */
  async ensureReady(): Promise<boolean> {
    try {
      await this.deps.ensureLoggedIn();
      this.failingStreak = 0; // session healthy → re-arm refresh backoff
      if (this.state === 'PAUSED_AUTH') {
        this.state = 'AUTHED';
        this.deps.logger.info('auth restored; resuming');
        await this.deps.notify('Session restored — resuming', 'info');
      }
      return true;
    } catch (err) {
      if (err instanceof LoginFailedError) {
        this.failingStreak += 1;
        // Before pausing, try to auto-renew (recovers an expired session — e.g.
        // one that lapsed while the bot was down — without a manual
        // capture-cookies). tryRefresh is best-effort: a throw (the dep type
        // doesn't guarantee it won't) is caught and treated as a failed refresh,
        // so it can never escape ensureReady and abort the tick mid-recovery.
        // Backed off (isRefreshAttemptDue) so a dead refresh_token isn't re-POSTed
        // every tick for the whole outage.
        let refreshed = false;
        if (this.deps.tryRefresh && this.isRefreshAttemptDue()) {
          try {
            refreshed = await this.deps.tryRefresh();
          } catch (refreshErr) {
            this.deps.logger.warn('tryRefresh threw; treating as failed', {
              error: (refreshErr as Error).message,
            });
          }
        }
        if (refreshed) {
          try {
            await this.deps.ensureLoggedIn(); // re-verify with the refreshed token
            this.failingStreak = 0; // recovered → re-arm refresh backoff
            const wasPaused = this.state === 'PAUSED_AUTH';
            this.state = 'AUTHED';
            this.deps.logger.info('session recovered via token refresh');
            if (wasPaused) await this.deps.notify('Session restored (token auto-refreshed) — resuming', 'info');
            return true;
          } catch (reverifyErr) {
            // Only a genuine auth failure (token still bad after refresh) should
            // fall through to pause. A transient/non-auth error during re-verify
            // is a retryable tick error like any other — rethrow it (consistent
            // with the outer catch's handling of non-LoginFailedError).
            if (!(reverifyErr instanceof LoginFailedError)) throw reverifyErr;
          }
        }
        if (this.state === 'AUTHED') {
          this.state = 'PAUSED_AUTH';
          this.deps.onPause?.();
          this.deps.logger.warn('session expired; pausing until cookies refreshed');
          await this.deps.notify(
            'Session expired — run `npm run capture-cookies` on the host to resume',
            'error'
          );
        }
        return false;
      }
      throw err;
    }
  }
}
