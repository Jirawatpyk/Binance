import type { SupportedLanguage } from '../types/index.js';
import type { AssignmentSummaryItem } from '../notifications/google-chat.js';

export type TabMap = Record<SupportedLanguage, string>;

/** Due date as "YYYY-MM-DD HH:mm UTC", or "" when unknown/invalid. */
export function formatDueCell(d?: Date | null): string {
  if (!d || Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/**
 * Build the rows to append per tab (columns C..G), routing each assigned
 * language to its mapped tab and skipping any Job ID already present in that
 * tab. Pure: existing IDs are passed in (no I/O). `existingIdsByTab` is mutated
 * to also dedup within this same batch.
 */
export function buildSheetRows(
  items: AssignmentSummaryItem[],
  existingIdsByTab: Record<string, Set<string>>,
  tabs: TabMap
): Record<string, string[][]> {
  const out: Record<string, string[][]> = {};
  for (const item of items) {
    for (const [lang, translator] of Object.entries(item.assigned)) {
      const tab = tabs[lang as SupportedLanguage];
      if (!tab) continue; // language with no tab mapping — skip
      const existing = (existingIdsByTab[tab] ??= new Set<string>());
      if (existing.has(item.jobId)) continue; // dedup by Job ID per tab
      (out[tab] ??= []).push([
        item.jobId,
        item.name,
        formatDueCell(item.dueDate),
        String(item.wordCount),
        translator,
      ]);
      existing.add(item.jobId);
    }
  }
  return out;
}
