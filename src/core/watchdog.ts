/**
 * Run `fn` with a hang-detection timeout. If `fn` has not settled within
 * `timeoutMs`, `onTimeout` is invoked (callers typically log + process.exit) and
 * the returned promise rejects. If `fn` settles first, its result is returned and
 * the timer is cleared.
 */
export async function runWithWatchdog<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`watchdog timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
