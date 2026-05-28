import type { ProcessedJobEntry } from '../types/index.js';

/**
 * Should the decoupled review scan skip re-surfacing this job?
 *
 * Skip jobs we have given up on (ABANDONED) and jobs still inside their cooldown
 * window (recheckAfter in the future — set when a FULL job re-opened to nothing
 * assignable). A FULL job with no recheckAfter is NOT skipped: that is a
 * translated job awaiting review, which is exactly what the review pass is for.
 * A missing entry is not skipped (never processed). A corrupt recheckAfter parses
 * to NaN and does not skip — fail-open toward doing work, matching the tick loop.
 */
export function isReviewScanSkippable(
  entry: ProcessedJobEntry | undefined,
  now: number
): boolean {
  if (!entry) return false;
  if (entry.status === 'ABANDONED') return true;
  if (entry.recheckAfter) {
    const t = Date.parse(entry.recheckAfter);
    if (!Number.isNaN(t) && now < t) return true;
  }
  return false;
}
