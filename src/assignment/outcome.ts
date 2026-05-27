import type { ProcessStatus } from '../types/index.js';

/**
 * What to do with a job's StateStore record after one processing pass.
 * Pure decision — the orchestrator maps each action to the actual state
 * mutation / logging / screenshot side effects.
 */
export type OutcomeAction =
  | 'PROCESSED' //         every attempted language assigned → mark FULL
  | 'PARTIAL' //           some assigned, some failed → mark PARTIAL (merge)
  | 'ALL_FAILED' //        none assigned, some failed → mark PARTIAL (failed only)
  | 'EMPTY_PARSE' //       no lo-LA/km-KH rows parsed at all → don't persist, retry next tick
  | 'COOLDOWN_PARTIAL' //  rows exist but none assignable AND job already PARTIAL → keep PARTIAL, cool down
  | 'COOLDOWN_FULL'; //    rows exist but none assignable AND not PARTIAL → mark FULL + cool down

export interface OutcomeInput {
  assignedCount: number; // languages assigned this pass
  failedCount: number; // languages that failed to assign this pass
  targetLanguageCount: number; // lo-LA/km-KH rows parsed on the detail page
  prevStatus?: ProcessStatus; // existing StateStore entry status, if any
}

/**
 * Classify a processing pass. Branch order mirrors the original orchestrator
 * logic: a failed assignment can only occur for a parsed target language, so
 * `failedCount > 0` implies `targetLanguageCount > 0` and the EMPTY_PARSE check
 * is safe to run before ALL_FAILED.
 */
export function classifyOutcome(i: OutcomeInput): OutcomeAction {
  if (i.failedCount === 0 && i.assignedCount > 0) return 'PROCESSED';
  if (i.assignedCount > 0) return 'PARTIAL'; // assigned some, failed some
  if (i.targetLanguageCount === 0) return 'EMPTY_PARSE'; // nothing parsed (race / claimed)
  if (i.failedCount === 0) {
    // Rows exist but none were assignable (already assigned / WAITING_REVIEW).
    return i.prevStatus === 'PARTIAL' ? 'COOLDOWN_PARTIAL' : 'COOLDOWN_FULL';
  }
  return 'ALL_FAILED'; // nothing assigned, everything attempted failed
}
