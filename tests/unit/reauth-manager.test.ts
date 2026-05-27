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
});
