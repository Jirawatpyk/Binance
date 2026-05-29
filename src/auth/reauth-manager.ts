import type winston from 'winston';
import { LoginFailedError } from '../core/errors.js';

export type AuthState = 'AUTHED' | 'PAUSED_AUTH';

export interface ReAuthDeps {
  /** Throws LoginFailedError when the session is expired/absent. */
  ensureLoggedIn: () => Promise<void>;
  /** Fire-and-forget notification (never throws). */
  notify: (text: string, severity: 'info' | 'warn' | 'error') => Promise<void>;
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

  constructor(private deps: ReAuthDeps) {}

  get authState(): AuthState {
    return this.state;
  }

  /** Returns true if the session is ready for work, false if paused awaiting re-auth. */
  async ensureReady(): Promise<boolean> {
    try {
      await this.deps.ensureLoggedIn();
      if (this.state === 'PAUSED_AUTH') {
        this.state = 'AUTHED';
        this.deps.logger.info('auth restored; resuming');
        await this.deps.notify('Session restored — resuming', 'info');
      }
      return true;
    } catch (err) {
      if (err instanceof LoginFailedError) {
        // Before pausing, try to auto-renew (recovers an expired session — e.g.
        // one that lapsed while the bot was down — without a manual
        // capture-cookies). tryRefresh is best-effort: a throw (the dep type
        // doesn't guarantee it won't) is caught and treated as a failed refresh,
        // so it can never escape ensureReady and abort the tick mid-recovery.
        let refreshed = false;
        if (this.deps.tryRefresh) {
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
