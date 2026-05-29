export type AuthClassification = 'VALID' | 'EXPIRED' | 'RETRY';

/**
 * Classify an auth probe of the Job Board into VALID / EXPIRED / RETRY.
 *
 * The bot used to pause (PAUSED_AUTH) the moment a /login redirect or password
 * form appeared. But TMS intermittently bounces to /login during transient
 * auth-endpoint hiccups while the access token is still live — observed as
 * valid→expired→valid flaps within ~1 minute and "expired" episodes that never
 * had a preceding pre-expiry warning. Pausing on those is a false positive that
 * needs a manual restart.
 *
 * So the access token's own `exp` is the tie-breaker: a /login redirect while
 * the token is still valid is RETRY (reload and re-probe — a real dead session
 * stays at /login, a transient blip clears); a /login redirect with an
 * expired/absent token is a genuine EXPIRED. No login redirect at all is VALID
 * regardless of what we read from storage — the rendered board is authoritative.
 *
 * Note: `authExpMs` is null both when the token is truly absent and when it was
 * momentarily unreadable, so a transient that also fails the localStorage read
 * classifies EXPIRED. The caller re-probes several times before acting, so a
 * one-off unreadable read during a blip does not pause the bot on its own.
 */
export function classifyAuthState(probe: {
  loginDetected: boolean;
  authExpMs: number | null;
  now: number;
}): AuthClassification {
  if (!probe.loginDetected) return 'VALID';
  if (probe.authExpMs !== null && probe.authExpMs > probe.now) return 'RETRY';
  return 'EXPIRED';
}
