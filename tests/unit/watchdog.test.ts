import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWithWatchdog } from '../../src/core/watchdog.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('runWithWatchdog', () => {
  it('returns the value and does not call onTimeout when fn settles in time', async () => {
    const onTimeout = vi.fn();
    const p = runWithWatchdog(async () => 'ok', 1000, onTimeout);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('ok');
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('calls onTimeout and rejects when fn exceeds the timeout', async () => {
    const onTimeout = vi.fn();
    const p = runWithWatchdog(
      () => new Promise<string>(() => { /* never resolves */ }),
      1000,
      onTimeout
    );
    const assertion = expect(p).rejects.toThrow(/watchdog timeout/i);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
