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
  /** Optional: try to auto-renew the session (returns true on success). Attempted
   *  once before pausing, to recover a session that expired while the bot was down. */
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
        // Before pausing, try to auto-renew (recovers a session that expired
        // while the bot was down, without a manual capture-cookies).
        if (this.deps.tryRefresh && (await this.deps.tryRefresh())) {
          try {
            await this.deps.ensureLoggedIn(); // re-verify with the refreshed token
            const wasPaused = this.state === 'PAUSED_AUTH';
            this.state = 'AUTHED';
            this.deps.logger.info('session recovered via token refresh');
            if (wasPaused) await this.deps.notify('Session restored (token auto-refreshed) — resuming', 'info');
            return true;
          } catch {
            // refresh did not actually restore a working session — fall through to pause
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
