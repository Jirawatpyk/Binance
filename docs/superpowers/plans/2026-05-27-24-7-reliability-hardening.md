# 24/7 Reliability Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Translation TMS Auto-Assign Bot run unattended 24/7 by adding graceful session-expiry handling (pause + alert + auto-resume), hang detection (watchdog self-exit → service restart), browser-crash self-recovery, health monitoring with daily summaries, and hardened Windows-service supervision.

**Architecture:** Five protection layers over the existing Phase-1 bot. New pure-logic modules (`health-utils`, `recovery-utils`, `watchdog`) are unit-tested; new stateful modules (`HealthMonitor`, `ReAuthManager`) are unit-tested with stubs/temp files; browser/process glue (`AuthSession.recover`, `index.ts` wiring, service script) is typecheck + dry-run verified. Nothing in Phase 1 is rearchitected — components are added and wired into the existing tick.

**Tech Stack:** Node 20+, TypeScript (ESM, NodeNext), Playwright, winston, zod, vitest, node-windows.

**Spec:** `docs/superpowers/specs/2026-05-27-24-7-reliability-hardening-design.md`

---

## File Structure

| File | Responsibility | New/Modify |
|------|----------------|------------|
| `src/types/index.ts` | add `Settings.reliability` shape | Modify |
| `src/storage/config.ts` | zod schema for `reliability` | Modify |
| `config/settings.example.yml` | `reliability:` block | Modify |
| `config/settings.yml` | `reliability:` block (gitignored working copy) | Modify |
| `tests/unit/config-loader.test.ts` | add `reliability:` to fixtures | Modify |
| `src/core/health-utils.ts` | pure date/summary helpers | Create |
| `src/core/recovery-utils.ts` | pure `isBrowserDeadError` | Create |
| `src/core/watchdog.ts` | `runWithWatchdog` hang guard | Create |
| `src/core/health-monitor.ts` | metrics + persistence + summary | Create |
| `src/auth/reauth-manager.ts` | auth state machine (pause/resume) | Create |
| `src/auth/session.ts` | `isAlive()`, `recover()` | Modify |
| `src/index.ts` | wire all five layers into the tick | Modify |
| `scripts/install-windows-service.js` | restart/boot options | Modify |
| `README.md` | 24/7 host setup (powercfg) | Modify |
| `tests/unit/health-utils.test.ts` | tests | Create |
| `tests/unit/recovery-utils.test.ts` | tests | Create |
| `tests/unit/watchdog.test.ts` | tests | Create |
| `tests/unit/health-monitor.test.ts` | tests | Create |
| `tests/unit/reauth-manager.test.ts` | tests | Create |

Runtime (gitignored): `data/health.json`.

---

## Prerequisites

- Repo at `C:\Users\Jirawat.p\Documents\Binance`, on branch `master`, deps installed.
- Baseline green: `npm run typecheck` (exit 0), `npm test` (22 tests pass), `npm run build` (exit 0).
- All commands are PowerShell from the repo root.

---

## Task 1: Config — `reliability` settings

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/storage/config.ts`
- Modify: `config/settings.example.yml`
- Modify: `config/settings.yml`
- Modify: `tests/unit/config-loader.test.ts`

- [ ] **Step 1.1: Extend the `Settings` interface**

In `src/types/index.ts`, the `Settings` interface currently ends with the `logging` line. Add a `reliability` member. Replace:
```typescript
  logging: { level: 'debug' | 'info' | 'warn' | 'error'; rotateDays: number };
}
```
with:
```typescript
  logging: { level: 'debug' | 'info' | 'warn' | 'error'; rotateDays: number };
  reliability: {
    watchdog: { tickTimeoutMs: number };
    reauth: { alertOnExpiry: boolean };
    monitoring: { dailySummaryTime: string; consecutiveErrorAlert: number };
  };
}
```

- [ ] **Step 1.2: Extend the zod schema**

In `src/storage/config.ts`, the `settingsSchema` ends with the `logging` object. Add `reliability` after it. Replace:
```typescript
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']),
    rotateDays: z.number().positive(),
  }),
});
```
with:
```typescript
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']),
    rotateDays: z.number().positive(),
  }),
  reliability: z.object({
    watchdog: z.object({ tickTimeoutMs: z.number().int().positive() }),
    reauth: z.object({ alertOnExpiry: z.boolean() }),
    monitoring: z.object({
      dailySummaryTime: z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:mm'),
      consecutiveErrorAlert: z.number().int().positive(),
    }),
  }),
});
```

- [ ] **Step 1.3: Add the block to both yml files**

Append to BOTH `config/settings.example.yml` AND `config/settings.yml`:
```yaml
reliability:
  watchdog:
    tickTimeoutMs: 600000        # 10 min — above max real tick (~7 min at 50 jobs); longer = hang
  reauth:
    alertOnExpiry: true
  monitoring:
    dailySummaryTime: "09:00"    # local time
    consecutiveErrorAlert: 3     # consecutive failing ticks before alerting
```

- [ ] **Step 1.4: Update config-loader test fixtures**

In `tests/unit/config-loader.test.ts`, every `loadSettings` fixture string must include a `reliability` block or the (now-required) schema field will fail to parse. There are multiple fixtures (the valid one and the invalid-level one, at minimum). To each settings YAML fixture passed to `loadSettings`, add this line (after the `logging:` line):
```
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 } }
```
Then in the "parses valid settings yaml" test, add an assertion:
```typescript
expect(s.reliability.watchdog.tickTimeoutMs).toBe(600000);
expect(s.reliability.monitoring.dailySummaryTime).toBe('09:00');
```

- [ ] **Step 1.5: Verify**

Run: `npm run typecheck`
Expected: exit 0.
Run: `npm test`
Expected: all tests pass (the fixtures now satisfy the schema).

- [ ] **Step 1.6: Commit**

```powershell
git add src/types/index.ts src/storage/config.ts config/settings.example.yml tests/unit/config-loader.test.ts
git commit -m "feat(config): add reliability settings (watchdog, reauth, monitoring)"
```
(`config/settings.yml` is gitignored — not staged.)

---

## Task 2: `health-utils.ts` (pure, TDD)

**Files:**
- Create: `tests/unit/health-utils.test.ts`
- Create: `src/core/health-utils.ts`

- [ ] **Step 2.1: Write the failing test**

`tests/unit/health-utils.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { localDateString, isNewDay, isDailySummaryDue } from '../../src/core/health-utils.js';

describe('localDateString', () => {
  it('formats local date as YYYY-MM-DD', () => {
    expect(localDateString(new Date(2026, 4, 7, 13, 5))).toBe('2026-05-07');
  });
});

describe('isNewDay', () => {
  it('true when calendar day differs', () => {
    expect(isNewDay(new Date(2026, 4, 8, 0, 1), '2026-05-07')).toBe(true);
  });
  it('false when same day', () => {
    expect(isNewDay(new Date(2026, 4, 7, 23, 59), '2026-05-07')).toBe(false);
  });
});

describe('isDailySummaryDue', () => {
  it('due when now past time and not sent today', () => {
    expect(isDailySummaryDue(new Date(2026, 4, 7, 9, 30), '09:00', null)).toBe(true);
  });
  it('not due before the time', () => {
    expect(isDailySummaryDue(new Date(2026, 4, 7, 8, 59), '09:00', null)).toBe(false);
  });
  it('not due when already sent today', () => {
    expect(isDailySummaryDue(new Date(2026, 4, 7, 10, 0), '09:00', '2026-05-07')).toBe(false);
  });
  it('due again the next day after past sent date', () => {
    expect(isDailySummaryDue(new Date(2026, 4, 8, 9, 1), '09:00', '2026-05-07')).toBe(true);
  });
});
```

- [ ] **Step 2.2: Run to verify it fails**

Run: `npx vitest run tests/unit/health-utils.test.ts`
Expected: FAIL — module `health-utils.js` not found.

- [ ] **Step 2.3: Implement**

`src/core/health-utils.ts`:
```typescript
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
```

- [ ] **Step 2.4: Run to verify it passes**

Run: `npx vitest run tests/unit/health-utils.test.ts`
Expected: PASS (7 assertions across the cases).

- [ ] **Step 2.5: Commit**

```powershell
git add src/core/health-utils.ts tests/unit/health-utils.test.ts
git commit -m "feat(core): add pure health-utils (date + daily-summary scheduling)"
```

---

## Task 3: `recovery-utils.ts` (pure, TDD)

**Files:**
- Create: `tests/unit/recovery-utils.test.ts`
- Create: `src/core/recovery-utils.ts`

- [ ] **Step 3.1: Write the failing test**

`tests/unit/recovery-utils.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { isBrowserDeadError } from '../../src/core/recovery-utils.js';

describe('isBrowserDeadError', () => {
  it('detects "Target closed"', () => {
    expect(isBrowserDeadError(new Error('Target closed'))).toBe(true);
  });
  it('detects "Target page, context or browser has been closed"', () => {
    expect(isBrowserDeadError(new Error('Target page, context or browser has been closed'))).toBe(true);
  });
  it('detects "Browser has been closed"', () => {
    expect(isBrowserDeadError(new Error('Browser has been closed'))).toBe(true);
  });
  it('false for an ordinary error', () => {
    expect(isBrowserDeadError(new Error('TranslatorNotFoundError: x not in popup'))).toBe(false);
  });
  it('false for non-Error input', () => {
    expect(isBrowserDeadError('nope')).toBe(false);
    expect(isBrowserDeadError(undefined)).toBe(false);
  });
});
```

- [ ] **Step 3.2: Run to verify it fails**

Run: `npx vitest run tests/unit/recovery-utils.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3.3: Implement**

`src/core/recovery-utils.ts`:
```typescript
/** True if the error indicates the Playwright browser/page/context died and needs relaunch. */
export function isBrowserDeadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : '';
  return /target closed|target page, context or browser has been closed|browser has been closed|browsercontext.*closed/i.test(
    msg
  );
}
```

- [ ] **Step 3.4: Run to verify it passes**

Run: `npx vitest run tests/unit/recovery-utils.test.ts`
Expected: PASS.

- [ ] **Step 3.5: Commit**

```powershell
git add src/core/recovery-utils.ts tests/unit/recovery-utils.test.ts
git commit -m "feat(core): add isBrowserDeadError detector"
```

---

## Task 4: `watchdog.ts` (TDD with fake timers)

**Files:**
- Create: `tests/unit/watchdog.test.ts`
- Create: `src/core/watchdog.ts`

- [ ] **Step 4.1: Write the failing test**

`tests/unit/watchdog.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWithWatchdog } from '../../src/core/watchdog.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('runWithWatchdog', () => {
  it('returns the value and does not call onTimeout when fn settles in time', async () => {
    const onTimeout = vi.fn();
    const p = runWithWatchdog(async () => 'ok', 1000, onTimeout);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('ok');
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('calls onTimeout and rejects when fn exceeds the timeout', async () => {
    const onTimeout = vi.fn();
    const p = runWithWatchdog(
      () => new Promise<string>(() => { /* never resolves */ }),
      1000,
      onTimeout
    );
    const assertion = expect(p).rejects.toThrow(/watchdog timeout/i);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 4.2: Run to verify it fails**

Run: `npx vitest run tests/unit/watchdog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement**

`src/core/watchdog.ts`:
```typescript
/**
 * Run `fn` with a hang-detection timeout. If `fn` has not settled within
 * `timeoutMs`, `onTimeout` is invoked (callers typically log + process.exit) and
 * the returned promise rejects. If `fn` settles first, its result is returned and
 * the timer is cleared.
 */
export async function runWithWatchdog<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`watchdog timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

- [ ] **Step 4.4: Run to verify it passes**

Run: `npx vitest run tests/unit/watchdog.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4.5: Commit**

```powershell
git add src/core/watchdog.ts tests/unit/watchdog.test.ts
git commit -m "feat(core): add runWithwatchdog hang guard"
```

---

## Task 5: `health-monitor.ts` (TDD)

**Files:**
- Create: `tests/unit/health-monitor.test.ts`
- Create: `src/core/health-monitor.ts`

- [ ] **Step 5.1: Write the failing test**

`tests/unit/health-monitor.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { HealthMonitor } from '../../src/core/health-monitor.js';

function newMonitor(now: Date) {
  const dir = mkdtempSync(path.join(tmpdir(), 'health-'));
  const file = path.join(dir, 'health.json');
  return { monitor: new HealthMonitor(file, now), file };
}

describe('HealthMonitor', () => {
  it('counts assignments and failures for today', async () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    await monitor.load();
    monitor.recordAssignment(true);
    monitor.recordAssignment(true);
    monitor.recordAssignment(false);
    expect(monitor.snapshot().today.assigned).toBe(2);
    expect(monitor.snapshot().today.failed).toBe(1);
  });

  it('resets consecutiveErrors on success and increments on error', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    monitor.recordTickError();
    monitor.recordTickError();
    expect(monitor.snapshot().consecutiveErrors).toBe(2);
    monitor.recordTickSuccess();
    expect(monitor.snapshot().consecutiveErrors).toBe(0);
  });

  it('shouldAlertErrorRate fires exactly when reaching threshold', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    monitor.recordTickError();
    expect(monitor.shouldAlertErrorRate(3)).toBe(false);
    monitor.recordTickError();
    expect(monitor.shouldAlertErrorRate(3)).toBe(false);
    monitor.recordTickError();
    expect(monitor.shouldAlertErrorRate(3)).toBe(true); // exactly 3
    monitor.recordTickError();
    expect(monitor.shouldAlertErrorRate(3)).toBe(false); // 4 — already alerted
  });

  it('rolls over counters on a new day', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    monitor.recordAssignment(true);
    monitor.recordTickStart(new Date(2026, 4, 8, 0, 5)); // next day
    expect(monitor.snapshot().today.assigned).toBe(0);
    expect(monitor.snapshot().today.date).toBe('2026-05-08');
  });

  it('persists and reloads', async () => {
    const { monitor, file } = newMonitor(new Date(2026, 4, 7, 8, 0));
    await monitor.load();
    monitor.recordAssignment(true);
    monitor.markDailySummarySent(new Date(2026, 4, 7, 9, 0));
    await monitor.save();

    const m2 = new HealthMonitor(file, new Date(2026, 4, 7, 10, 0));
    await m2.load();
    expect(m2.snapshot().today.assigned).toBe(1);
    expect(m2.isDailySummaryDue(new Date(2026, 4, 7, 10, 0), '09:00')).toBe(false);
  });

  it('buildDailySummary includes counts', () => {
    const { monitor } = newMonitor(new Date(2026, 4, 7, 8, 0));
    monitor.recordAssignment(true);
    monitor.recordAuthEpisode();
    const text = monitor.buildDailySummary(new Date(2026, 4, 7, 9, 0));
    expect(text).toMatch(/assigned/i);
    expect(text).toContain('1');
  });
});
```

- [ ] **Step 5.2: Run to verify it fails**

Run: `npx vitest run tests/unit/health-monitor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5.3: Implement**

`src/core/health-monitor.ts`:
```typescript
import { promises as fs } from 'fs';
import path from 'path';
import { localDateString, isNewDay, isDailySummaryDue } from './health-utils.js';

interface TodayCounters {
  date: string;
  assigned: number;
  failed: number;
  authEpisodes: number;
}

interface HealthState {
  startedAt: string;
  lastTickAt: string | null;
  lastSuccessAt: string | null;
  consecutiveErrors: number;
  today: TodayCounters;
  lastDailySummaryDate: string | null;
}

export class HealthMonitor {
  private state: HealthState;

  constructor(private filePath: string, now: Date = new Date()) {
    this.state = {
      startedAt: now.toISOString(),
      lastTickAt: null,
      lastSuccessAt: null,
      consecutiveErrors: 0,
      today: { date: localDateString(now), assigned: 0, failed: 0, authEpisodes: 0 },
      lastDailySummaryDate: null,
    };
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as HealthState;
      this.state = { ...this.state, ...raw, today: { ...this.state.today, ...raw.today } };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private rollover(now: Date): void {
    if (isNewDay(now, this.state.today.date)) {
      this.state.today = { date: localDateString(now), assigned: 0, failed: 0, authEpisodes: 0 };
    }
  }

  recordTickStart(now: Date = new Date()): void {
    this.rollover(now);
    this.state.lastTickAt = now.toISOString();
  }

  recordTickSuccess(now: Date = new Date()): void {
    this.state.consecutiveErrors = 0;
    this.state.lastSuccessAt = now.toISOString();
  }

  recordTickError(): void {
    this.state.consecutiveErrors += 1;
  }

  recordAssignment(ok: boolean): void {
    if (ok) this.state.today.assigned += 1;
    else this.state.today.failed += 1;
  }

  recordAuthEpisode(): void {
    this.state.today.authEpisodes += 1;
  }

  shouldAlertErrorRate(threshold: number): boolean {
    return this.state.consecutiveErrors === threshold;
  }

  isDailySummaryDue(now: Date, summaryTime: string): boolean {
    return isDailySummaryDue(now, summaryTime, this.state.lastDailySummaryDate);
  }

  markDailySummarySent(now: Date = new Date()): void {
    this.state.lastDailySummaryDate = localDateString(now);
  }

  buildDailySummary(now: Date = new Date()): string {
    const t = this.state.today;
    const uptimeH = ((now.getTime() - new Date(this.state.startedAt).getTime()) / 3_600_000).toFixed(1);
    return (
      `Daily summary (${t.date}): assigned ${t.assigned}, failed ${t.failed}, ` +
      `auth episodes ${t.authEpisodes}, uptime ${uptimeH}h`
    );
  }

  snapshot(): Readonly<HealthState> {
    return this.state;
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
    await fs.rename(tmp, this.filePath);
  }
}
```

- [ ] **Step 5.4: Run to verify it passes**

Run: `npx vitest run tests/unit/health-monitor.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5.5: Commit**

```powershell
git add src/core/health-monitor.ts tests/unit/health-monitor.test.ts
git commit -m "feat(core): add HealthMonitor (metrics, rollover, daily summary, persistence)"
```

---

## Task 6: `reauth-manager.ts` (TDD)

**Files:**
- Create: `tests/unit/reauth-manager.test.ts`
- Create: `src/auth/reauth-manager.ts`

- [ ] **Step 6.1: Write the failing test**

`tests/unit/reauth-manager.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { ReAuthManager } from '../../src/auth/reauth-manager.js';
import { LoginFailedError } from '../../src/core/errors.js';

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as import('winston').Logger;

function make(ensureLoggedIn: () => Promise<void>) {
  const notify = vi.fn(async () => {});
  const onPause = vi.fn();
  const mgr = new ReAuthManager({ ensureLoggedIn, notify, logger: noopLogger, onPause });
  return { mgr, notify, onPause };
}

describe('ReAuthManager.ensureReady', () => {
  it('returns true and does not notify while authed', async () => {
    const { mgr, notify } = make(async () => {});
    expect(await mgr.ensureReady()).toBe(true);
    expect(mgr.authState).toBe('AUTHED');
    expect(notify).not.toHaveBeenCalled();
  });

  it('pauses and alerts once on session expiry', async () => {
    const { mgr, notify, onPause } = make(async () => { throw new LoginFailedError('Session expired.'); });
    expect(await mgr.ensureReady()).toBe(false);
    expect(mgr.authState).toBe('PAUSED_AUTH');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('does not re-alert while still paused', async () => {
    const { mgr, notify } = make(async () => { throw new LoginFailedError('Session expired.'); });
    await mgr.ensureReady();
    await mgr.ensureReady();
    expect(notify).toHaveBeenCalledTimes(1); // still once
  });

  it('resumes and alerts when auth recovers', async () => {
    let fail = true;
    const { mgr, notify } = make(async () => { if (fail) throw new LoginFailedError('x'); });
    await mgr.ensureReady();        // pause + alert (1)
    fail = false;
    expect(await mgr.ensureReady()).toBe(true);  // resume + alert (2)
    expect(mgr.authState).toBe('AUTHED');
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('rethrows non-auth errors', async () => {
    const { mgr } = make(async () => { throw new Error('network boom'); });
    await expect(mgr.ensureReady()).rejects.toThrow('network boom');
  });
});
```

- [ ] **Step 6.2: Run to verify it fails**

Run: `npx vitest run tests/unit/reauth-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6.3: Implement**

`src/auth/reauth-manager.ts`:
```typescript
import type winston from 'winston';
import { LoginFailedError } from '../core/errors.js';

export type AuthState = 'AUTHED' | 'PAUSED_AUTH';

export interface ReAuthDeps {
  /** Throws LoginFailedError when the session is expired/absent. */
  ensureLoggedIn: () => Promise<void>;
  /** Fire-and-forget notification (never throws). */
  notify: (text: string, severity: 'info' | 'warn' | 'error') => Promise<void>;
  logger: winston.Logger;
  /** Called once when transitioning AUTHED → PAUSED_AUTH (e.g., health metric). */
  onPause?: () => void;
}

export class ReAuthManager {
  private state: AuthState = 'AUTHED';

  constructor(private deps: ReAuthDeps) {}

  get authState(): AuthState {
    return this.state;
  }

  /** Returns true if the session is ready for work, false if paused awaiting re-auth. */
  async ensureReady(): Promise<boolean> {
    try {
      await this.deps.ensureLoggedIn();
      if (this.state === 'PAUSED_AUTH') {
        this.state = 'AUTHED';
        this.deps.logger.info('auth restored; resuming');
        await this.deps.notify('Session restored — resuming', 'info');
      }
      return true;
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
  }
}
```

- [ ] **Step 6.4: Run to verify it passes**

Run: `npx vitest run tests/unit/reauth-manager.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6.5: Commit**

```powershell
git add src/auth/reauth-manager.ts tests/unit/reauth-manager.test.ts
git commit -m "feat(auth): add ReAuthManager (pause/alert-once/auto-resume state machine)"
```

---

## Task 7: `AuthSession` — `isAlive()` + `recover()`

**Files:**
- Modify: `src/auth/session.ts`

No unit test (browser code). Typecheck only.

- [ ] **Step 7.1: Add the two methods**

In `src/auth/session.ts`, add these methods inside the `AuthSession` class, right before the existing `close()` method:
```typescript
  isAlive(): boolean {
    return !!this.page && !this.page.isClosed();
  }

  /** Tear down a dead browser and start a fresh one (reuses cookie storageState). */
  async recover(): Promise<Page> {
    this.logger.warn('recovering browser session');
    try {
      await this.close();
    } catch {
      /* ignore close errors on an already-dead browser */
    }
    return this.start();
  }
```
(`Page` is already imported at the top of the file. `start()` already returns `Promise<Page>`.)

- [ ] **Step 7.2: Verify**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7.3: Commit**

```powershell
git add src/auth/session.ts
git commit -m "feat(auth): add AuthSession.isAlive and recover for browser-crash recovery"
```

---

## Task 8: Wire all five layers into `src/index.ts`

**Files:**
- Modify: `src/index.ts`

This is the integration task. No new unit tests (the logic units are already tested); verify by typecheck + build + a dry-run.

- [ ] **Step 8.1: Add imports**

At the top of `src/index.ts`, after the existing import lines, add:
```typescript
import { ReAuthManager } from './auth/reauth-manager.js';
import { HealthMonitor } from './core/health-monitor.js';
import { runWithWatchdog } from './core/watchdog.js';
import { isBrowserDeadError } from './core/recovery-utils.js';
```

- [ ] **Step 8.2: Make page-bound components rebuildable + add HealthMonitor, ReAuthManager**

Replace this block:
```typescript
  const session = new AuthSession(settings, logger);
  const page = await session.start();

  const engine = new AssignmentEngine(translators, state);
  const scanner = new JobScanner(page, logger, settings.scan);
  const processor = new JobProcessor(page, logger);
  const assigner = new Assigner(page, logger, settings.assignment.dryRun);
```
with:
```typescript
  const session = new AuthSession(settings, logger);
  let page = await session.start();

  const engine = new AssignmentEngine(translators, state);
  let scanner = new JobScanner(page, logger, settings.scan);
  let processor = new JobProcessor(page, logger);
  let assigner = new Assigner(page, logger, settings.assignment.dryRun);

  const rebuildPipeline = (p: typeof page): void => {
    scanner = new JobScanner(p, logger, settings.scan);
    processor = new JobProcessor(p, logger);
    assigner = new Assigner(p, logger, settings.assignment.dryRun);
  };

  const health = new HealthMonitor('./data/health.json');
  await health.load();

  const reauth = new ReAuthManager({
    ensureLoggedIn: () => session.ensureLoggedIn(),
    notify: settings.reliability.reauth.alertOnExpiry
      ? (t, s) => notifier.notify(t, s)
      : async () => {},
    logger,
    onPause: () => health.recordAuthEpisode(),
  });
```

- [ ] **Step 8.3: Replace the tick body**

Replace the ENTIRE `const tick = async (): Promise<void> => { ... };` block with:
```typescript
  const tick = async (): Promise<void> => {
    logger.info('tick started');
    health.recordTickStart();

    if (!(await reauth.ensureReady())) {
      await health.save();
      return; // paused awaiting manual cookie refresh
    }

    try {
      const candidates = await scanner.scan();
      for (const job of candidates) {
        if (state.isProcessed(job.id)) continue;
        try {
          const detail = await processor.open(job.detailUrl, job.id);
          const assigned: Partial<Record<SupportedLanguage, string>> = {};
          const failed: SupportedLanguage[] = [];
          for (const lang of detail.targetLanguages) {
            if (lang.translator !== null) continue;
            if (lang.status !== 'WAITING_TRANSLATION' && !lang.status.includes('WAITING')) continue;
            try {
              const pick = engine.pick(lang.code, detail.wordCount);
              await retry(
                () => assigner.assign(lang.code, pick.translator, lang.rowIndex),
                { maxAttempts: settings.assignment.maxRetries + 1, baseDelayMs: settings.assignment.retryDelayMs },
                (err, attempt) => logger.warn('assign attempt failed', { attempt, language: lang.code, error: (err as Error).message })
              );
              assigned[lang.code] = pick.translator;
              health.recordAssignment(true);
              if (pick.useRoundRobin && pick.rrKey && !settings.assignment.dryRun) {
                state.incrementRR(pick.rrKey);
              }
              if (!settings.assignment.dryRun) {
                await notifier.notify(
                  `Assigned job ${job.id} "${job.name}" — ${lang.code} → ${pick.translator} (${detail.wordCount} words)`,
                  'info'
                );
              }
            } catch (err) {
              failed.push(lang.code);
              health.recordAssignment(false);
              logger.error('assignment failed', { jobId: job.id, language: lang.code, error: (err as Error).message });
              await captureScreenshot(page, settings.storage.logsDir, `assign-${job.id}-${lang.code}`);
            }
          }
          if (failed.length === 0 && Object.keys(assigned).length > 0) {
            state.markProcessed(job.id, assigned);
          } else if (Object.keys(assigned).length > 0) {
            state.markPartial(job.id, assigned, failed);
          } else if (failed.length === 0) {
            logger.info('job already fully assigned externally', { jobId: job.id });
            state.markProcessed(job.id, {});
          } else {
            logger.error('all language assignments failed for job', { jobId: job.id, failed });
            state.markPartial(job.id, {}, failed);
          }
          await state.save();
        } catch (err) {
          if (isBrowserDeadError(err)) throw err; // bubble to outer handler for recovery
          logger.error('job processing error', { jobId: job.id, error: (err as Error).message });
          await captureScreenshot(page, settings.storage.logsDir, `job-${job.id}`);
          await notifier.notify(`Job ${job.id} processing error: ${(err as Error).message}`, 'error');
        }
      }
      health.recordTickSuccess();
    } catch (err) {
      health.recordTickError();
      if (isBrowserDeadError(err)) {
        logger.error('browser died; recovering', { error: (err as Error).message });
        await notifier.notify('Browser crashed — recovering', 'warn');
        page = await session.recover();
        rebuildPipeline(page);
      } else {
        logger.error('tick failed', { error: (err as Error).message });
      }
      if (health.shouldAlertErrorRate(settings.reliability.monitoring.consecutiveErrorAlert)) {
        await notifier.notify(
          `Bot failing: ${settings.reliability.monitoring.consecutiveErrorAlert} consecutive ticks errored`,
          'error'
        );
      }
    }

    if (health.isDailySummaryDue(new Date(), settings.reliability.monitoring.dailySummaryTime)) {
      await notifier.notify(health.buildDailySummary(), 'info');
      health.markDailySummarySent();
    }
    await health.save();
    logger.info('tick complete');
  };
```

- [ ] **Step 8.4: Wrap the tick in the watchdog when constructing the Scheduler**

Replace:
```typescript
  const scheduler = new Scheduler(
    { intervalMinutes: settings.polling.intervalMinutes, jitterSeconds: settings.polling.jitterSeconds },
    tick,
    logger
  );
```
with:
```typescript
  const guardedTick = (): Promise<void> =>
    runWithWatchdog(tick, settings.reliability.watchdog.tickTimeoutMs, () => {
      logger.error('tick hung beyond watchdog timeout; exiting for service restart', {
        tickTimeoutMs: settings.reliability.watchdog.tickTimeoutMs,
      });
      void notifier
        .notify('Bot tick hung — exiting for auto-restart', 'error')
        .catch(() => {})
        .finally(() => process.exit(1));
    });

  const scheduler = new Scheduler(
    { intervalMinutes: settings.polling.intervalMinutes, jitterSeconds: settings.polling.jitterSeconds },
    guardedTick,
    logger
  );
```

- [ ] **Step 8.5: Persist health on shutdown**

In the `shutdown` function, add a `health.save()` before `lock.release()`. Replace:
```typescript
    await state.save();
    await session.close();
    await lock.release();
```
with:
```typescript
    await state.save();
    await health.save();
    await session.close();
    await lock.release();
```

- [ ] **Step 8.6: Verify build + typecheck + tests**

Run: `npm run typecheck`
Expected: exit 0.
Run: `npm test`
Expected: all tests pass (no regressions).
Run: `npm run build`
Expected: exit 0.

- [ ] **Step 8.7: Dry-run smoke (manual, on host with cookies)**

Ensure `config/settings.yml` has `assignment.dryRun: true`, then:
Run: `npm run dev`
Expected in logs: `tick started` → `session valid (cookie-based)` → `job scan complete` → `[DRY-RUN] would click Assign ...` → `tick complete`. Stop with Ctrl+C; confirm `shutdown complete` and that `data/health.json` was written. If `GOOGLE_CHAT_WEBHOOK_URL` is set, a "Bot started" and (on Ctrl+C) "Bot stopped" message should appear in Google Chat.

- [ ] **Step 8.8: Commit**

```powershell
git add src/index.ts
git commit -m "feat: wire reliability layers into tick (reauth, health, watchdog, recovery, daily summary)"
```

---

## Task 9: Harden Windows service + document host setup

**Files:**
- Modify: `scripts/install-windows-service.js`
- Modify: `README.md`

- [ ] **Step 9.1: Add restart options to the service definition**

In `scripts/install-windows-service.js`, the `new Service({ ... })` options object currently sets `name`, `description`, `script`, `nodeOptions`, `workingDirectory`. Add auto-restart tuning so the service recovers from crashes/self-exits. Add these keys to the options object:
```javascript
  // Auto-restart on crash / watchdog self-exit
  wait: 2,          // seconds to wait before first restart
  grow: 0.5,        // back-off growth factor between restarts
  maxRestarts: 40,  // max restarts within a 60s window before giving up
```
(node-windows installs services as Automatic start, so they start on boot by default — no extra flag needed.)

- [ ] **Step 9.2: Document 24/7 host setup in README**

In `README.md`, under the "Deploy → Windows Service" section, add a "24/7 host setup" subsection:
```markdown
### 24/7 host setup (Local Windows)

For unattended operation the host PC must stay awake and the service must
survive crashes and reboots:

- **Disable sleep** (Admin PowerShell):
  ```powershell
  powercfg /change standby-timeout-ac 0
  powercfg /change hibernate-timeout-ac 0
  ```
- **Service auto-restart + boot start** are configured by `npm run service:install`
  (node-windows: Automatic start, restart on failure).
- **When the session expires** (2FA cookies stale) the bot does NOT crash — it
  pauses and posts an alert to Google Chat. Re-run `npm run capture-cookies` on
  the host; the bot auto-resumes on its next tick (no restart needed).
- **Health:** a daily summary is posted to Google Chat at `reliability.monitoring.dailySummaryTime`;
  problem alerts fire on consecutive failures, browser crashes, hangs, and session expiry.
```

- [ ] **Step 9.3: Verify**

Run: `node -c scripts/install-windows-service.js`
Expected: no syntax error (exit 0). (Do NOT run `service:install` here — that requires Admin and is a host operation.)

- [ ] **Step 9.4: Commit**

```powershell
git add scripts/install-windows-service.js README.md
git commit -m "chore(deploy): harden Windows service restart options + document 24/7 host setup"
```

---

## Final Verification

- [ ] **Step F.1: Full static gate**

Run: `npm run typecheck`  → exit 0
Run: `npm test`  → all tests pass (expect 22 baseline + ~24 new across health-utils/recovery-utils/watchdog/health-monitor/reauth-manager = ~46 total; exact count may differ)
Run: `npm run build`  → exit 0

- [ ] **Step F.2: Behavioral verification on host (manual)**

With cookies present and `dryRun: true`:
1. **Re-auth pause/resume:** rename `data/cookies.json` to simulate expiry → next tick logs `session expired; pausing`, posts the expiry alert once, and subsequent ticks stay quiet. Restore the file (or re-run `capture-cookies`) → next tick logs `auth restored; resuming` and posts the resume alert.
2. **Daily summary:** temporarily set `reliability.monitoring.dailySummaryTime` to a minute ~2 minutes ahead, restart, and confirm a summary posts once at that time and not again.
3. **Watchdog (optional):** temporarily set `tickTimeoutMs` very low (e.g. `1000`) → confirm the bot logs the hang message and exits; under the installed Windows service it should auto-restart. Restore `tickTimeoutMs` to `600000` afterward.

- [ ] **Step F.3: Confirm clean history**

Run: `git log --oneline -12`
Confirm one commit per task, conventional messages.

---

## Acceptance Criteria

1. **Graceful re-auth:** session expiry pauses the bot (no crash), alerts once, and auto-resumes after cookie refresh without a restart.
2. **Hang recovery:** a tick exceeding `tickTimeoutMs` causes `process.exit(1)`; the Windows service restarts it.
3. **Crash/boot recovery:** Windows service restarts the process on crash and starts it on boot (restart options set).
4. **Browser-crash self-recovery:** a `Target closed`-class error triggers `session.recover()` + pipeline rebuild; the next tick proceeds.
5. **Monitoring:** daily summary posts once per day at the configured time (even with zero jobs); consecutive-failure, browser-crash, hang, and expiry alerts post to Google Chat.
6. **Health persistence:** `data/health.json` survives restarts; counters roll over at local midnight.
7. **No regressions:** all prior unit tests still pass; dry-run tick completes end-to-end.

---

## Notes for Implementer

- Frequent commits — one per task; do not batch.
- Pure logic (Tasks 2-6) is fully unit-tested; browser/process glue (Tasks 7-9) is typecheck + build + manual dry-run.
- `config/settings.yml` is gitignored — update it for local runs but never stage it.
- Keep `data/health.json` structured — it is the Phase-2 dashboard's data source.
- Do not weaken `dryRun` gating: RR-counter advance and assignment notifications must stay behind `!settings.assignment.dryRun`.
