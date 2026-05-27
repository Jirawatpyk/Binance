/** True if the error indicates the Playwright browser/page/context died and needs relaunch. */
export function isBrowserDeadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : '';
  return /target closed|target page, context or browser has been closed|browser has been closed|browsercontext.*closed|page was destroyed|connection closed/i.test(
    msg
  );
}
