import { describe, it, expect, vi } from 'vitest';
import { retry } from '../../src/core/retry.js';

describe('retry', () => {
  it('returns immediately on first success', async () => {
    const fn = vi.fn(async () => 'ok');
    expect(await retry(fn, { maxAttempts: 3, baseDelayMs: 1 })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries then succeeds', async () => {
    let n = 0;
    const fn = vi.fn(async () => { if (++n < 3) throw new Error('boom'); return 'ok'; });
    expect(await retry(fn, { maxAttempts: 5, baseDelayMs: 1 })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after exhausting attempts', async () => {
    const fn = vi.fn(async () => { throw new Error('always'); });
    await expect(retry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow('always');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('invokes onAttemptFail for each failure', async () => {
    const onFail = vi.fn();
    const fn = vi.fn(async () => { throw new Error('x'); });
    await expect(retry(fn, { maxAttempts: 2, baseDelayMs: 1 }, onFail)).rejects.toThrow();
    expect(onFail).toHaveBeenCalledTimes(2);
  });

  it('aborts early (no more attempts) when onAttemptFail throws', async () => {
    const fn = vi.fn(async () => { throw new Error('deterministic'); });
    // onAttemptFail re-throws to signal an unrecoverable error — retry must stop now.
    await expect(
      retry(fn, { maxAttempts: 5, baseDelayMs: 1 }, () => { throw new Error('do-not-retry'); })
    ).rejects.toThrow('do-not-retry');
    expect(fn).toHaveBeenCalledTimes(1); // aborted after the first failure, not 5
  });
});
