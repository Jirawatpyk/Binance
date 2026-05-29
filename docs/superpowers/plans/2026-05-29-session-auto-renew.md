# TMS Session Auto-Renew Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the TMS session alive by having the bot call the `/auth/refresh` endpoint with the stored `refresh_token` (in the browser page context) before the 12h access token expires — proactively each tick near expiry, and on-expiry as restart recovery — instead of pausing for a manual `capture-cookies`.

**Architecture:** A new `AuthSession.refreshAccessToken()` runs the refresh `fetch` inside the page (same origin, reads/writes `localStorage`, persists via `saveSession`). The tick's existing session-maintenance block calls it proactively when within `refreshThresholdMin` of expiry. `ReAuthManager` gains an optional `tryRefresh` dep and attempts one refresh before pausing. Two new `reliability.reauth` config knobs (`autoRenew`, `refreshThresholdMin`) gate and tune it. The existing `PAUSED_AUTH` + `capture-cookies` flow remains the fallback.

**Tech Stack:** TypeScript (ESM, NodeNext — local imports use `.js`), Playwright, zod, winston, vitest.

**Spec:** `docs/superpowers/specs/2026-05-29-session-auto-renew-design.md`

**Branch:** `feat/session-auto-renew` (already created & checked out).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/storage/config.ts` | zod config loader | Add `autoRenew` + `refreshThresholdMin` to the `reliability.reauth` object (defaulted) |
| `src/types/index.ts` | Shared types | Add the two fields to `Settings.reliability.reauth` |
| `src/auth/session.ts` | Browser session | Add `refreshAccessToken(): Promise<boolean>` (page-context refresh + persist) |
| `src/auth/reauth-manager.ts` | Auth pause/resume | Add optional `tryRefresh` dep + recover-before-pause branch |
| `src/index.ts` | Tick orchestration | Proactive refresh in the maintenance block; wire `tryRefresh` into `ReAuthManager` |
| `config/settings.example.yml` | Committed config template | Document the two new fields |
| `tests/unit/config-loader.test.ts` | Config tests | Defaults + reject-non-positive |
| `tests/unit/reauth-manager.test.ts` | ReAuthManager tests | Recovery + pause-on-refresh-fail cases |

`src/auth/session.ts` and `src/index.ts` are browser/orchestration layer with **no unit tests by project convention** (CLAUDE.md) — gated by `npm run typecheck` and verified live in Task 6. `ReAuthManager` and the config loader are pure and unit-tested.

---

## Task 1: Config — `reliability.reauth.autoRenew` + `refreshThresholdMin`

**Files:**
- Modify: `src/storage/config.ts` (the `reauth` zod object)
- Modify: `src/types/index.ts` (`Settings.reliability.reauth`)
- Test: `tests/unit/config-loader.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these two tests inside the existing `describe('loadSettings', ...)` block in `tests/unit/config-loader.test.ts` (after the last `loadSettings` test, before the `describe('loadTranslators'` block):

```ts
  it('defaults reliability.reauth.autoRenew (true) and refreshThresholdMin (120) when omitted', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
`);
    const s = loadSettings(p);
    expect(s.reliability.reauth.autoRenew).toBe(true);
    expect(s.reliability.reauth.refreshThresholdMin).toBe(120);
  });

  it('rejects a non-positive reliability.reauth.refreshThresholdMin', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true, refreshThresholdMin: 0 }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
`);
    expect(() => loadSettings(p)).toThrow();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/config-loader.test.ts -t "reauth.autoRenew"`
Expected: the defaults test FAILS (`s.reliability.reauth.autoRenew` is `undefined`).

- [ ] **Step 3: Add the fields to the zod schema**

In `src/storage/config.ts`, find:

```ts
    reauth: z.object({ alertOnExpiry: z.boolean() }),
```

and replace it with:

```ts
    reauth: z.object({
      alertOnExpiry: z.boolean(),
      // Auto-renew the TMS access token via the stored refresh_token instead of
      // pausing for a manual capture-cookies. Defaulted so an existing
      // settings.yml still loads (and existing deployments get the feature).
      autoRenew: z.boolean().default(true),
      // Refresh proactively once the access token is within this many minutes of
      // expiry (the access token lives ~12h).
      refreshThresholdMin: z.number().int().positive().default(120),
    }),
```

- [ ] **Step 4: Add the fields to the `Settings` type**

In `src/types/index.ts`, find:

```ts
    reauth: { alertOnExpiry: boolean };
```

and replace it with:

```ts
    reauth: { alertOnExpiry: boolean; autoRenew: boolean; refreshThresholdMin: number };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/config-loader.test.ts`
Expected: PASS (existing reliability tests still pass; the 2 new ones pass).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/storage/config.ts src/types/index.ts tests/unit/config-loader.test.ts
git commit -m "feat(config): add reliability.reauth.autoRenew + refreshThresholdMin (defaulted)"
```

---

## Task 2: `AuthSession.refreshAccessToken()`

**Files:**
- Modify: `src/auth/session.ts`

No unit test (browser layer, per CLAUDE.md). Gated by `npm run typecheck` and the existing suite; behavior verified live in Task 6.

- [ ] **Step 1: Add the method**

In `src/auth/session.ts`, add this method to the `AuthSession` class, immediately AFTER the existing `saveSession()` method (after its closing `}`):

```ts
  /**
   * Renew the access token by calling the TMS refresh endpoint with the stored
   * refresh_token, FROM THE PAGE CONTEXT (same origin, so localStorage + the
   * relative /cms/... fetch both work, whether the page is on the board or
   * /login). On success the new access_token + rotated refresh_token are written
   * to localStorage and persisted to cookies.json immediately — so a later
   * saveSession this tick can only persist the NEW tokens (no stale overwrite).
   * Returns true only when a new access token was stored. Never throws.
   */
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
      await this.saveSession().catch(() => {});
      this.logger.info('access token refreshed via refresh_token');
    } else {
      this.logger.warn('access token refresh failed (refresh_token invalid/expired or endpoint error)');
    }
    return ok;
  }
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run the full unit suite (no regression)**

Run: `npm test`
Expected: PASS (unchanged count — this method has no unit test).

- [ ] **Step 4: Commit**

```bash
git add src/auth/session.ts
git commit -m "feat(auth): add AuthSession.refreshAccessToken() (page-context token refresh)"
```

---

## Task 3: `ReAuthManager` recover-before-pause

**Files:**
- Modify: `src/auth/reauth-manager.ts`
- Test: `tests/unit/reauth-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these three tests inside the existing `describe('ReAuthManager.ensureReady', ...)` block in `tests/unit/reauth-manager.test.ts` (after the existing tests, before the closing `});`):

```ts
  it('recovers via tryRefresh without pausing when refresh restores the session', async () => {
    let calls = 0;
    const ensureLoggedIn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new LoginFailedError('expired');
      // second call (post-refresh re-verify) succeeds
    });
    const tryRefresh = vi.fn(async () => true);
    const notify = vi.fn(async () => {});
    const onPause = vi.fn();
    const mgr = new ReAuthManager({ ensureLoggedIn, notify, logger: noopLogger, onPause, tryRefresh });
    expect(await mgr.ensureReady()).toBe(true);
    expect(mgr.authState).toBe('AUTHED');
    expect(tryRefresh).toHaveBeenCalledTimes(1);
    expect(ensureLoggedIn).toHaveBeenCalledTimes(2); // initial throw + re-verify
    expect(onPause).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled(); // was AUTHED, not paused → no restore notice
  });

  it('pauses when tryRefresh fails', async () => {
    const ensureLoggedIn = vi.fn(async () => { throw new LoginFailedError('expired'); });
    const tryRefresh = vi.fn(async () => false);
    const notify = vi.fn(async () => {});
    const onPause = vi.fn();
    const mgr = new ReAuthManager({ ensureLoggedIn, notify, logger: noopLogger, onPause, tryRefresh });
    expect(await mgr.ensureReady()).toBe(false);
    expect(mgr.authState).toBe('PAUSED_AUTH');
    expect(tryRefresh).toHaveBeenCalledTimes(1);
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('pauses when tryRefresh succeeds but the re-verify still fails', async () => {
    const ensureLoggedIn = vi.fn(async () => { throw new LoginFailedError('expired'); });
    const tryRefresh = vi.fn(async () => true);
    const onPause = vi.fn();
    const mgr = new ReAuthManager({ ensureLoggedIn, notify: vi.fn(async () => {}), logger: noopLogger, onPause, tryRefresh });
    expect(await mgr.ensureReady()).toBe(false);
    expect(mgr.authState).toBe('PAUSED_AUTH');
    expect(ensureLoggedIn).toHaveBeenCalledTimes(2); // initial + re-verify, both throw
    expect(onPause).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/reauth-manager.test.ts -t "tryRefresh"`
Expected: FAIL — `tryRefresh` is not a known dep / the recovery path doesn't exist, so the manager pauses instead of recovering (first test fails: expects `true`/AUTHED but gets `false`/PAUSED_AUTH).

- [ ] **Step 3: Add the `tryRefresh` dep + recovery branch**

In `src/auth/reauth-manager.ts`, replace the `ReAuthDeps` interface:

```ts
export interface ReAuthDeps {
  /** Throws LoginFailedError when the session is expired/absent. */
  ensureLoggedIn: () => Promise<void>;
  /** Fire-and-forget notification (never throws). */
  notify: (text: string, severity: 'info' | 'warn' | 'error') => Promise<void>;
  logger: winston.Logger;
  /** Called once when transitioning AUTHED -> PAUSED_AUTH (e.g., health metric). */
  onPause?: () => void;
}
```

with:

```ts
export interface ReAuthDeps {
  /** Throws LoginFailedError when the session is expired/absent. */
  ensureLoggedIn: () => Promise<void>;
  /** Fire-and-forget notification (never throws). */
  notify: (text: string, severity: 'info' | 'warn' | 'error') => Promise<void>;
  logger: winston.Logger;
  /** Called once when transitioning AUTHED -> PAUSED_AUTH (e.g., health metric). */
  onPause?: () => void;
  /** Optional: try to auto-renew the session (returns true on success). Attempted
   *  once before pausing, to recover a session that expired while the bot was down. */
  tryRefresh?: () => Promise<boolean>;
}
```

Then replace the `catch` block in `ensureReady`:

```ts
    } catch (err) {
      if (err instanceof LoginFailedError) {
        if (this.state === 'AUTHED') {
          this.state = 'PAUSED_AUTH';
          this.deps.onPause?.();
          this.deps.logger.warn('session expired; pausing until cookies refreshed');
          await this.deps.notify(
            'Session expired — run `npm run capture-cookies` on the host to resume',
            'error'
          );
        }
        return false;
      }
      throw err;
    }
```

with:

```ts
    } catch (err) {
      if (err instanceof LoginFailedError) {
        // Before pausing, try to auto-renew (recovers a session that expired
        // while the bot was down, without a manual capture-cookies).
        if (this.deps.tryRefresh && (await this.deps.tryRefresh())) {
          try {
            await this.deps.ensureLoggedIn(); // re-verify with the refreshed token
            const wasPaused = this.state === 'PAUSED_AUTH';
            this.state = 'AUTHED';
            this.deps.logger.info('session recovered via token refresh');
            if (wasPaused) await this.deps.notify('Session restored (token auto-refreshed) — resuming', 'info');
            return true;
          } catch {
            // refresh did not actually restore a working session — fall through to pause
          }
        }
        if (this.state === 'AUTHED') {
          this.state = 'PAUSED_AUTH';
          this.deps.onPause?.();
          this.deps.logger.warn('session expired; pausing until cookies refreshed');
          await this.deps.notify(
            'Session expired — run `npm run capture-cookies` on the host to resume',
            'error'
          );
        }
        return false;
      }
      throw err;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/reauth-manager.test.ts`
Expected: PASS — all existing tests (including "pauses and alerts once on session expiry", which uses no `tryRefresh` dep) still pass, plus the 3 new ones.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/auth/reauth-manager.ts tests/unit/reauth-manager.test.ts
git commit -m "feat(auth): ReAuthManager tries token refresh before pausing"
```

---

## Task 4: Wire auto-renew into the tick (`src/index.ts`)

**Files:**
- Modify: `src/index.ts`

No unit test (orchestration layer). Gated by `npm run typecheck` + the existing suite.

- [ ] **Step 1: Pass `tryRefresh` into the `ReAuthManager` constructor**

In `src/index.ts`, find the `new ReAuthManager({ ... })` call:

```ts
  const reauth = new ReAuthManager({
    ensureLoggedIn: () => session.ensureLoggedIn(),
    notify: settings.reliability.reauth.alertOnExpiry
      ? (t, s) => diagNotifier.notify(t, s)
      : async () => {},
    logger,
    onPause: () => health.recordAuthEpisode(),
  });
```

and replace it with:

```ts
  const reauth = new ReAuthManager({
    ensureLoggedIn: () => session.ensureLoggedIn(),
    notify: settings.reliability.reauth.alertOnExpiry
      ? (t, s) => diagNotifier.notify(t, s)
      : async () => {},
    logger,
    onPause: () => health.recordAuthEpisode(),
    // Auto-renew before giving up: recovers a session that expired while the bot
    // was down (refresh_token still valid). Gated by the autoRenew config knob.
    tryRefresh: settings.reliability.reauth.autoRenew ? () => session.refreshAccessToken() : undefined,
  });
```

- [ ] **Step 2: Add the proactive refresh to the session-maintenance block**

In `src/index.ts`, find this block (the access-token maintenance inside the tick's `try`):

```ts
      const expMs = await session.getAuthExpiryMs().catch((e) => {
        logger.debug('reading auth token expiry failed', { error: (e as Error).message });
        return null;
      });
```

and change `const expMs` to `let expMs` (so it can be updated after a refresh):

```ts
      let expMs = await session.getAuthExpiryMs().catch((e) => {
        logger.debug('reading auth token expiry failed', { error: (e as Error).message });
        return null;
      });
```

Then, in the same block, find:

```ts
      } else {
        expiryReadFailedAlerted = false; // recovered — re-arm

        // Persist only when the token is live, so we never overwrite the
        // last-known-good cookies.json with a dead/unparseable snapshot. A
        // single failure is swallowed; a sustained one is alerted (it silently
        // reintroduces the stale-snapshot bug this save exists to prevent).
        if (expMs > Date.now()) {
          try {
            await session.saveSession();
            consecutiveSaveFailures = 0;
          } catch (e) {
```

and replace it with (insert the proactive-refresh block and gate the persist on `!refreshed`):

```ts
      } else {
        expiryReadFailedAlerted = false; // recovered — re-arm

        // Proactive auto-renew: when the access token is within
        // refreshThresholdMin of expiry, renew it now so the session never dies.
        // refreshAccessToken persists the rotated tokens itself (so skip the
        // saveSession below on success). On success, re-read the expiry so this
        // tick's pre-expiry warning sees the fresh token and stays quiet.
        let refreshed = false;
        if (
          settings.reliability.reauth.autoRenew &&
          (expMs - Date.now()) / 60_000 <= settings.reliability.reauth.refreshThresholdMin
        ) {
          refreshed = await session.refreshAccessToken();
          if (refreshed) {
            const newExp = await session.getAuthExpiryMs().catch(() => null);
            if (newExp !== null) expMs = newExp;
          }
        }

        // Persist only when the token is live AND we didn't just refresh+persist.
        // A single failure is swallowed; a sustained one is alerted (it silently
        // reintroduces the stale-snapshot bug this save exists to prevent).
        if (!refreshed && expMs > Date.now()) {
          try {
            await session.saveSession();
            consecutiveSaveFailures = 0;
          } catch (e) {
```

(The rest of the `catch (e) { ... }` for the save failure and the `minsLeft` warning block below it are unchanged — `minsLeft` is computed from the possibly-updated `expMs`, so a successful refresh keeps the 90-minute warning quiet.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`settings.reliability.reauth.autoRenew` / `refreshThresholdMin` exist from Task 1; `session.refreshAccessToken` from Task 2; `tryRefresh` dep from Task 3.)

- [ ] **Step 4: Run the full unit suite**

Run: `npm test`
Expected: PASS (unchanged count — orchestration is not unit-tested).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): proactive token auto-renew + wire ReAuthManager.tryRefresh"
```

---

## Task 5: Document the new config in the committed example

**Files:**
- Modify: `config/settings.example.yml` (the `reliability.reauth` block)

- [ ] **Step 1: Update the example reauth block**

In `config/settings.example.yml`, find:

```yaml
  reauth:
    alertOnExpiry: true
```

and replace it with:

```yaml
  reauth:
    alertOnExpiry: true
    # Auto-renew the TMS access token via the stored refresh_token (no manual
    # capture-cookies) — proactively near expiry and on-expiry after a restart.
    # Set false to revert to warn-and-pause. Default true.
    autoRenew: true
    # Refresh once the access token is within this many minutes of expiry
    # (token lives ~12h). Default 120.
    refreshThresholdMin: 120
```

- [ ] **Step 2: Verify the example still parses**

Run: `npx tsx -e "import {loadSettings} from './src/storage/config.js'; const s=loadSettings('./config/settings.example.yml'); console.log(s.reliability.reauth);"`
Expected: prints `{ alertOnExpiry: true, autoRenew: true, refreshThresholdMin: 120 }`.

- [ ] **Step 3: Commit**

```bash
git add config/settings.example.yml
git commit -m "docs(config): document reliability.reauth.autoRenew + refreshThresholdMin"
```

---

## Task 6: Live verification (operator-run)

**Files:** none. Run by the operator — **stop any running bot first** so an out-of-bot rotation cannot race the running bot's `saveSession`.

**Preconditions:** fresh `data/cookies.json` (`npm run capture-cookies` if stale); `config/settings.yml` has `reliability.reauth.autoRenew: true` (add it, or rely on the default).

- [ ] **Step 1: Static gates**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all unit tests pass.

- [ ] **Step 2: Proactive refresh (fast check via a high threshold)**

Temporarily set `reliability.reauth.refreshThresholdMin` to a value larger than the token's current remaining life (e.g. `1000`) so the very next tick triggers a refresh, then `npm run dev`. In `logs/app-*.log` confirm:
- `access token refreshed via refresh_token`
- the following `scan window` / next-tick expiry read reflects a fresh ~12h token (the warning does NOT fire).
Then restore `refreshThresholdMin` to `120` and `Ctrl+C`.

- [ ] **Step 3: On-expiry recovery**

With the bot stopped: in `data/cookies.json`, delete the `auth_token` entry from `localStorage` (keep `refresh_token`), then `npm run dev`. Confirm the log shows `session recovered via token refresh` (and NOT `session expired; pausing`). `Ctrl+C`.

- [ ] **Step 4: Restart the production bot**

Restart the bot normally (`npm run dev` or the Windows service) with `refreshThresholdMin: 120`, `autoRenew: true`. Over the following hours confirm no `PAUSED_AUTH` / `capture-cookies` alert fires and that a refresh log appears ~once per ~10h.

---

## Task 7: Finish the branch

- [ ] **Step 1: Final gates**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin feat/session-auto-renew
gh pr create --title "TMS session auto-renew (no manual capture-cookies)" --body "$(cat <<'EOF'
## Summary
- Bot calls the TMS /auth/refresh endpoint with the stored refresh_token (in page context) to renew the 12h access token — proactively near expiry and on-expiry as restart recovery — instead of pausing for a manual capture-cookies.
- New `AuthSession.refreshAccessToken()`; `ReAuthManager` tries refresh before pausing; proactive refresh in the tick maintenance block.
- New `reliability.reauth.autoRenew` (default true) + `refreshThresholdMin` (default 120), both zod-defaulted. Existing PAUSED_AUTH + capture-cookies remains the fallback.

## Test plan
- [ ] `npm run typecheck` clean
- [ ] `npm test` green (new: reauth-manager recovery/pause cases, config defaults)
- [ ] Live: proactive refresh logs `access token refreshed via refresh_token`, token exp advances, 90m warning stays quiet
- [ ] Live: deleting auth_token (keeping refresh_token) → `session recovered via token refresh`, no pause
EOF
)"
```

Then follow the established review/merge workflow.

---

## Self-Review

**Spec coverage:**
- `AuthSession.refreshAccessToken()` page-context refresh + persist → Task 2. ✓
- Proactive trigger near expiry (`refreshThresholdMin`) → Task 4 Step 2. ✓
- On-expiry recovery via `tryRefresh` in `ReAuthManager` → Task 3 + Task 4 Step 1. ✓
- `autoRenew` kill-switch + `refreshThresholdMin` config (zod-defaulted) → Task 1; example → Task 5. ✓
- 90-minute warning unchanged, fires only when refresh falls behind → Task 4 Step 2 keeps the existing warning block, computing `minsLeft` from the refreshed `expMs`. ✓
- Fallback PAUSED_AUTH + capture-cookies unchanged → Task 3 keeps the pause branch. ✓
- Rotation safety (in-page write then persist; skip redundant save) → Task 2 (`saveSession` inside) + Task 4 (`!refreshed` gate). ✓
- Testing: reauth-manager recovery/pause + config defaults (unit); browser layer live → Tasks 1, 3, 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows the full before/after; commands have expected output. ✓

**Type consistency:** `refreshAccessToken(): Promise<boolean>` defined in Task 2, consumed in Task 3 (`tryRefresh`) and Task 4 (proactive + ctor wiring). `tryRefresh?: () => Promise<boolean>` defined in Task 3 `ReAuthDeps`, supplied in Task 4 Step 1. `settings.reliability.reauth.autoRenew` / `refreshThresholdMin` defined in Task 1 (zod + type), consumed in Task 4. `expMs` changed to `let` in Task 4 Step 2 before reassignment. ✓
