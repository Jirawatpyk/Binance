import type { SupportedLanguage } from '../types/index.js';
import type { AssignmentSummaryItem } from '../notifications/google-chat.js';
import { formatUtcMinute } from '../core/time.js';

export type TabMap = Record<SupportedLanguage, string>;

/** Due date as "YYYY-MM-DD HH:mm UTC", or "" when unknown/invalid. */
export function formatDueCell(d?: Date | null): string {
  return !d || Number.isNaN(d.getTime()) ? '' : formatUtcMinute(d);
}

/**
 * Build the value rows per tab — each a 5-element array [Job ID, File name, Due,
 * WC, translator] — routing each assigned language to its mapped tab and
 * skipping any Job ID already present in that tab. Column placement (C..G) is
 * owned by the caller's write range, not here. Pure: existing IDs are passed in
 * (no I/O). `existingIdsByTab` is mutated to also dedup within this same batch.
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
