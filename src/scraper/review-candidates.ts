import type { Job } from '../types/index.js';

/**
 * Pure selection for the decoupled review pass. From the raw jobs scraped across
 * the review languages (in board scan order), drop any that are already
 * translation candidates this tick, any already seen earlier in the list, and
 * any the skip predicate rejects (ABANDONED / cooling down); tag survivors
 * `reviewOnly` and return them OLDEST-first (lowest numeric id) so the
 * longest-waiting review jobs win the per-tick cap. The caller applies the cap.
 *
 * Returns new Job objects — the input jobs are not mutated.
 */
export function selectReviewCandidates(
  found: Job[],
  translationIds: Set<string>,
  isSkippable: (jobId: string) => boolean
): Job[] {
  const out: Job[] = [];
  const seen = new Set<string>();
  for (const job of found) {
    if (translationIds.has(job.id) || seen.has(job.id) || isSkippable(job.id)) continue;
    seen.add(job.id);
    out.push({ ...job, reviewOnly: true });
  }
  out.sort((a, b) => Number(a.id) - Number(b.id));
  return out;
}
