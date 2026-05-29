import type { Job } from '../types/index.js';

/**
 * Pure selection for the decoupled review pass. From the raw jobs scraped across
 * the review languages (in board scan order), drop any that are already
 * translation candidates this tick, any already seen earlier in the list, and
 * any the skip predicate rejects (ABANDONED / cooling down); tag survivors
 * `reviewOnly` and return them NEWEST-first (highest numeric id) so the most
 * recently translated jobs — the ones actually pending review — win the per-tick
 * cap ahead of aged backlog (e.g. km-KH-only jobs whose lo-LA is already done but
 * still match the lo-LA board filter). The caller applies the cap.
 *
 * `reviewOnly` is age-aware: a survivor is review-only only when genuinely aged
 * (created before `translationCutoffMs`) or its created date couldn't be parsed
 * (conservative — review, don't translate). A FRESH survivor (created within the
 * translation window) is one the translation scan merely MISSED this tick, so it
 * is tagged reviewOnly=false and the tick loop can still translate it. This stops
 * a fresh WAITING_TRANSLATION job from being blocked + cooled when the flaky
 * translation board scan returns it on some ticks but not others.
 *
 * Returns new Job objects — the input jobs are not mutated.
 */
export function selectReviewCandidates(
  found: Job[],
  translationIds: Set<string>,
  isSkippable: (jobId: string) => boolean,
  translationCutoffMs: number
): Job[] {
  const out: Job[] = [];
  const seen = new Set<string>();
  for (const job of found) {
    if (translationIds.has(job.id) || seen.has(job.id) || isSkippable(job.id)) continue;
    seen.add(job.id);
    const reviewOnly = job.createdMs === null || job.createdMs < translationCutoffMs;
    out.push({ ...job, reviewOnly });
  }
  out.sort((a, b) => Number(b.id) - Number(a.id));
  return out;
}
