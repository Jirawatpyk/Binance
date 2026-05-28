# Google Sheets Assignment Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror every real (non-dry-run) translator assignment into a shared Google Sheet — `lo-LA` rows to the "Lao Assign" tab, `km-KH` rows to the "Khmer Assign" tab — as a best-effort sink that never blocks a tick.

**Architecture:** A new `SheetsAssignmentLogger` sink runs in `index.ts` right after `notifier.notifyAssignments(...)`, fed the same per-tick `AssignmentSummaryItem[]` (which is real-only). Pure row-building + dedup logic lives in `sheets-rows.ts` (unit-tested); the auth/network wrapper (`google-sheets.ts`) uses `google-auth-library` for a JWT access token and the global `fetch` to call two Sheets REST endpoints (`values:append`, `values.get` for Job-ID dedup). Failures are logged and escalated on a streak, never thrown.

**Tech Stack:** TypeScript (ESM, NodeNext — local imports use `.js`), `google-auth-library`, Node 20 global `fetch`, zod config, vitest.

**Spec:** `docs/superpowers/specs/2026-05-28-google-sheets-assignment-logging-design.md`

---

## File Structure

- **Create** `src/integrations/sheets-rows.ts` — pure: `formatDueCell()` + `buildSheetRows()` (route by language to a tab, dedup by Job ID, produce C..G rows). No I/O.
- **Create** `src/integrations/google-sheets.ts` — `SheetsAssignmentLogger`: JWT auth, `init()` connectivity/tab check, `appendAssignments()` (read Job IDs → `buildSheetRows` → append), failure counter + alert, `disabled` flag. Never throws.
- **Create** `tests/unit/sheets-rows.test.ts` — unit tests for the pure layer.
- **Create** `scripts/test-sheets.ts` — manual smoke: append a marked test row to each tab.
- **Modify** `src/types/index.ts` — add optional `sheets` block to `Settings`.
- **Modify** `src/storage/config.ts` — add optional `sheets` zod schema.
- **Modify** `config/settings.example.yml` — document the `sheets` block (`enabled: false`).
- **Modify** `src/index.ts` — construct + `init()` the logger at startup; call `appendAssignments()` after `notifyAssignments`.
- **Modify** `package.json` — add `google-auth-library` dep + `test:sheets` script.

---

## Task 1: Add the `google-auth-library` dependency

**Files:**
- Modify: `package.json` (+ `package-lock.json`)

- [ ] **Step 1: Install the dependency**

Run:
```bash
npm install google-auth-library
```
Expected: `package.json` gains `"google-auth-library": "^9.x"` under `dependencies`; lockfile updates; no errors.

- [ ] **Step 2: Verify it imports under ESM**

Run:
```bash
node --input-type=module -e "import { JWT } from 'google-auth-library'; console.log(typeof JWT)"
```
Expected: prints `function`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(deps): add google-auth-library for Sheets logging"
```

---

## Task 2: Config — types, zod schema, example

The `sheets` block is **optional** so an existing `config/settings.yml` (without it) still loads; a missing block means "disabled".

**Files:**
- Modify: `src/types/index.ts` (the `Settings` interface, ends at line 55)
- Modify: `src/storage/config.ts` (the `settingsSchema`, lines 7-56)
- Modify: `config/settings.example.yml` (append at end)
- Test: `tests/unit/config-loader.test.ts`

- [ ] **Step 1: Add `sheets` to the `Settings` interface**

In `src/types/index.ts`, inside `interface Settings`, add this property after the `reliability: { ... }` block (after line 54, before the closing `}` on line 55):

```ts
  sheets?: {
    enabled: boolean;
    spreadsheetId: string;
    credentialsPath: string;
    tabs: Record<SupportedLanguage, string>;
  };
```

- [ ] **Step 2: Write the failing config test**

In `tests/unit/config-loader.test.ts`, add inside `describe('loadSettings', ...)` (after the existing `it('rejects when processedJobRetainHours < lookbackHours' ...)` block):

```ts
  it('parses an optional sheets block', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
sheets: { enabled: true, spreadsheetId: "SID", credentialsPath: ./google-credentials.json, tabs: { lo-LA: "Lao Assign", km-KH: "Khmer Assign" } }
`);
    const s = loadSettings(p);
    expect(s.sheets?.enabled).toBe(true);
    expect(s.sheets?.spreadsheetId).toBe('SID');
    expect(s.sheets?.tabs['km-KH']).toBe('Khmer Assign');
  });

  it('loads fine when the sheets block is omitted', () => {
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
    expect(s.sheets).toBeUndefined();
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
npx vitest run tests/unit/config-loader.test.ts -t "sheets"
```
Expected: the `parses an optional sheets block` test FAILS (the parsed object has no `sheets` because the schema strips unknown keys / it isn't defined yet).

- [ ] **Step 4: Add the `sheets` zod schema**

In `src/storage/config.ts`, inside `settingsSchema = z.object({ ... })`, add this key right after the `reliability: z.object({ ... })` block (after its closing `}),` on line 52, before the object's closing `})` + `.refine(...)`):

```ts
  sheets: z
    .object({
      enabled: z.boolean(),
      spreadsheetId: z.string().min(1),
      credentialsPath: z.string().min(1),
      tabs: z.object({
        'lo-LA': z.string().min(1),
        'km-KH': z.string().min(1),
      }),
    })
    .optional(),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
npx vitest run tests/unit/config-loader.test.ts
```
Expected: all config-loader tests PASS (including both new ones).

- [ ] **Step 6: Document the block in the example settings**

Append to the end of `config/settings.example.yml`:

```yaml

sheets:
  # Mirror real (non-dry-run) assignments into a Google Sheet. Disabled by
  # default. The credentials file is a service-account key (gitignored); the
  # spreadsheet must be shared with that service account as Editor.
  enabled: false
  spreadsheetId: "1Y1cua4PwwZaDdxOiZVbWK-YOsxvM9f1OMD2JHD46zC4"
  credentialsPath: ./google-credentials.json
  tabs:
    lo-LA: "Lao Assign"     # lo-LA assignments are appended here
    km-KH: "Khmer Assign"   # km-KH assignments are appended here
```

- [ ] **Step 7: Typecheck + commit**

Run:
```bash
npm run typecheck
```
Expected: exit 0, no errors.

```bash
git add src/types/index.ts src/storage/config.ts config/settings.example.yml tests/unit/config-loader.test.ts
git commit -m "feat(config): optional sheets block for assignment logging"
```

---

## Task 3: Pure row-building + dedup (`sheets-rows.ts`)

**Files:**
- Create: `src/integrations/sheets-rows.ts`
- Test: `tests/unit/sheets-rows.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/sheets-rows.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSheetRows, formatDueCell, type TabMap } from '../../src/integrations/sheets-rows.js';
import type { AssignmentSummaryItem } from '../../src/notifications/google-chat.js';

const tabs: TabMap = { 'lo-LA': 'Lao Assign', 'km-KH': 'Khmer Assign' };

function noExisting(): Record<string, Set<string>> {
  return { 'Lao Assign': new Set(), 'Khmer Assign': new Set() };
}

describe('formatDueCell', () => {
  it('formats a valid date as YYYY-MM-DD HH:mm UTC', () => {
    expect(formatDueCell(new Date('2026-05-30T14:05:00Z'))).toBe('2026-05-30 14:05 UTC');
  });
  it('returns empty string for null/invalid', () => {
    expect(formatDueCell(null)).toBe('');
    expect(formatDueCell(undefined)).toBe('');
    expect(formatDueCell(new Date('nope'))).toBe('');
  });
});

describe('buildSheetRows', () => {
  it('routes lo-LA to the Lao tab and km-KH to the Khmer tab', () => {
    const items: AssignmentSummaryItem[] = [
      {
        jobId: '100',
        name: 'Job A',
        wordCount: 250,
        assigned: { 'lo-LA': 'LO_T1@eqho.com', 'km-KH': 'kh_t1@eqho.com' },
        dueDate: new Date('2026-05-30T14:05:00Z'),
      },
    ];
    const rows = buildSheetRows(items, noExisting(), tabs);
    expect(rows['Lao Assign']).toEqual([['100', 'Job A', '2026-05-30 14:05 UTC', '250', 'LO_T1@eqho.com']]);
    expect(rows['Khmer Assign']).toEqual([['100', 'Job A', '2026-05-30 14:05 UTC', '250', 'kh_t1@eqho.com']]);
  });

  it('skips a Job ID already present in that tab (dedup)', () => {
    const items: AssignmentSummaryItem[] = [
      { jobId: '200', name: 'Dup', wordCount: 10, assigned: { 'lo-LA': 'LO_T1@eqho.com' } },
    ];
    const existing = { 'Lao Assign': new Set(['200']), 'Khmer Assign': new Set<string>() };
    const rows = buildSheetRows(items, existing, tabs);
    expect(rows['Lao Assign'] ?? []).toEqual([]);
  });

  it('writes an empty Due cell when dueDate is missing', () => {
    const items: AssignmentSummaryItem[] = [
      { jobId: '300', name: 'No due', wordCount: 5, assigned: { 'km-KH': 'kh_t2@eqho.com' } },
    ];
    const rows = buildSheetRows(items, noExisting(), tabs);
    expect(rows['Khmer Assign']).toEqual([['300', 'No due', '', '5', 'kh_t2@eqho.com']]);
  });

  it('returns an empty object for no items', () => {
    expect(buildSheetRows([], noExisting(), tabs)).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run tests/unit/sheets-rows.test.ts
```
Expected: FAIL — cannot resolve `../../src/integrations/sheets-rows.js` (module not created yet).

- [ ] **Step 3: Implement the pure module**

Create `src/integrations/sheets-rows.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx vitest run tests/unit/sheets-rows.test.ts
```
Expected: all PASS (formatDueCell 2, buildSheetRows 4).

- [ ] **Step 5: Commit**

```bash
git add src/integrations/sheets-rows.ts tests/unit/sheets-rows.test.ts
git commit -m "feat(sheets): pure row-building + Job-ID dedup"
```

---

## Task 4: The `SheetsAssignmentLogger` (auth + network wrapper)

No unit test (network/auth layer, per the project's no-test-by-design convention for I/O layers). Verified by typecheck here and the smoke script in Task 6.

**Files:**
- Create: `src/integrations/google-sheets.ts`

- [ ] **Step 1: Implement the logger**

Create `src/integrations/google-sheets.ts`:

```ts
import { JWT } from 'google-auth-library';
import { promises as fs } from 'fs';
import type winston from 'winston';
import type { SupportedLanguage } from '../types/index.js';
import type { AssignmentSummaryItem } from '../notifications/google-chat.js';
import { buildSheetRows, type TabMap } from './sheets-rows.js';

export interface SheetsConfig {
  enabled: boolean;
  spreadsheetId: string;
  credentialsPath: string;
  tabs: TabMap;
}

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const REQUEST_TIMEOUT_MS = 10_000;
const FAILURE_ALERT_THRESHOLD = 3;

/**
 * Best-effort sink that mirrors real assignments into a Google Sheet. NEVER
 * throws out of its public methods — a Sheets outage must not break a tick. On
 * a sustained failure it escalates via `onAlert`; the assignment, state, and
 * Chat card remain the source of truth.
 */
export class SheetsAssignmentLogger {
  private jwt?: JWT;
  private disabled: boolean;
  private consecutiveFailures = 0;

  constructor(
    private config: SheetsConfig | undefined,
    private logger: winston.Logger,
    private onAlert: (msg: string) => void
  ) {
    this.disabled = !config?.enabled;
  }

  /** Load credentials and verify the spreadsheet + both tabs are reachable.
   *  On any failure: log, alert once, and disable (the bot keeps assigning). */
  async init(): Promise<void> {
    if (this.disabled || !this.config) return;
    try {
      const raw = JSON.parse(await fs.readFile(this.config.credentialsPath, 'utf-8')) as {
        client_email: string;
        private_key: string;
      };
      this.jwt = new JWT({ email: raw.client_email, key: raw.private_key, scopes: [SCOPE] });
      const titles = await this.fetchTabTitles();
      const missing = Object.values(this.config.tabs).filter((t) => !titles.includes(t));
      if (missing.length > 0) throw new Error(`spreadsheet is missing tab(s): ${missing.join(', ')}`);
      this.logger.info('Google Sheets logging enabled', { spreadsheetId: this.config.spreadsheetId });
    } catch (err) {
      this.disabled = true;
      this.logger.error('Google Sheets init failed — sheet logging disabled', { error: (err as Error).message });
      this.onAlert(
        `Google Sheets logging disabled: ${(err as Error).message}. Check google-credentials.json, the spreadsheet ID/tab names, and that the sheet is shared with the service account as Editor.`
      );
    }
  }

  /** Append a row per assigned language to the matching tab (deduped by Job ID).
   *  No-op when disabled or there's nothing to write. Never throws. */
  async appendAssignments(items: AssignmentSummaryItem[]): Promise<void> {
    if (this.disabled || !this.config || !this.jwt || items.length === 0) return;
    try {
      const existingIdsByTab: Record<string, Set<string>> = {};
      for (const tab of new Set(Object.values(this.config.tabs))) {
        existingIdsByTab[tab] = await this.fetchJobIds(tab);
      }
      const rowsByTab = buildSheetRows(items, existingIdsByTab, this.config.tabs);
      for (const [tab, rows] of Object.entries(rowsByTab)) {
        if (rows.length === 0) continue;
        await this.appendRows(tab, rows);
        this.logger.info('appended assignment rows to sheet', { tab, count: rows.length });
      }
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      this.logger.error('Google Sheets append failed', {
        error: (err as Error).message,
        consecutiveFailures: this.consecutiveFailures,
      });
      if (this.consecutiveFailures === FAILURE_ALERT_THRESHOLD) {
        this.onAlert(
          `Google Sheets logging has failed ${this.consecutiveFailures}× in a row — assignments are not being mirrored to the sheet (the assignments themselves are unaffected).`
        );
      }
    }
  }

  private async bearer(): Promise<string> {
    const { token } = await this.jwt!.getAccessToken();
    if (!token) throw new Error('failed to obtain a Google access token');
    return token;
  }

  private async fetchTabTitles(): Promise<string[]> {
    const url = `${SHEETS_API}/${this.config!.spreadsheetId}?fields=sheets.properties.title`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await this.bearer()}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`metadata fetch ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { sheets?: { properties?: { title?: string } }[] };
    return (body.sheets ?? []).map((s) => s.properties?.title ?? '');
  }

  private async fetchJobIds(tab: string): Promise<Set<string>> {
    const range = encodeURIComponent(`'${tab}'!C:C`);
    const url = `${SHEETS_API}/${this.config!.spreadsheetId}/values/${range}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await this.bearer()}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`read ${tab} ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { values?: string[][] };
    return new Set((body.values ?? []).map((r) => (r[0] ?? '').trim()).filter(Boolean));
  }

  private async appendRows(tab: string, rows: string[][]): Promise<void> {
    const range = encodeURIComponent(`'${tab}'!C:G`);
    const url = `${SHEETS_API}/${this.config!.spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.bearer()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`append ${tab} ${res.status}: ${await res.text()}`);
  }
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: exit 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/integrations/google-sheets.ts
git commit -m "feat(sheets): SheetsAssignmentLogger (auth + append, never throws)"
```

---

## Task 5: Wire the logger into the tick (`index.ts`)

**Files:**
- Modify: `src/index.ts` (imports near top; construct after the `diagNotifier`; `init()` after the corrupt-recovery block; call after `notifier.notifyAssignments(...)`)

- [ ] **Step 1: Add the import**

In `src/index.ts`, next to the existing notifier import (`import { GoogleChatNotifier, type AssignmentSummaryItem } from './notifications/google-chat.js';`), add:

```ts
import { SheetsAssignmentLogger } from './integrations/google-sheets.js';
```

- [ ] **Step 2: Construct the logger after `diagNotifier`**

Find the `diagNotifier` construction:

```ts
  const diagNotifier = new GoogleChatNotifier(process.env.GOOGLE_CHAT_TEST_WEBHOOK_URL, logger);
```

Immediately after it, add:

```ts
  // Best-effort mirror of real assignments into Google Sheets. Failures alert
  // via the production notifier but never block a tick.
  const sheetsLogger = new SheetsAssignmentLogger(settings.sheets, logger, (msg) =>
    void notifier.notify(msg, 'error')
  );
```

- [ ] **Step 3: Initialise it after the corrupt-recovery block**

Find the corrupt-recovery block that ends with the `}` after the `notifier.notify(... 'error').catch(() => {})` for `Recovered from corrupt ...`. Immediately after that closing `}`, add:

```ts
  await sheetsLogger.init();
```

- [ ] **Step 4: Append after `notifyAssignments`**

Find:

```ts
    await notifier.notifyAssignments(assignedThisTick);
```

Immediately after that line, add:

```ts
    // Mirror the same real assignments into Google Sheets (best-effort).
    await sheetsLogger.appendAssignments(assignedThisTick);
```

- [ ] **Step 5: Typecheck + full test suite**

Run:
```bash
npm run typecheck && npm test
```
Expected: typecheck exit 0; all tests PASS (existing suite + the new sheets-rows + config tests).

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(sheets): mirror real assignments to Google Sheets each tick"
```

---

## Task 6: Manual smoke script

**Files:**
- Create: `scripts/test-sheets.ts`
- Modify: `package.json` (add a `test:sheets` script)

- [ ] **Step 1: Create the smoke script**

Create `scripts/test-sheets.ts`:

```ts
import 'dotenv/config';
import { loadSettings } from '../src/storage/config.js';
import { createLogger } from '../src/core/logger.js';
import { SheetsAssignmentLogger } from '../src/integrations/google-sheets.js';
import type { AssignmentSummaryItem } from '../src/notifications/google-chat.js';

// Appends one clearly-marked test row to each configured tab to confirm the
// service-account credentials + Editor sharing work against the real sheet.
// Requires sheets.enabled: true in config/settings.yml.
// Usage: npx tsx scripts/test-sheets.ts
const settings = loadSettings(process.env.SETTINGS_PATH ?? './config/settings.yml');
const logger = createLogger({ level: 'info', logsDir: settings.storage.logsDir, rotateDays: 1 });

if (!settings.sheets?.enabled) {
  console.error('sheets.enabled is false in settings.yml — enable it (with real values) to smoke-test.');
  process.exit(1);
}

const sheets = new SheetsAssignmentLogger(settings.sheets, logger, (m) => console.warn('ALERT:', m));
await sheets.init();

const stamp = new Date().toISOString();
const sample: AssignmentSummaryItem[] = [
  {
    jobId: `TEST-${Date.now()}`,
    name: `SMOKE TEST ${stamp} (safe to delete)`,
    wordCount: 1,
    assigned: { 'lo-LA': 'smoke@eqho.com', 'km-KH': 'smoke@eqho.com' },
    dueDate: new Date(),
  },
];
await sheets.appendAssignments(sample);
console.log('Done. Check both tabs for a row whose name starts with "SMOKE TEST".');
process.exit(0);
```

- [ ] **Step 2: Add the npm script**

In `package.json`, inside `"scripts"`, add:

```json
    "test:sheets": "tsx scripts/test-sheets.ts",
```

- [ ] **Step 3: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: exit 0.

- [ ] **Step 4: (Operator) run the smoke test against the live sheet**

Prerequisites: `config/settings.yml` has a `sheets:` block with `enabled: true` and real values, `google-credentials.json` is present, and the spreadsheet is shared with `email-fetcher-bot@email-fetcher-476604.iam.gserviceaccount.com` as **Editor**.

Run:
```bash
npx tsx scripts/test-sheets.ts
```
Expected: prints "Done." and a `SMOKE TEST ...` row appears in **both** the Lao Assign and Khmer Assign tabs (columns C–G). A 403 means the sheet isn't shared with the service account. Delete the test rows afterward.

- [ ] **Step 5: Commit**

```bash
git add scripts/test-sheets.ts package.json
git commit -m "chore(sheets): add manual smoke-test script"
```

---

## Final verification

- [ ] `npm run typecheck` → exit 0
- [ ] `npm test` → all green (existing + sheets-rows + config)
- [ ] Operator: `sheets:` block added to `config/settings.yml` with `enabled: true`, real spreadsheet ID/tab names, and `credentialsPath`
- [ ] Operator: spreadsheet shared with the service account as Editor; `npx tsx scripts/test-sheets.ts` writes to both tabs
- [ ] Restart the bot; on the next real assignment, confirm a row appears in the correct tab and a re-processed job does NOT duplicate
