# Auto-Renew TMS Session — Design

**Date:** 2026-05-29
**Status:** Approved (design), pending implementation

## Problem

The bot authenticates with a cookie/localStorage session captured by
`npm run capture-cookies` (the TMS account has Google Authenticator 2FA, so the
bot can never log in with a password). The session's access token
(`localStorage.auth_token`) is a **12-hour JWT**. The TMS SPA refreshes it
reactively (on a 401 / near-expiry, via its own `refreshAccessToken()`), but the
bot navigates the board fresh every tick (`page.goto`), which resets the SPA's
in-app refresh timing — so the token is **never refreshed** during the bot's run
(observed: a token's `iat` stayed 10.8 h old after continuous 3-minute polling).
After 12 h the token expires, the bot pauses (`PAUSED_AUTH`), and a human must
re-run `capture-cookies`.

The session also stores an opaque **`refresh_token`** (server-tracked lifetime,
not a JWT). The TMS frontend bundle contains the exact refresh call:

```js
// POST <API_BASE>/auth/refresh, API_BASE = "/cms/i18n/tsc/admin/be" (same origin)
const res = await xs.post(`${a0e}/auth/refresh`, { refreshToken: t },
  { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
// response: { access_token, refresh_token }
//   → localStorage.auth_token  = access_token
//   → localStorage.refresh_token = refresh_token   (rotated each call)
```

It sends only `Content-Type` + `{ refreshToken }` — no `Authorization`, no
password, no 2FA. So the bot can drive this refresh itself.

## Goal

Keep the session alive automatically by calling the TMS refresh endpoint with the
stored `refresh_token` before the access token expires (and to recover after a
restart that outlasted the token), instead of pausing for a manual
`capture-cookies`. Preserve the existing `PAUSED_AUTH` + `capture-cookies` flow as
the fallback when refresh fails.

## Chosen approach

**Proactive + on-expiry (approach C).**

- **Proactive:** each tick, when the access token is within
  `reliability.reauth.refreshThresholdMin` (default 120) of expiry, call the
  refresh endpoint now — so the token never actually expires during normal
  running and the existing pre-expiry warning stays quiet.
- **On-expiry recovery:** if the token does expire (e.g. the bot was down longer
  than the token's 12 h, then restarts), `ReAuthManager` attempts one refresh
  before pausing; success resumes without human action.

### Approaches considered (and why not)

- **On-expiry only:** simpler (no threshold), recovers on restart, but lets the
  token die for up to one poll interval every 12 h and would keep firing the
  90-minute pre-expiry warning every cycle (would need suppressing). Rejected:
  the proactive path keeps the session continuously live and keeps the
  warning meaningful (it now signals "auto-renew is falling behind").
- **Proactive only:** never lets the token die while running, but a restart after
  >12 h downtime finds an expired token and pauses even though the `refresh_token`
  may still be valid. Rejected: misses the restart-recovery case.

## Architecture

One new capability on `AuthSession`, one new recovery branch in `ReAuthManager`,
and a proactive trigger in the existing tick session-maintenance block. No new
modules; the refresh runs in the browser page context so it shares the session's
origin, cookies, and `localStorage`.

### Component 1 — `AuthSession.refreshAccessToken(): Promise<boolean>`

Runs the TMS refresh in the page context and persists the result. Returns `true`
only when a new access token was stored.

```ts
async refreshAccessToken(): Promise<boolean> {
  if (!this.page) return false;
  const ok = await this.page
    .evaluate(async () => {
      try {
        const rt = window.localStorage.getItem('refresh_token');
        if (!rt) return false;
        const res = await fetch('/cms/i18n/tsc/admin/be/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: rt }),
        });
        if (!res.ok) return false;
        const data = await res.json();
        if (!data || !data.access_token) return false;
        window.localStorage.setItem('auth_token', data.access_token);
        if (data.refresh_token) window.localStorage.setItem('refresh_token', data.refresh_token);
        return true;
      } catch {
        return false;
      }
    })
    .catch(() => false);
  if (ok) {
    await this.saveSession().catch(() => {}); // persist the rotated tokens immediately
    this.logger.info('access token refreshed via refresh_token');
  } else {
    this.logger.warn('access token refresh failed (refresh_token invalid/expired or endpoint error)');
  }
  return ok;
}
```

Notes:
- The `fetch` path is **relative** (`/cms/...`), so it resolves against the
  current origin (`www.translationtms.com`) whether the page is on `/job-board`
  or `/login` — both same origin, both can read/write `localStorage`.
- **Rotation safety:** the new `auth_token` and `refresh_token` are written to
  `localStorage` *inside the page* before `saveSession()` persists the whole
  storage state to `cookies.json`. Any later `saveSession()` in the same or a
  subsequent tick therefore persists the *new* tokens — there is no stale
  overwrite. (External, out-of-bot calls to the endpoint while the bot runs are
  forbidden — they would rotate the token and then be overwritten by the bot's
  next `saveSession` with a now-invalid token.)
- `saveSession()` already bumps `lastCookieMtime`, so the post-refresh write does
  not trip the "cookies.json changed → rebuild context" check.

### Component 2 — Proactive trigger (`src/index.ts` tick maintenance block)

The block that already reads `expMs = session.getAuthExpiryMs()` and warns before
expiry gains a refresh step (gated by `reliability.reauth.autoRenew`):

- If `autoRenew` and `minsLeft <= refreshThresholdMin`: call
  `session.refreshAccessToken()`. On success, re-read `expMs`/`minsLeft` from the
  new token so the same tick's warning does not fire.
- Otherwise (token healthy): `saveSession()` as today (persists any token the app
  refreshed client-side).
- The existing `SESSION_EXPIRY_WARN_MIN` (90) warning is unchanged. With
  auto-renew working it never fires (refresh at ≤120 resets `minsLeft` to ~720).
  If refresh keeps failing, `minsLeft` falls below 90 and the warning fires — now
  meaning "auto-renew is not keeping up; manual `capture-cookies` may be needed."

### Component 3 — On-expiry recovery (`ReAuthManager`)

`ReAuthDeps` gains an optional `tryRefresh: () => Promise<boolean>`. In
`ensureReady`, when `ensureLoggedIn()` throws `LoginFailedError` (genuinely
EXPIRED after the existing probe/RETRY logic):

```ts
if (err instanceof LoginFailedError) {
  if (this.deps.tryRefresh && (await this.deps.tryRefresh())) {
    try {
      await this.deps.ensureLoggedIn(); // re-verify with the refreshed token
      if (this.state === 'PAUSED_AUTH') {
        this.state = 'AUTHED';
        await this.deps.notify('Session restored (token auto-refreshed) — resuming', 'info');
      }
      this.deps.logger.info('session recovered via token refresh');
      return true;
    } catch {
      /* refresh did not actually restore the session — fall through to pause */
    }
  }
  // pause exactly as today (PAUSED_AUTH + capture-cookies alert)
  ...
}
```

`tryRefresh` is wired in `index.ts` to `() => session.refreshAccessToken()`. The
refresh runs even though the probe left the page at `/login` (same origin →
`localStorage` + `fetch` work); the subsequent `ensureLoggedIn()` re-navigates the
board and confirms the new token.

### Component 4 — Config (`reliability.reauth`)

Two new fields, both zod-`.default()`ed so an existing `settings.yml` still loads:

```ts
reauth: z.object({
  alertOnExpiry: z.boolean(),
  autoRenew: z.boolean().default(true),          // kill-switch
  refreshThresholdMin: z.number().int().positive().default(120),
}),
```

`config/settings.example.yml` documents both. The `Settings` type gains the two
fields on `reliability.reauth`.

## Data flow

```
tick (AUTHED, near expiry):
  ... scan/assign ...
  maintenance: expMs = getAuthExpiryMs()
    minsLeft <= refreshThresholdMin (120)?
      yes → refreshAccessToken()  → page.evaluate POST /auth/refresh
              ok  → localStorage updated in-page → saveSession() → re-read expMs (fresh 12h)
              fail→ warn; existing <=90 warning will fire as it approaches expiry
      no  → saveSession() (persist any app-side refresh)

tick (token already expired, e.g. after >12h downtime restart):
  ensureReady → ensureLoggedIn() throws EXPIRED
    → tryRefresh() → refreshAccessToken()
        ok  → ensureLoggedIn() re-probe → VALID → AUTHED (resume, no human)
        fail→ PAUSED_AUTH + "run capture-cookies" alert (unchanged fallback)
```

## Error handling

- All refresh failures are caught and reduced to `false`; the bot never throws out
  of the refresh path. A failed proactive refresh is a logged `warn` and is
  retried on subsequent ticks while still inside the threshold window.
- The fallback chain is unchanged: sustained refresh failure → 90-minute warning →
  real expiry → `PAUSED_AUTH` + `capture-cookies` alert → manual recovery.
- Refresh runs only while `autoRenew` is true; setting it false reverts to the
  current warn-and-pause behavior exactly.

## Testing

- **Unit (`tests/unit/reauth-manager.test.ts`):** add cases — (a) `ensureLoggedIn`
  throws then `tryRefresh` succeeds and the re-`ensureLoggedIn` passes → returns
  `true`, state AUTHED, no pause notification; (b) `tryRefresh` returns false →
  pauses as today; (c) `tryRefresh` succeeds but the re-`ensureLoggedIn` still
  throws → pauses; (d) no `tryRefresh` provided → unchanged pause behavior.
- **Config (`tests/unit/config-loader.test.ts`):** `autoRenew`/`refreshThresholdMin`
  default when omitted; reject non-positive `refreshThresholdMin`.
- **Browser layer** (`AuthSession.refreshAccessToken` page.evaluate, the proactive
  block in `index.ts`) has no unit tests by project convention — verified live.
- **Live verification (stop the running bot first to avoid a rotation race):**
  1. Run with `autoRenew: true`; confirm a tick near expiry logs
     `access token refreshed via refresh_token` and the next `getAuthExpiryMs`
     shows a fresh ~12 h expiry (token `iat` advances).
  2. On-expiry recovery: with the bot stopped, delete `auth_token` from the
     captured session (keep `refresh_token`), start the bot, and confirm it logs
     `session recovered via token refresh` instead of pausing.

## Known constraints

- `refresh_token` is opaque and server-tracked; its total lifetime / whether the
  server caps the rotation chain is unknown. Auto-renew extends the session
  indefinitely only as long as each rotated `refresh_token` stays valid; a
  server-side absolute cap would still eventually require `capture-cookies`, but
  far less often than every 12 h. This is observable only by running it.
- The refresh endpoint and request shape are read from the current TMS frontend
  bundle; like all TMS integration points they can change and must be re-verified
  if refresh starts failing.

## Out of scope / unchanged

`classifyAuthState` probe/RETRY logic, the transient-/login handling, the
watchdog, browser recycle, and the `capture-cookies` script are all unchanged.
The password-login path remains intentionally absent (2FA).
