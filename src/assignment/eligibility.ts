import type { TargetLanguage, SupportedLanguage } from '../types/index.js';

export type AssignRole = 'translator' | 'reviewer';

/**
 * What role (if any) a language row currently needs assigned. A row awaits a
 * translator (WAITING_TRANSLATION, no translator) or — once translated — a
 * reviewer (WAITING_REVIEW, no reviewer) but only for languages that have a
 * reviewer configured. Any other state yields null (skip). `reviewers` is the
 * configured per-language reviewer map, or undefined when review is disabled.
 */
export function pendingRole(
  lang: TargetLanguage,
  reviewers: Partial<Record<SupportedLanguage, string>> | undefined
): AssignRole | null {
  if (lang.status === 'WAITING_TRANSLATION' && lang.translator === null) return 'translator';
  if (lang.status === 'WAITING_REVIEW' && lang.reviewer === null && reviewers?.[lang.code]) {
    return 'reviewer';
  }
  return null;
}

/**
 * May this role be assigned to this candidate? A `reviewOnly` candidate was
 * surfaced by the decoupled review scan AND is genuinely aged (created before the
 * translation window), so only its reviewer may be assigned — assigning a
 * translator would defeat the scan.lookbackHours backlog guard. A fresh job the
 * translation scan merely missed is surfaced with reviewOnly=false and allows any
 * role; normal translation candidates likewise allow any role.
 */
export function canAssignRole(reviewOnly: boolean | undefined, role: AssignRole): boolean {
  return !reviewOnly || role === 'reviewer';
}
