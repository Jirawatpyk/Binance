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
 * True if the daily summary should be sent now. Normal case: current local time
 * is at/after `summaryTime` ("HH:mm") and it hasn't been sent today
 * (`lastSentDate` is a YYYY-MM-DD string or null). Catch-up case: if a prior
 * day's summary was missed entirely (the bot wasn't running across that day's
 * window), fire on the next tick even before today's window — otherwise the
 * heartbeat liveness signal would silently skip a day after a rollover.
 */
export function isDailySummaryDue(
  now: Date,
  summaryTime: string,
  lastSentDate: string | null
): boolean {
  const today = localDateString(now);
  if (lastSentDate === today) return false;
  const [h, m] = summaryTime.split(':').map(Number);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (nowMinutes >= h * 60 + m) return true;
  // Before today's window: still due if a full prior day was skipped (so its
  // heartbeat never fired). lastSentDate === yesterday means yesterday's was
  // sent and we're just waiting for today's window — not due yet.
  const yesterday = localDateString(new Date(now.getTime() - 86_400_000));
  return lastSentDate !== null && lastSentDate < yesterday;
}
