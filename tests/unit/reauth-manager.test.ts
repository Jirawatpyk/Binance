import { describe, it, expect, vi } from 'vitest';
import { ReAuthManager } from '../../src/auth/reauth-manager.js';
import { LoginFailedError } from '../../src/core/errors.js';

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as import('winston').Logger;

function make(ensureLoggedIn: () => Promise<void>) {
  const notify = vi.fn(async () => {});
  const onPause = vi.fn();
  const mgr = new ReAuthManager({ ensureLoggedIn, notify, logger: noopLogger, onPause });
  return { mgr, notify, onPause };
}

describe('ReAuthManager.ensureReady', () => {
  it('returns true and does not notify while authed', async () => {
    const { mgr, notify } = make(async () => {});
    expect(await mgr.ensureReady()).toBe(true);
    expect(mgr.authState).toBe('AUTHED');
    expect(notify).not.toHaveBeenCalled();
  });

  it('pauses and alerts once on session expiry', async () => {
    const { mgr, notify, onPause } = make(async () => { throw new LoginFailedError('Session expired.'); });
    expect(await mgr.ensureReady()).toBe(false);
    expect(mgr.authState).toBe('PAUSED_AUTH');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('does not re-alert while still paused', async () => {
    const { mgr, notify } = make(async () => { throw new LoginFailedError('Session expired.'); });
    await mgr.ensureReady();
    await mgr.ensureReady();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('resumes and alerts when auth recovers', async () => {
    let fail = true;
    const { mgr, notify } = make(async () => { if (fail) throw new LoginFailedError('x'); });
    await mgr.ensureReady();
    fail = false;
    expect(await mgr.ensureReady()).toBe(true);
    expect(mgr.authState).toBe('AUTHED');
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('rethrows non-auth errors', async () => {
    const { mgr } = make(async () => { throw new Error('network boom'); });
    await expect(mgr.ensureReady()).rejects.toThrow('network boom');
  });

  it('recovers via tryRefresh without pausing when refresh restores the session', async () => {
    let calls = 0;
    const ensureLoggedIn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new LoginFailedError('expired');
      // second call (post-refresh re-verify) succeeds
    });
    const tryRefresh = vi.fn(async () => true);
    const notify = vi.fn(async () => {});
    const onPause = vi.fn();
    const mgr = new ReAuthManager({ ensureLoggedIn, notify, logger: noopLogger, onPause, tryRefresh });
    expect(await mgr.ensureReady()).toBe(true);
    expect(mgr.authState).toBe('AUTHED');
    expect(tryRefresh).toHaveBeenCalledTimes(1);
    expect(ensureLoggedIn).toHaveBeenCalledTimes(2); // initial throw + re-verify
    expect(onPause).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled(); // was AUTHED, not paused → no restore notice
  });

  it('pauses when tryRefresh fails', async () => {
    const ensureLoggedIn = vi.fn(async () => { throw new LoginFailedError('expired'); });
    const tryRefresh = vi.fn(async () => false);
    const notify = vi.fn(async () => {});
    const onPause = vi.fn();
    const mgr = new ReAuthManager({ ensureLoggedIn, notify, logger: noopLogger, onPause, tryRefresh });
    expect(await mgr.ensureReady()).toBe(false);
    expect(mgr.authState).toBe('PAUSED_AUTH');
    expect(tryRefresh).toHaveBeenCalledTimes(1);
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('pauses when tryRefresh succeeds but the re-verify still fails', async () => {
    const ensureLoggedIn = vi.fn(async () => { throw new LoginFailedError('expired'); });
    const tryRefresh = vi.fn(async () => true);
    const onPause = vi.fn();
    const mgr = new ReAuthManager({ ensureLoggedIn, notify: vi.fn(async () => {}), logger: noopLogger, onPause, tryRefresh });
    expect(await mgr.ensureReady()).toBe(false);
    expect(mgr.authState).toBe('PAUSED_AUTH');
    expect(ensureLoggedIn).toHaveBeenCalledTimes(2); // initial + re-verify, both throw
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('rethrows a non-auth error thrown during the post-refresh re-verify (does not pause)', async () => {
    let calls = 0;
    const ensureLoggedIn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new LoginFailedError('expired');
      throw new Error('network boom'); // re-verify hits a transient non-auth error
    });
    const tryRefresh = vi.fn(async () => true);
    const onPause = vi.fn();
    const mgr = new ReAuthManager({ ensureLoggedIn, notify: vi.fn(async () => {}), logger: noopLogger, onPause, tryRefresh });
    await expect(mgr.ensureReady()).rejects.toThrow('network boom');
    expect(onPause).not.toHaveBeenCalled(); // a transient error must NOT pause
  });

  it('notifies restore when recovering FROM a paused state via tryRefresh', async () => {
    let healthy = false;
    let refreshWorks = false;
    const ensureLoggedIn = vi.fn(async () => { if (!healthy) throw new LoginFailedError('expired'); });
    const tryRefresh = vi.fn(async () => { if (refreshWorks) { healthy = true; return true; } return false; });
    const notify = vi.fn(async () => {});
    const onPause = vi.fn();
    const mgr = new ReAuthManager({ ensureLoggedIn, notify, logger: noopLogger, onPause, tryRefresh });
    // tick 1: refresh can't recover yet → pause
    expect(await mgr.ensureReady()).toBe(false);
    expect(mgr.authState).toBe('PAUSED_AUTH');
    // tick 2: refresh now restores the session
    refreshWorks = true;
    expect(await mgr.ensureReady()).toBe(true);
    expect(mgr.authState).toBe('AUTHED');
    expect(notify).toHaveBeenCalledTimes(2); // pause alert (tick1) + restore notice (tick2)
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('auto-refreshed'), 'info');
  });

  it('treats a throwing tryRefresh as a failed refresh (pauses, does not escape ensureReady)', async () => {
    const ensureLoggedIn = vi.fn(async () => { throw new LoginFailedError('expired'); });
    const tryRefresh = vi.fn(async () => { throw new Error('refresh boom'); });
    const notify = vi.fn(async () => {});
    const onPause = vi.fn();
    const mgr = new ReAuthManager({ ensureLoggedIn, notify, logger: noopLogger, onPause, tryRefresh });
    expect(await mgr.ensureReady()).toBe(false); // resolves false, does NOT reject/escape
    expect(mgr.authState).toBe('PAUSED_AUTH');
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('backs off tryRefresh while paused instead of hitting the endpoint every tick', async () => {
    const ensureLoggedIn = vi.fn(async () => { throw new LoginFailedError('expired'); });
    const tryRefresh = vi.fn(async () => false); // refresh_token is dead → stays paused
    const mgr = new ReAuthManager({ ensureLoggedIn, notify: vi.fn(async () => {}), logger: noopLogger, onPause: vi.fn(), tryRefresh });
    for (let i = 0; i < 7; i++) await mgr.ensureReady(); // 7 failing ticks
    // Exponential backoff: attempt only on failing-streak 1, 2, 4 (powers of two)
    // — 3 attempts across 7 ticks, not one per tick.
    expect(tryRefresh).toHaveBeenCalledTimes(3);
  });

  it('still recovers via tryRefresh on the SECOND failing tick while paused', async () => {
    let healthy = false;
    let refreshWorks = false;
    const ensureLoggedIn = vi.fn(async () => { if (!healthy) throw new LoginFailedError('expired'); });
    const tryRefresh = vi.fn(async () => { if (refreshWorks) { healthy = true; return true; } return false; });
    const mgr = new ReAuthManager({ ensureLoggedIn, notify: vi.fn(async () => {}), logger: noopLogger, onPause: vi.fn(), tryRefresh });
    await mgr.ensureReady(); // tick 1 (streak 1): refresh fails → pause
    refreshWorks = true;
    expect(await mgr.ensureReady()).toBe(true); // tick 2 (streak 2): attempted → recovers
    expect(mgr.authState).toBe('AUTHED');
  });

  it('re-arms refresh attempts after the session recovers and expires again', async () => {
    let healthy = false;
    const ensureLoggedIn = vi.fn(async () => { if (!healthy) throw new LoginFailedError('x'); });
    const tryRefresh = vi.fn(async () => false);
    const mgr = new ReAuthManager({ ensureLoggedIn, notify: vi.fn(async () => {}), logger: noopLogger, onPause: vi.fn(), tryRefresh });
    await mgr.ensureReady(); // streak 1 → attempt
    await mgr.ensureReady(); // streak 2 → attempt
    expect(tryRefresh).toHaveBeenCalledTimes(2);
    healthy = true;
    await mgr.ensureReady(); // recovers via ensureLoggedIn → streak reset
    healthy = false;
    await mgr.ensureReady(); // streak 1 again → attempt re-armed
    expect(tryRefresh).toHaveBeenCalledTimes(3);
  });

  it('does not re-fire onPause/notify when re-verify keeps failing while already paused', async () => {
    const ensureLoggedIn = vi.fn(async () => { throw new LoginFailedError('expired'); });
    let refreshTrue = false;
    const tryRefresh = vi.fn(async () => refreshTrue);
    const notify = vi.fn(async () => {});
    const onPause = vi.fn();
    const mgr = new ReAuthManager({ ensureLoggedIn, notify, logger: noopLogger, onPause, tryRefresh });
    // tick 1: tryRefresh false → pause (onPause + notify once)
    await mgr.ensureReady();
    expect(mgr.authState).toBe('PAUSED_AUTH');
    // tick 2: tryRefresh true but re-verify still throws LoginFailedError → stays paused, no re-fire
    refreshTrue = true;
    expect(await mgr.ensureReady()).toBe(false);
    expect(mgr.authState).toBe('PAUSED_AUTH');
    expect(onPause).toHaveBeenCalledTimes(1); // not re-fired while already paused
    expect(notify).toHaveBeenCalledTimes(1); // no new alert while already paused
  });
});
