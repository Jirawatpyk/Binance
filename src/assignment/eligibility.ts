import type { TargetLanguage, SupportedLanguage } from '../types/index.js';

/**
 * A language row may be assigned a translator ONLY when it has no translator yet
 * AND it is specifically awaiting translation. Matching the status exactly is
 * important: the board also uses other "WAITING_*" statuses (e.g. WAITING_REVIEW)
 * that must NOT receive a translator assignment.
 */
export function isLanguageAssignable(lang: TargetLanguage): boolean {
  return lang.translator === null && lang.status === 'WAITING_TRANSLATION';
}

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
