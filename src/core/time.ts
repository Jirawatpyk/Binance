/** "YYYY-MM-DD HH:mm UTC" for a valid Date — the shared timestamp format for
 *  both the Google Chat cards and the assignment Sheet, so the two never drift. */
export function formatUtcMinute(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
