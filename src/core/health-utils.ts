/** Local calendar date as YYYY-MM-DD. */
export function localDateString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** True if `now` is a different local day than `todayDate` (YYYY-MM-DD). */
export function isNewDay(now: Date, todayDate: string): boolean {
  return localDateString(now) !== todayDate;
}

/**
 * True if the daily summary should be sent now: current local time is at/after
 * `summaryTime` ("HH:mm") AND it has not already been sent today (`lastSentDate`
 * is a YYYY-MM-DD string or null).
 */
export function isDailySummaryDue(
  now: Date,
  summaryTime: string,
  lastSentDate: string | null
): boolean {
  if (lastSentDate === localDateString(now)) return false;
  const [h, m] = summaryTime.split(':').map(Number);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return nowMinutes >= h * 60 + m;
}
