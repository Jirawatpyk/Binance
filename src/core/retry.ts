export interface RetryOptions {
  maxAttempts: number;       // total attempts including the first
  baseDelayMs: number;       // delay before first retry; doubles each subsequent
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
  onAttemptFail?: (err: unknown, attempt: number) => void
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (onAttemptFail) onAttemptFail(err, attempt);
      if (attempt === opts.maxAttempts) break;
      const delay = opts.baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}
