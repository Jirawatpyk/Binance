# Reviewer Assignment (WAITING_REVIEW) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assign a fixed reviewer (`LO_T2@eqho.com`) to `lo-LA` rows in `WAITING_REVIEW`, by generalizing assignment to carry a role (translator | reviewer) and reusing the existing Assign modal.

**Architecture:** Add `reviewer` to the parsed row model; a pure `pendingRole()` decides whether a row needs a translator, a reviewer, or nothing; a new optional `review` config supplies the per-language reviewer; the existing `Assigner` is reused with a new `expectClearedStatus` argument; reviewer assignments are collected separately (`reviewedThisTick`) so they notify Google Chat but never reach the Sheet.

**Tech Stack:** TypeScript (ESM, NodeNext — local imports use `.js`), Playwright (Ant Design DOM), zod config, winston, vitest.

**Spec:** `docs/superpowers/specs/2026-05-28-review-assign-design.md`

**Confirmed DOM (Job #62403):** Detail Waiting-tab `td` columns — Language(0) · Due(1) · Translator(2) · **Reviewer(3)** · Progress(4) · Status(5) · Actions(6). A `WAITING_REVIEW` row has Translator set, Reviewer `-`, an **Assign** button; its modal ("Current Step: WAITING_REVIEW / Required Role: REVIEWER") lists reviewers (incl. `LO_T2@eqho.com`) as `li.ant-list-item` with per-row Assign buttons — same structure as the translator modal.

---

## File Structure

- **Modify** `src/types/index.ts` — `TargetLanguage.reviewer`; `Settings.review`.
- **Modify** `src/scraper/job-processor.ts` — parse the Reviewer column (td index 3).
- **Modify** `src/storage/config.ts` — zod `review` block.
- **Modify** `config/settings.example.yml` — document `review`.
- **Modify** `src/assignment/eligibility.ts` — add `AssignRole` + `pendingRole`; later remove `isLanguageAssignable`.
- **Modify** `src/assignment/assigner.ts` — `assign(..., expectClearedStatus)`.
- **Modify** `src/notifications/google-chat.ts` — `ReviewSummaryItem`, `buildReviewSummaryCard`, `notifyReviews`.
- **Modify** `src/index.ts` — role-based assign loop, `reviewedThisTick`, `notifyReviews`, reviewer config wiring.
- **Tests** — `eligibility.test.ts`, `config-loader.test.ts`, `google-chat.test.ts`.

Each task below leaves `npm run typecheck` and `npm test` green.

---

## Task 1: Data model — parse the Reviewer column

**Files:**
- Modify: `src/types/index.ts` (the `TargetLanguage` interface, lines 14-19)
- Modify: `src/scraper/job-processor.ts` (`parseLanguageRows`)
- Modify: `tests/unit/eligibility.test.ts` (the `row()` helper, line 6)

- [ ] **Step 1: Add `reviewer` to `TargetLanguage`**

In `src/types/index.ts`, change the `TargetLanguage` interface to:

```ts
export interface TargetLanguage {
  code: SupportedLanguage;
  status: string;
  translator: string | null;
  reviewer: string | null;
  rowIndex: number;
}
```

- [ ] **Step 2: Parse the Reviewer column in `parseLanguageRows`**

In `src/scraper/job-processor.ts`, inside the `for` loop of `parseLanguageRows`, after the `statusText` line, read the Reviewer column (index 3) and include it in the pushed object. The block becomes:

```ts
      if ((await cells.count()) < 6) continue;
      const langText = (await cells.nth(0).textContent() ?? '').trim();
      const code = this.detectCode(langText);
      if (!code) continue;
      const translatorText = (await cells.nth(2).textContent() ?? '').trim();
      const reviewerText = (await cells.nth(3).textContent() ?? '').trim();
      const statusText = (await cells.nth(5).textContent() ?? '').trim();
      out.push({
        code,
        status: statusText || 'UNKNOWN',
        translator: translatorText === '-' || translatorText === '' ? null : translatorText,
        reviewer: reviewerText === '-' || reviewerText === '' ? null : reviewerText,
        rowIndex: i,
      });
```

- [ ] **Step 3: Keep the eligibility test compiling**

`TargetLanguage` now requires `reviewer`. In `tests/unit/eligibility.test.ts`, update the `row()` helper (line 6) to default it:

```ts
function row(partial: Partial<TargetLanguage>): TargetLanguage {
  return { code: 'lo-LA', status: 'WAITING_TRANSLATION', translator: null, reviewer: null, rowIndex: 0, ...partial };
}
```

- [ ] **Step 4: Typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; all tests pass (the existing `isLanguageAssignable` tests still pass — `reviewer` defaults to null and isn't read yet).

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/scraper/job-processor.ts tests/unit/eligibility.test.ts
git commit -m "feat(review): parse the Reviewer column into TargetLanguage"
```

---

## Task 2: Config — optional `review` block

The block is **optional** so an existing `settings.yml` still loads; `enabled: false`/omitted disables the feature.

**Files:**
- Modify: `src/types/index.ts` (the `Settings` interface)
- Modify: `src/storage/config.ts` (the `settingsSchema`)
- Modify: `config/settings.example.yml`
- Test: `tests/unit/config-loader.test.ts`

- [ ] **Step 1: Add `review` to the `Settings` interface**

In `src/types/index.ts`, inside `interface Settings`, add after the `sheets?: {...}` property (and before the closing `}`):

```ts
  review?: {
    enabled: boolean;
    reviewers: Partial<Record<SupportedLanguage, string>>;
  };
```

- [ ] **Step 2: Write the failing config tests**

In `tests/unit/config-loader.test.ts`, add inside `describe('loadSettings', ...)` after the last sheets test:

```ts
  it('parses an optional review block', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
review: { enabled: true, reviewers: { lo-LA: "LO_T2@eqho.com" } }
`);
    const s = loadSettings(p);
    expect(s.review?.enabled).toBe(true);
    expect(s.review?.reviewers['lo-LA']).toBe('LO_T2@eqho.com');
  });

  it('loads fine when the review block is omitted', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
`);
    expect(loadSettings(p).review).toBeUndefined();
  });

  it('rejects a review reviewer that is not a valid email', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
review: { enabled: true, reviewers: { lo-LA: "not-an-email" } }
`);
    expect(() => loadSettings(p)).toThrow();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/config-loader.test.ts -t "review"`
Expected: the "parses an optional review block" test FAILS (schema strips the unknown `review` key, so `s.review` is undefined).

- [ ] **Step 4: Add the `review` zod schema**

In `src/storage/config.ts`, inside `settingsSchema = z.object({ ... })`, add this key right after the `sheets: z.object({...}).optional(),` block (and before the object's closing `})` + `.refine(`):

```ts
  review: z
    .object({
      enabled: z.boolean(),
      reviewers: z.object({
        'lo-LA': z.string().email().optional(),
        'km-KH': z.string().email().optional(),
      }),
    })
    .optional(),
```

- [ ] **Step 5: Run the config tests to verify they pass**

Run: `npx vitest run tests/unit/config-loader.test.ts`
Expected: all pass.

- [ ] **Step 6: Document the block in the example settings**

Append to the end of `config/settings.example.yml`:

```yaml

review:
  # Assign a fixed reviewer to lo-LA rows in WAITING_REVIEW (after translation is
  # done). Disabled by default. Only languages listed here get a reviewer; others
  # are skipped. Dry-run gates this exactly like translator assignment.
  enabled: false
  reviewers:
    lo-LA: "LO_T2@eqho.com"
```

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add src/types/index.ts src/storage/config.ts config/settings.example.yml tests/unit/config-loader.test.ts
git commit -m "feat(config): optional review block (per-language reviewer)"
```

---

## Task 3: Role resolver — `pendingRole`

**Files:**
- Modify: `src/assignment/eligibility.ts`
- Test: `tests/unit/eligibility.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/unit/eligibility.test.ts`, add the import and a new describe block. At the top, change the import line to:

```ts
import { isLanguageAssignable, pendingRole } from '../../src/assignment/eligibility.js';
```

Then add at the end of the file:

```ts
describe('pendingRole', () => {
  const reviewers = { 'lo-LA': 'LO_T2@eqho.com' };

  it('translator when WAITING_TRANSLATION and no translator', () => {
    expect(pendingRole(row({ status: 'WAITING_TRANSLATION', translator: null }), reviewers)).toBe('translator');
  });

  it('reviewer when WAITING_REVIEW, no reviewer, and a reviewer is configured', () => {
    expect(pendingRole(row({ status: 'WAITING_REVIEW', translator: 'a@eqho.com', reviewer: null }), reviewers)).toBe('reviewer');
  });

  it('null for WAITING_REVIEW when no reviewer configured for the language', () => {
    expect(pendingRole(row({ code: 'km-KH', status: 'WAITING_REVIEW', reviewer: null }), reviewers)).toBeNull();
  });

  it('null for WAITING_REVIEW when a reviewer is already set', () => {
    expect(pendingRole(row({ status: 'WAITING_REVIEW', reviewer: 'b@eqho.com' }), reviewers)).toBeNull();
  });

  it('null when reviewers config is undefined (feature off)', () => {
    expect(pendingRole(row({ status: 'WAITING_REVIEW', reviewer: null }), undefined)).toBeNull();
  });

  it('null for unrelated statuses', () => {
    expect(pendingRole(row({ status: 'REVIEWING', translator: 'a@eqho.com', reviewer: null }), reviewers)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/eligibility.test.ts -t "pendingRole"`
Expected: FAIL — `pendingRole` is not exported.

- [ ] **Step 3: Implement `pendingRole`**

In `src/assignment/eligibility.ts`, first widen the type import to also bring in `SupportedLanguage`. Change the import line:

```ts
import type { TargetLanguage } from '../types/index.js';
```

to:

```ts
import type { TargetLanguage, SupportedLanguage } from '../types/index.js';
```

Then add below the existing `isLanguageAssignable` (keep `isLanguageAssignable` for now — it's removed in Task 6):

```ts
export type AssignRole = 'translator' | 'reviewer';

/**
 * What role (if any) a language row currently needs assigned. A row awaits a
 * translator (WAITING_TRANSLATION, no translator) or — once translated — a
 * reviewer (WAITING_REVIEW, no reviewer) but only for languages that have a
 * reviewer configured. Any other state yields null (skip). `reviewers` is the
 * configured per-language reviewer map, or undefined when review is disabled.
 */
export function pendingRole(
  lang: TargetLanguage,
  reviewers: Partial<Record<SupportedLanguage, string>> | undefined
): AssignRole | null {
  if (lang.status === 'WAITING_TRANSLATION' && lang.translator === null) return 'translator';
  if (lang.status === 'WAITING_REVIEW' && lang.reviewer === null && reviewers?.[lang.code]) {
    return 'reviewer';
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/eligibility.test.ts`
Expected: all pass (both `isLanguageAssignable` and `pendingRole` describes).

- [ ] **Step 5: Commit**

```bash
git add src/assignment/eligibility.ts tests/unit/eligibility.test.ts
git commit -m "feat(review): pendingRole resolver (translator/reviewer/none)"
```

---

## Task 4: Assigner — `expectClearedStatus` argument

The modal interaction is unchanged; only the post-assign verification's status is parameterized. Default keeps existing call sites working until Task 6.

**Files:**
- Modify: `src/assignment/assigner.ts` (`assign` signature + the verification block, lines 32-118)

- [ ] **Step 1: Parameterize the status the verification checks**

In `src/assignment/assigner.ts`, change the `assign` signature and the two places that reference `WAITING_TRANSLATION` in the verification. Replace the signature line:

```ts
  async assign(language: SupportedLanguage, translatorEmail: string, rowIndex: number): Promise<void> {
```

with:

```ts
  async assign(
    language: SupportedLanguage,
    translatorEmail: string,
    rowIndex: number,
    expectClearedStatus: string = 'WAITING_TRANSLATION'
  ): Promise<void> {
```

Then in the positive-verification block near the end, replace the `stillWaitingRow` filter and the throw. Change:

```ts
    const stillWaitingRow = () =>
      this.page
        .locator('table tbody tr')
        .filter({ hasText: language })
        .filter({ hasText: 'WAITING_TRANSLATION' })
        .count()
        .catch(() => 0);
```

to:

```ts
    const stillWaitingRow = () =>
      this.page
        .locator('table tbody tr')
        .filter({ hasText: language })
        .filter({ hasText: expectClearedStatus })
        .count()
        .catch(() => 0);
```

and change the throw message:

```ts
    if (stillWaiting > 0) {
      throw new AssignmentFailedError('row still WAITING_TRANSLATION after assign — not confirmed', {
```

to:

```ts
    if (stillWaiting > 0) {
      throw new AssignmentFailedError(`row still ${expectClearedStatus} after assign — not confirmed`, {
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0 (existing `assigner.assign(lang, translator, rowIndex)` call in `index.ts` still compiles via the default; behavior unchanged).

- [ ] **Step 3: Commit**

```bash
git add src/assignment/assigner.ts
git commit -m "feat(review): parameterize Assigner verification status"
```

---

## Task 5: Notifications — reviewer summary card

**Files:**
- Modify: `src/notifications/google-chat.ts`
- Test: `tests/unit/google-chat.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/unit/google-chat.test.ts`, add to the import on line 2:

```ts
import { buildTextCard, buildAssignmentSummaryCard, buildDailySummaryCard, buildReviewSummaryCard, dueColor } from '../../src/notifications/google-chat.js';
```

Add a new describe block at the end of the file:

```ts
describe('buildReviewSummaryCard', () => {
  it('summarises reviewer assignments per job', () => {
    const c = card(
      buildReviewSummaryCard([
        { jobId: '62403', name: 'alicloud-ios', reviewed: { 'lo-LA': 'LO_T2@eqho.com' } },
      ])
    );
    expect(c.card.header.title).toBe('🔍 Reviewer assigned — 1 job');
    const text = allText(c);
    expect(text).toContain('Job 62403');
    expect(text).toContain('alicloud-ios');
    expect(text).toContain('<b>lo-LA</b> → LO_T2@eqho.com');
  });

  it('pluralises and separates multiple jobs with a divider', () => {
    const c = card(
      buildReviewSummaryCard([
        { jobId: '1', name: 'A', reviewed: { 'lo-LA': 'LO_T2@eqho.com' } },
        { jobId: '2', name: 'B', reviewed: { 'lo-LA': 'LO_T2@eqho.com' } },
      ])
    );
    expect(c.card.header.title).toBe('🔍 Reviewer assigned — 2 jobs');
    const widgets = c.card.sections[0].widgets;
    expect(widgets.filter((w) => w.decoratedText)).toHaveLength(2);
    expect(widgets.filter((w) => w.divider)).toHaveLength(1);
  });

  it('escapes HTML-special characters in name and reviewer', () => {
    const text = allText(
      card(buildReviewSummaryCard([{ jobId: 'J<1>', name: 'A & B', reviewed: { 'lo-LA': 'r&x@eqho.com' } }]))
    );
    expect(text).toContain('Job J&lt;1&gt;');
    expect(text).toContain('A &amp; B');
    expect(text).toContain('r&amp;x@eqho.com');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/google-chat.test.ts -t "buildReviewSummaryCard"`
Expected: FAIL — `buildReviewSummaryCard` is not exported.

- [ ] **Step 3: Implement the item type, card builder, and notifier method**

In `src/notifications/google-chat.ts`, add the interface next to `AssignmentSummaryItem`:

```ts
/** One job's reviewer assignments for the per-cycle review summary card. */
export interface ReviewSummaryItem {
  jobId: string;
  name: string;
  reviewed: Record<string, string>; // language code -> reviewer email
}
```

Add the card builder (e.g. after `buildAssignmentSummaryCard`):

```ts
/**
 * A single card summarising every reviewer assigned in one polling cycle — one
 * `decoratedText` row per job (job id + name, then `lang → reviewer` lines),
 * dividers between jobs. Mirrors buildAssignmentSummaryCard but for reviewers.
 */
export function buildReviewSummaryCard(items: ReviewSummaryItem[]): unknown {
  const widgets: unknown[] = [];
  items.forEach((j, i) => {
    if (i > 0) widgets.push({ divider: {} });
    const langs = Object.entries(j.reviewed)
      .map(([lang, reviewer]) => `• <b>${esc(lang)}</b> → ${esc(reviewer)}`)
      .join('<br>');
    widgets.push({
      decoratedText: {
        startIcon: { knownIcon: 'PERSON' },
        topLabel: `Job ${esc(j.jobId)}`,
        text: `<b>${esc(j.name)}</b><br>${langs}`,
        wrapText: true,
      },
    });
  });
  const plural = items.length === 1 ? '' : 's';
  return {
    cardsV2: [
      {
        cardId: `review-${Date.now()}`,
        card: {
          header: { title: `🔍 Reviewer assigned — ${items.length} job${plural}` },
          sections: [{ widgets }],
        },
      },
    ],
  };
}
```

Add the notifier method inside `class GoogleChatNotifier` (next to `notifyAssignments`):

```ts
  /** Fire-and-forget per-cycle reviewer-assignment summary. No-op when empty. */
  async notifyReviews(items: ReviewSummaryItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.post(buildReviewSummaryCard(items), 'info');
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/google-chat.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/notifications/google-chat.ts tests/unit/google-chat.test.ts
git commit -m "feat(review): Google Chat reviewer-assignment summary card"
```

---

## Task 6: Wire role-based assignment into the tick

**Files:**
- Modify: `src/index.ts` (imports; `reviewers` var; `reviewedThisTick`; the per-language loop; outcome count; notify call)
- Modify: `src/assignment/eligibility.ts` (remove now-unused `isLanguageAssignable`)
- Modify: `tests/unit/eligibility.test.ts` (remove the `isLanguageAssignable` describe)

- [ ] **Step 1: Update imports in `index.ts`**

In `src/index.ts`, change the eligibility import:

```ts
import { isLanguageAssignable } from './assignment/eligibility.js';
```

to:

```ts
import { pendingRole } from './assignment/eligibility.js';
```

Add `PickResult` to the engine import. Change:

```ts
import { AssignmentEngine } from './assignment/engine.js';
```

to:

```ts
import { AssignmentEngine, type PickResult } from './assignment/engine.js';
```

Add `ReviewSummaryItem` to the google-chat import. Change:

```ts
import { GoogleChatNotifier, type AssignmentSummaryItem } from './notifications/google-chat.js';
```

to:

```ts
import { GoogleChatNotifier, type AssignmentSummaryItem, type ReviewSummaryItem } from './notifications/google-chat.js';
```

- [ ] **Step 2: Wire the reviewers config**

In `src/index.ts`, find the engine construction line:

```ts
  const engine = new AssignmentEngine(translators, state);
```

Add immediately after it:

```ts
  // Per-language reviewer map (WAITING_REVIEW → reviewer), or undefined when the
  // review feature is off — pendingRole uses it to decide reviewer assignments.
  const reviewers = settings.review?.enabled ? settings.review.reviewers : undefined;
```

- [ ] **Step 3: Declare `reviewedThisTick` alongside `assignedThisTick`**

In `src/index.ts`, find (inside `tick`):

```ts
    const assignedThisTick: AssignmentSummaryItem[] = [];
```

Add immediately after it:

```ts
    const reviewedThisTick: ReviewSummaryItem[] = [];
```

- [ ] **Step 4: Rewrite the per-language loop**

In `src/index.ts`, replace the whole block from `const assigned: Partial<...` through the `assignedThisTick.push({...})` block (the current lines starting `const assigned: Partial<Record<SupportedLanguage, string>> = {};` down to the close of the `if (!settings.assignment.dryRun && Object.keys(assigned).length > 0) {...}` block) with:

```ts
          const assigned: Partial<Record<SupportedLanguage, string>> = {};
          const reviewed: Partial<Record<SupportedLanguage, string>> = {};
          const failed: SupportedLanguage[] = [];
          for (const lang of detail.targetLanguages) {
            const role = pendingRole(lang, reviewers);
            if (role === null) continue;

            // Resolve the assignee + the status that must clear after a successful
            // assign. Translator: word-count rule (RR counter). Reviewer: the
            // configured fixed reviewer for the language.
            let assignee: string;
            let pick: PickResult | null = null;
            if (role === 'translator') {
              pick = engine.pick(lang.code, detail.wordCount);
              assignee = pick.translator;
            } else {
              assignee = reviewers![lang.code]!; // pendingRole guarantees this exists
            }
            const expectCleared = role === 'translator' ? 'WAITING_TRANSLATION' : 'WAITING_REVIEW';

            try {
              await retry(
                () => assigner.assign(lang.code, assignee, lang.rowIndex, expectCleared),
                { maxAttempts: settings.assignment.maxRetries + 1, baseDelayMs: settings.assignment.retryDelayMs },
                (err, attempt) => {
                  if (
                    err instanceof TranslatorNotFoundError ||
                    isBrowserDeadError(err) ||
                    (err as Error).message?.includes('Timeout')
                  ) {
                    throw err; // deterministic / unrecoverable — don't waste retries
                  }
                  logger.warn('assign attempt failed', { attempt, language: lang.code, role, error: (err as Error).message });
                }
              );
              if (role === 'translator') assigned[lang.code] = assignee;
              else reviewed[lang.code] = assignee;
              if (settings.assignment.dryRun) {
                logger.info('[DRY-RUN] would assign (not counted in metrics)', {
                  jobId: job.id,
                  name: job.name,
                  language: lang.code,
                  role,
                  assignee,
                });
              } else {
                // Real assignment only — dry-run must not affect health metrics,
                // round-robin counters, or notifications.
                health.recordAssignment(true, lang.code);
                if (role === 'translator' && pick!.useRoundRobin && pick!.rrKey) {
                  state.incrementRR(pick!.rrKey);
                }
              }
            } catch (err) {
              if (isBrowserDeadError(err)) throw err; // bubble to outer handler for browser recovery
              failed.push(lang.code);
              health.recordAssignment(false, lang.code);
              logger.error('assignment failed', { jobId: job.id, language: lang.code, role, error: (err as Error).message });
              await captureScreenshot(page, settings.storage.logsDir, `assign-${job.id}-${lang.code}`, settings.logging.screenshotMaxPerDay).catch(() => null);
            }
          }
          if (!settings.assignment.dryRun && Object.keys(assigned).length > 0) {
            health.recordJobAssigned();
            assignedThisTick.push({
              jobId: job.id,
              name: job.name,
              wordCount: detail.wordCount,
              assigned: assigned as Record<string, string>,
              dueDate: job.dueDate,
            });
          }
          if (!settings.assignment.dryRun && Object.keys(reviewed).length > 0) {
            reviewedThisTick.push({
              jobId: job.id,
              name: job.name,
              reviewed: reviewed as Record<string, string>,
            });
          }
```

- [ ] **Step 5: Count reviewer assignments in the outcome**

In `src/index.ts`, in the `classifyOutcome({...})` call just below, change the `assignedCount` line:

```ts
              assignedCount: Object.keys(assigned).length,
```

to:

```ts
              assignedCount: Object.keys(assigned).length + Object.keys(reviewed).length,
```

- [ ] **Step 6: Notify reviews after assignments**

In `src/index.ts`, find:

```ts
    await notifier.notifyAssignments(assignedThisTick);
    // Mirror the same real assignments into Google Sheets (best-effort).
    await sheetsLogger.appendAssignments(assignedThisTick);
```

Add immediately after those lines:

```ts
    // Reviewer assignments notify Chat only — never the Sheet.
    await notifier.notifyReviews(reviewedThisTick);
```

- [ ] **Step 7: Remove the now-unused `isLanguageAssignable`**

In `src/assignment/eligibility.ts`, delete the `isLanguageAssignable` function and its doc comment (the `pendingRole` export remains). In `tests/unit/eligibility.test.ts`, delete the `describe('isLanguageAssignable', ...)` block and remove `isLanguageAssignable` from the import (leaving `import { pendingRole } from ...`).

- [ ] **Step 8: Typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; all tests pass (eligibility now only tests `pendingRole`; google-chat, config, and the rest green).

- [ ] **Step 9: Commit**

```bash
git add src/index.ts src/assignment/eligibility.ts tests/unit/eligibility.test.ts
git commit -m "feat(review): assign reviewers to WAITING_REVIEW rows each tick"
```

---

## Task 7: Verify against the live site (manual)

No automated tests for the browser layer (project convention). Verify the Reviewer-column parse and the `WAITING_REVIEW` verification against the real site.

- [ ] **Step 1: Enable review + dry-run in the working config**

In `config/settings.yml` (gitignored working copy) set `assignment.dryRun: true` and add:

```yaml
review:
  enabled: true
  reviewers:
    lo-LA: "LO_T2@eqho.com"
```

- [ ] **Step 2: Run a dry-run tick and watch the logs**

Run: `npm run dev`
Expected: for a job whose `lo-LA` row is `WAITING_REVIEW`, the log shows `[DRY-RUN] would assign` with `role: "reviewer"`, `language: "lo-LA"`, `assignee: "LO_T2@eqho.com"`. For a `WAITING_TRANSLATION` row it shows `role: "translator"`. No errors; no real assignment. Stop with Ctrl+C.

- [ ] **Step 3 (operator, optional): one real assignment**

With a known `WAITING_REVIEW` lo-LA job, set `assignment.dryRun: false`, run `npm run dev` for one tick, and confirm in the TMS UI that the row's **Reviewer** column now shows `LO_T2@eqho.com` and a Google Chat "🔍 Reviewer assigned" card arrived. Revert `dryRun` afterward if desired.

---

## Final verification

- [ ] `npm run typecheck` → exit 0
- [ ] `npm test` → all green (eligibility `pendingRole`, config `review`, google-chat review card)
- [ ] Operator: dry-run shows `role: "reviewer"` for a WAITING_REVIEW lo-LA row
- [ ] Operator: one real review-assign fills the Reviewer column + posts a Chat card + does NOT add a Sheet row
