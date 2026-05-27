/**
 * Pure date-utility helpers for the TMS job-board scraper.
 * No Playwright, no logger — safe to unit-test in isolation.
 */

/**
 * Parse a TMS "Created (UTC)" cell string into epoch ms, or null if unparseable.
 * Accepts "YYYY-MM-DD HH:mm" and "YYYY-MM-DD HH:mm:ss"; treats the time as UTC.
 */
export function parseCreatedUtc(createdStr: string): number | null {
  // Drop a trailing zone word ('... UTC' / '... GMT') the board may append, so
  // the date/time normalization below isn't defeated by it.
  const s = createdStr.trim().replace(/\s+(UTC|GMT)$/i, '');
  if (!s) return null;
  let normalized = s.replace(' ', 'T');
  // date-only "YYYY-MM-DD" -> midnight UTC
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) normalized += 'T00:00:00';
  // append seconds if missing (HH:mm -> HH:mm:00)
  if (/T\d{2}:\d{2}$/.test(normalized)) normalized += ':00';
  // append Z (UTC) only if no timezone already present
  if (!/Z$|[+-]\d{2}:\d{2}$/.test(normalized)) normalized += 'Z';
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

/** Format a Date as the board's filter input expects: "YYYY-MM-DD HH:mm:ss" (UTC). */
export function formatBoardDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}
