import type { TargetLanguage } from '../types/index.js';

/**
 * A language row may be assigned a translator ONLY when it has no translator yet
 * AND it is specifically awaiting translation. Matching the status exactly is
 * important: the board also uses other "WAITING_*" statuses (e.g. WAITING_REVIEW)
 * that must NOT receive a translator assignment.
 */
export function isLanguageAssignable(lang: TargetLanguage): boolean {
  return lang.translator === null && lang.status === 'WAITING_TRANSLATION';
}
