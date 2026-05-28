# Decoupled Review Scan (Fix B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find `lo-LA` jobs in `WAITING_REVIEW` that fall outside the 24h translation scan window and assign their configured reviewer, without ever assigning a translator to aged backlog.

**Architecture:** Add a second scan pass in `JobScanner.scan()` that uses a wide bounded Created window (`review.scanLookbackHours`, default 7 days) for the configured-reviewer languages only. Its candidates are tagged `reviewOnly: true`; a one-line guard in the processing loop assigns only reviewers to them. A pure state-skip predicate keeps abandoned/cooling-down jobs out of the pass. Everything downstream (assigner, outcome classification, notifications, sheets, health) is unchanged.

**Tech Stack:** TypeScript (ESM, NodeNext — import local modules with `.js`), Playwright, zod, winston, vitest.

**Spec:** `docs/superpowers/specs/2026-05-28-review-scan-decoupled-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/types/index.ts` | Shared types | Add `Job.reviewOnly?: boolean`; add `scanLookbackHours` + `maxCandidatesPerTick` to `Settings.review` |
| `src/storage/config.ts` | zod config loader | Add the two defaulted fields to the `review` zod block |
| `src/scraper/review-scan-skip.ts` (new) | Pure: should the review pass skip a job? | New `isReviewScanSkippable(entry, now)` |
| `src/scraper/job-scanner.ts` | Board scanning | Optional `reviewScan` ctor input + second (review) pass |
| `src/index.ts` | Tick orchestration | Build the `reviewScan` options + skip predicate, pass to both `JobScanner` constructions, add the `reviewOnly` role guard |
| `config/settings.example.yml` | Committed config template | Document the two new review fields |
| `tests/unit/config-loader.test.ts` | Config tests | Default + explicit + reject cases for the new fields |
| `tests/unit/review-scan-skip.test.ts` (new) | Pure-helper tests | Full truth table for `isReviewScanSkippable` |

Browser-layer files (`job-scanner.ts`, `index.ts`) have no unit tests by project convention (CLAUDE.md) — they are gated by `npm run typecheck` here and verified live with `dryRun: true` in Task 6.

---

## Task 0: Create the feature branch

**Files:** none (git only)

- [ ] **Step 1: Branch off master**

Run:
```bash
git checkout master
git pull --ff-only
git checkout -b feat/decoupled-review-scan
```
Expected: now on branch `feat/decoupled-review-scan`, working tree clean (the spec from the prior step is already committed on master).

---

## Task 1: Config — add `review.scanLookbackHours` + `review.maxCandidatesPerTick`

**Files:**
- Modify: `src/types/index.ts` (the `review?` block of `Settings`, ~lines 62-65)
- Modify: `src/storage/config.ts` (the `review` zod object, ~lines 70-82)
- Test: `tests/unit/config-loader.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these three tests inside the existing `describe('loadSettings', ...)` block in `tests/unit/config-loader.test.ts` (after the `'rejects a typo'd reviewer language key (strict)'` test). Each repeats the full YAML, matching the file's existing style:

```ts
  it('defaults review.scanLookbackHours (168) and maxCandidatesPerTick (10) when omitted', () => {
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
    expect(s.review?.scanLookbackHours).toBe(168);
    expect(s.review?.maxCandidatesPerTick).toBe(10);
  });

  it('accepts explicit review.scanLookbackHours and maxCandidatesPerTick', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
review: { enabled: true, scanLookbackHours: 240, maxCandidatesPerTick: 5, reviewers: { lo-LA: "LO_T2@eqho.com" } }
`);
    const s = loadSettings(p);
    expect(s.review?.scanLookbackHours).toBe(240);
    expect(s.review?.maxCandidatesPerTick).toBe(5);
  });

  it('rejects a non-positive review.maxCandidatesPerTick', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
review: { enabled: true, maxCandidatesPerTick: 0, reviewers: { lo-LA: "LO_T2@eqho.com" } }
`);
    expect(() => loadSettings(p)).toThrow();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/config-loader.test.ts -t "review.scanLookbackHours"`
Expected: the two default/explicit tests FAIL (`s.review?.scanLookbackHours` is `undefined`, not `168`/`240`). The reject test currently PASSES vacuously because `maxCandidatesPerTick: 0` is an unknown key under a non-`.strict()` object and is silently stripped — it will become a real assertion only after Step 3 adds the field. That's fine; the two failing tests prove the new behavior is missing.

- [ ] **Step 3: Add the fields to the zod schema**

In `src/storage/config.ts`, replace the `review` block (currently):

```ts
  review: z
    .object({
      enabled: z.boolean(),
      reviewers: z
        .object({
          'lo-LA': z.string().email().optional(),
          'km-KH': z.string().email().optional(),
        })
        // .strict() so a typo'd key (e.g. lo_LA) fails fast at load instead of
        // being silently stripped — which would leave that language un-reviewed.
        .strict(),
    })
    .optional(),
```

with:

```ts
  review: z
    .object({
      enabled: z.boolean(),
      // The review scan uses a WIDER Created window than scan.lookbackHours so
      // jobs that reach WAITING_REVIEW days after creation are still found.
      // Defaulted so a settings.yml written before this field still loads.
      scanLookbackHours: z.number().positive().default(168),
      // Separate per-tick cap for review-pass detail opens (kept off the
      // translation cap so review work is never starved by a translation burst).
      maxCandidatesPerTick: z.number().int().positive().default(10),
      reviewers: z
        .object({
          'lo-LA': z.string().email().optional(),
          'km-KH': z.string().email().optional(),
        })
        // .strict() so a typo'd key (e.g. lo_LA) fails fast at load instead of
        // being silently stripped — which would leave that language un-reviewed.
        .strict(),
    })
    .optional(),
```

- [ ] **Step 4: Add the fields to the `Settings` type**

In `src/types/index.ts`, replace:

```ts
  review?: {
    enabled: boolean;
    reviewers: Partial<Record<SupportedLanguage, string>>;
  };
```

with:

```ts
  review?: {
    enabled: boolean;
    scanLookbackHours: number;
    maxCandidatesPerTick: number;
    reviewers: Partial<Record<SupportedLanguage, string>>;
  };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/config-loader.test.ts`
Expected: PASS (all existing review/sheets tests still pass; the three new ones pass).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/storage/config.ts src/types/index.ts tests/unit/config-loader.test.ts
git commit -m "feat(config): add review.scanLookbackHours + maxCandidatesPerTick (defaulted)"
```

---

## Task 2: Pure helper `isReviewScanSkippable`

**Files:**
- Create: `src/scraper/review-scan-skip.ts`
- Test: `tests/unit/review-scan-skip.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/review-scan-skip.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isReviewScanSkippable } from '../../src/scraper/review-scan-skip.js';
import type { ProcessedJobEntry } from '../../src/types/index.js';

const now = Date.parse('2026-05-28T12:00:00.000Z');

function entry(p: Partial<ProcessedJobEntry>): ProcessedJobEntry {
  return { processedAt: '2026-05-27T00:00:00.000Z', status: 'FULL', assigned: {}, ...p };
}

describe('isReviewScanSkippable', () => {
  it('does not skip when there is no entry (never processed)', () => {
    expect(isReviewScanSkippable(undefined, now)).toBe(false);
  });

  it('does not skip a FULL job with no recheckAfter (translated, awaiting review)', () => {
    expect(isReviewScanSkippable(entry({ status: 'FULL' }), now)).toBe(false);
  });

  it('skips an ABANDONED job', () => {
    expect(isReviewScanSkippable(entry({ status: 'ABANDONED' }), now)).toBe(true);
  });

  it('skips a job still inside its cooldown window', () => {
    expect(isReviewScanSkippable(entry({ recheckAfter: '2026-05-28T13:00:00.000Z' }), now)).toBe(true);
  });

  it('does not skip once the cooldown window has passed', () => {
    expect(isReviewScanSkippable(entry({ recheckAfter: '2026-05-28T11:00:00.000Z' }), now)).toBe(false);
  });

  it('does not skip when recheckAfter is unparseable (fail-open toward doing work)', () => {
    expect(isReviewScanSkippable(entry({ recheckAfter: 'not-a-date' }), now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/review-scan-skip.test.ts`
Expected: FAIL — cannot import `isReviewScanSkippable` (module does not exist).

- [ ] **Step 3: Implement the helper**

Create `src/scraper/review-scan-skip.ts`:

```ts
import type { ProcessedJobEntry } from '../types/index.js';

/**
 * Should the decoupled review scan skip re-surfacing this job?
 *
 * Skip jobs we have given up on (ABANDONED) and jobs still inside their cooldown
 * window (recheckAfter in the future — set when a FULL job re-opened to nothing
 * assignable). A FULL job with no recheckAfter is NOT skipped: that is a
 * translated job awaiting review, which is exactly what the review pass is for.
 * A missing entry is not skipped (never processed). A corrupt recheckAfter parses
 * to NaN and does not skip — fail-open toward doing work, matching the tick loop.
 */
export function isReviewScanSkippable(
  entry: ProcessedJobEntry | undefined,
  now: number
): boolean {
  if (!entry) return false;
  if (entry.status === 'ABANDONED') return true;
  if (entry.recheckAfter) {
    const t = Date.parse(entry.recheckAfter);
    if (!Number.isNaN(t) && now < t) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/review-scan-skip.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/scraper/review-scan-skip.ts tests/unit/review-scan-skip.test.ts
git commit -m "feat(scraper): add isReviewScanSkippable pure predicate"
```

---

## Task 3: `JobScanner` review pass + `Job.reviewOnly`

**Files:**
- Modify: `src/types/index.ts` (the `Job` interface, ~lines 3-12)
- Modify: `src/scraper/job-scanner.ts`

No unit test (browser layer, per CLAUDE.md). Gated by `npm run typecheck` here; behavior verified live in Task 6.

- [ ] **Step 1: Add `reviewOnly` to the `Job` type**

In `src/types/index.ts`, replace the `Job` interface:

```ts
export interface Job {
  id: string;
  name: string;
  dueDate: Date;
  project: string;
  languageCount: number;
  languagesNeeded: string[];
  wordCount: number;
  detailUrl: string;
}
```

with:

```ts
export interface Job {
  id: string;
  name: string;
  dueDate: Date;
  project: string;
  languageCount: number;
  languagesNeeded: string[];
  wordCount: number;
  detailUrl: string;
  // True when this candidate was surfaced ONLY by the decoupled review scan
  // (created beyond the translation window). The tick loop assigns a reviewer to
  // such candidates but never a translator — see src/index.ts.
  reviewOnly?: boolean;
}
```

- [ ] **Step 2: Import `SupportedLanguage` and declare `ReviewScanOptions` in the scanner**

In `src/scraper/job-scanner.ts`, change the types import (currently):

```ts
import { type Job, SUPPORTED_LANGUAGES } from '../types/index.js';
```

to:

```ts
import { type Job, type SupportedLanguage, SUPPORTED_LANGUAGES } from '../types/index.js';
```

Then add this interface immediately after the existing `ScanConfig` interface (after its closing `}`):

```ts
/**
 * Optional decoupled review-scan inputs. When provided, scan() runs a second
 * pass (wider Created window) for these languages and tags the results
 * reviewOnly. When omitted, scan() behaves exactly as before (translation only).
 */
export interface ReviewScanOptions {
  languages: SupportedLanguage[];          // languages that have a configured reviewer
  lookbackHours: number;                   // review.scanLookbackHours (e.g. 168)
  maxCandidatesPerTick: number;            // review.maxCandidatesPerTick (e.g. 10)
  isSkippable: (jobId: string) => boolean; // state-backed: ABANDONED or still cooling down
}
```

- [ ] **Step 3: Accept `reviewScan` in the constructor**

In `src/scraper/job-scanner.ts`, replace the constructor:

```ts
  constructor(
    private page: Page,
    private logger: winston.Logger,
    private scanConfig: ScanConfig,
    // Optional operator alert for silent-degradation cases (date filter failed
    // to apply, pagination cap hit). Fire-and-forget; must never throw.
    private onAlert: (msg: string) => void = () => {},
  ) {}
```

with:

```ts
  constructor(
    private page: Page,
    private logger: winston.Logger,
    private scanConfig: ScanConfig,
    // Optional operator alert for silent-degradation cases (date filter failed
    // to apply, pagination cap hit). Fire-and-forget; must never throw.
    private onAlert: (msg: string) => void = () => {},
    // Optional decoupled review scan. Undefined → no second pass (legacy behavior).
    private reviewScan?: ReviewScanOptions,
  ) {}
```

- [ ] **Step 4: Run the review pass at the end of `scan()`**

In `src/scraper/job-scanner.ts`, in `scan()`, replace this trailing block (currently):

```ts
    let candidates = [...jobMap.values()];

    // Sort newest first (by job ID descending — higher IDs are more recent)
    candidates.sort((a, b) => Number(b.id) - Number(a.id));

    // Enforce the per-tick safety cap
    if (candidates.length > this.scanConfig.maxCandidatesPerTick) {
      this.logger.warn('candidate count exceeds cap; truncating', {
        found: candidates.length,
        cap: this.scanConfig.maxCandidatesPerTick,
      });
      candidates = candidates.slice(0, this.scanConfig.maxCandidatesPerTick);
    }

    this.logger.info('job scan complete', {
      candidates: candidates.length,
      candidateIds: candidates.map((j) => j.id),
    });
    return candidates;
  }
```

with:

```ts
    let candidates = [...jobMap.values()];

    // Sort newest first (by job ID descending — higher IDs are more recent)
    candidates.sort((a, b) => Number(b.id) - Number(a.id));

    // Enforce the per-tick safety cap
    if (candidates.length > this.scanConfig.maxCandidatesPerTick) {
      this.logger.warn('candidate count exceeds cap; truncating', {
        found: candidates.length,
        cap: this.scanConfig.maxCandidatesPerTick,
      });
      candidates = candidates.slice(0, this.scanConfig.maxCandidatesPerTick);
    }

    // Decoupled review pass: surface aged WAITING_REVIEW jobs the translation
    // window hides. Deduped against ALL translation candidates found this tick
    // (jobMap, including any truncated above) so a job is never both.
    const reviewCandidates = await this.scanForReview(jobMap);

    const all = [...candidates, ...reviewCandidates];
    this.logger.info('job scan complete', {
      candidates: candidates.length,
      reviewCandidates: reviewCandidates.length,
      candidateIds: all.map((j) => j.id),
    });
    return all;
  }
```

- [ ] **Step 5: Add the `scanForReview` private method**

In `src/scraper/job-scanner.ts`, add this method immediately after `scan()` (before the `// Private helpers` divider, or anywhere in the class body):

```ts
  /**
   * Second scan pass for jobs that need a REVIEWER. Uses a wider Created window
   * (reviewScan.lookbackHours) than the translation pass so jobs that reached
   * WAITING_REVIEW days after creation are still found, but only for languages
   * with a configured reviewer. Results are tagged reviewOnly so the tick loop
   * assigns a reviewer (never a translator) to them. Returns [] when no
   * reviewScan was provided. Deduped against the translation candidates and
   * filtered by the state-backed skip predicate; oldest (lowest id) first so the
   * longest-waiting review jobs win the per-tick cap.
   */
  private async scanForReview(translationMap: Map<string, Job>): Promise<Job[]> {
    const rs = this.reviewScan;
    if (!rs || rs.languages.length === 0) return [];

    const reviewTo = new Date();
    const reviewFrom = new Date(Date.now() - rs.lookbackHours * 3600_000);
    this.logger.info('review scan window', {
      lookbackHours: rs.lookbackHours,
      createdFrom: reviewFrom.toISOString(),
      createdTo: reviewTo.toISOString(),
      languages: rs.languages,
    });

    // Re-set the board Created filter to the wider review window. Same ±1 day
    // padding the translation pass uses (the board filter is date-only / local
    // tz); the exact UTC cutoff is still enforced client-side in collectAllPages.
    const DAY_MS = 24 * 3600_000;
    await this.setDateFilter(
      new Date(reviewFrom.getTime() - DAY_MS),
      new Date(reviewTo.getTime() + DAY_MS)
    );

    const reviewList: Job[] = [];
    const seen = new Set<string>();
    for (const lang of rs.languages) {
      this.logger.info('scanning review language', { lang });
      const jobs = await this.scanForLanguage(lang, reviewFrom);
      for (const job of jobs) {
        if (translationMap.has(job.id)) continue; // already a translation candidate
        if (seen.has(job.id)) continue;           // dedup across review languages
        if (rs.isSkippable(job.id)) continue;     // ABANDONED / still cooling down
        seen.add(job.id);
        reviewList.push({ ...job, reviewOnly: true });
      }
      this.logger.info('review language scan complete', { lang, found: jobs.length });
    }

    // Oldest first so the longest-waiting review jobs are processed before newer
    // ones when the cap bites (lower id == older job).
    reviewList.sort((a, b) => Number(a.id) - Number(b.id));
    if (reviewList.length > rs.maxCandidatesPerTick) {
      this.logger.warn('review candidate count exceeds cap; truncating', {
        found: reviewList.length,
        cap: rs.maxCandidatesPerTick,
      });
      return reviewList.slice(0, rs.maxCandidatesPerTick);
    }
    return reviewList;
  }
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (The existing `new JobScanner(...)` calls in `src/index.ts` still compile because `reviewScan` is optional; they get wired in Task 4.)

- [ ] **Step 7: Run the full unit suite (nothing should regress)**

Run: `npm test`
Expected: PASS (no new tests here; confirms types still line up).

- [ ] **Step 8: Commit**

```bash
git add src/types/index.ts src/scraper/job-scanner.ts
git commit -m "feat(scraper): add decoupled review scan pass (reviewOnly candidates)"
```

---

## Task 4: Wire the review scan into the tick loop

**Files:**
- Modify: `src/index.ts`

No unit test (orchestration layer, per CLAUDE.md). Gated by `npm run typecheck`.

- [ ] **Step 1: Import the skip predicate**

In `src/index.ts`, add this import next to the other `./assignment` / `./scraper` imports (e.g. just after the existing `import { pendingRole } from './assignment/eligibility.js';`):

```ts
import { isReviewScanSkippable } from './scraper/review-scan-skip.js';
```

- [ ] **Step 2: Build the `reviewScan` options after `reviewers`**

In `src/index.ts`, find (currently ~line 162-165):

```ts
  const engine = new AssignmentEngine(translators, state);
  // Per-language reviewer map (WAITING_REVIEW → reviewer), or undefined when the
  // review feature is off — pendingRole uses it to decide reviewer assignments.
  const reviewers = settings.review?.enabled ? settings.review.reviewers : undefined;
  let scanner = new JobScanner(page, logger, settings.scan, scanAlert);
```

and replace it with:

```ts
  const engine = new AssignmentEngine(translators, state);
  // Per-language reviewer map (WAITING_REVIEW → reviewer), or undefined when the
  // review feature is off — pendingRole uses it to decide reviewer assignments.
  const reviewers = settings.review?.enabled ? settings.review.reviewers : undefined;
  // Decoupled review scan: a second board pass (wider Created window) that finds
  // aged WAITING_REVIEW jobs for the configured-reviewer languages only. Skips
  // jobs we've abandoned or that are still cooling down (isReviewScanSkippable).
  const reviewScan =
    reviewers && settings.review
      ? {
          languages: (Object.keys(reviewers) as SupportedLanguage[]).filter((k) => reviewers[k]),
          lookbackHours: settings.review.scanLookbackHours,
          maxCandidatesPerTick: settings.review.maxCandidatesPerTick,
          isSkippable: (jobId: string) =>
            isReviewScanSkippable(state.getProcessedEntry(jobId), Date.now()),
        }
      : undefined;
  let scanner = new JobScanner(page, logger, settings.scan, scanAlert, reviewScan);
```

- [ ] **Step 3: Pass `reviewScan` into the rebuilt scanner too**

In `src/index.ts`, find (currently ~line 169-173):

```ts
  const rebuildPipeline = (p: Page): void => {
    scanner = new JobScanner(p, logger, settings.scan, scanAlert);
    processor = new JobProcessor(p, logger);
    assigner = new Assigner(p, logger, settings.assignment.dryRun);
  };
```

and replace the scanner line so it becomes:

```ts
  const rebuildPipeline = (p: Page): void => {
    scanner = new JobScanner(p, logger, settings.scan, scanAlert, reviewScan);
    processor = new JobProcessor(p, logger);
    assigner = new Assigner(p, logger, settings.assignment.dryRun);
  };
```

- [ ] **Step 4: Add the `reviewOnly` role guard in the per-language loop**

In `src/index.ts`, find (currently ~line 314-316):

```ts
          for (const lang of detail.targetLanguages) {
            const role = pendingRole(lang, reviewers);
            if (role === null) continue;
```

and replace with:

```ts
          for (const lang of detail.targetLanguages) {
            const role = pendingRole(lang, reviewers);
            if (role === null) continue;
            // Review-scan candidates are surfaced beyond the 24h translation
            // window; only assign their reviewer, never a translator (that would
            // defeat the scan.lookbackHours backlog guard).
            if (job.reviewOnly && role !== 'reviewer') continue;
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`SupportedLanguage` is already imported in `src/index.ts`; `state.getProcessedEntry` already exists and is used elsewhere in the loop.)

- [ ] **Step 6: Run the full unit suite**

Run: `npm test`
Expected: PASS (unchanged count — orchestration is not unit-tested).

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): wire decoupled review scan + reviewOnly role guard"
```

---

## Task 5: Document the new config in the committed example

**Files:**
- Modify: `config/settings.example.yml` (the `review` block, ~lines 60-66)

`config/settings.yml` is gitignored and gets the zod defaults (168/10) automatically, so the running bot needs no edit — but the committed template should document the knobs.

- [ ] **Step 1: Update the example review block**

In `config/settings.example.yml`, replace:

```yaml
review:
  # Assign a fixed reviewer to lo-LA rows in WAITING_REVIEW (after translation is
  # done). Disabled by default. Only languages listed here get a reviewer; others
  # are skipped. Dry-run gates this exactly like translator assignment.
  enabled: false
  reviewers:
    lo-LA: "LO_T2@eqho.com"
```

with:

```yaml
review:
  # Assign a fixed reviewer to lo-LA rows in WAITING_REVIEW (after translation is
  # done). Disabled by default. Only languages listed here get a reviewer; others
  # are skipped. Dry-run gates this exactly like translator assignment.
  enabled: false
  # A SECOND scan pass finds jobs that reached WAITING_REVIEW after they aged out
  # of scan.lookbackHours (reviews start days after a job is created). This is its
  # own Created window, decoupled from the translation window. Default 168h (7d).
  scanLookbackHours: 168
  # Separate per-tick cap for review-pass detail opens (oldest reviews first), so
  # review work is never starved by a translation burst. Default 10.
  maxCandidatesPerTick: 10
  reviewers:
    lo-LA: "LO_T2@eqho.com"
```

- [ ] **Step 2: Commit**

```bash
git add config/settings.example.yml
git commit -m "docs(config): document review.scanLookbackHours + maxCandidatesPerTick"
```

---

## Task 6: Live verification (operator-run, dry-run first)

**Files:** none (runtime verification). Run by the operator — not from an automated session, to avoid the ProcessLock conflict and because the live board cannot be driven without cookies.

**Preconditions:**
- `data/cookies.json` is fresh (`npm run capture-cookies` if the session is stale).
- `config/settings.yml` has `assignment.dryRun: true` and `review.enabled: true` with `reviewers.lo-LA: "LO_T2@eqho.com"`. (No need to add `scanLookbackHours`/`maxCandidatesPerTick` — defaults apply — but you may add them to override.)

- [ ] **Step 1: Static gates**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all unit tests PASS.

- [ ] **Step 2: Dry-run the bot and watch the logs**

Run: `npm run dev`
Watch `logs/app-*.log` (JSON) for one full tick and confirm:
- a `"scan window"` line (24h translation window) AND a `"review scan window"` line (~168h) with `languages: ["lo-LA"]`.
- `"job scan complete"` shows a non-zero `reviewCandidates` count and `candidateIds` that include the aged review jobs (expect **62466** and **62475**, which are FULL-translated and now WAITING_REVIEW).
- for those review candidates, a `"[DRY-RUN] would assign"` line with `role: "reviewer"`, `assignee: "LO_T2@eqho.com"` — and **no** `role: "translator"` dry-run line for an aged job.

Expected: the above all hold. If `reviewCandidates: 0`, check that the jobs are still listed under board filter "Available to Claim" + lo-LA and were created within `scanLookbackHours`.

- [ ] **Step 3: Stop the dry-run**

Press `Ctrl+C`; confirm a clean `"shutdown complete"` in the log.

- [ ] **Step 4: Go live (operator decision)**

Only after Step 2 looks correct: set `assignment.dryRun: false` in `config/settings.yml`, restart (`npm run dev` or the Windows service), and confirm on the next tick a real `"assignment submitted"` log with `role: "reviewer"` for an aged job, a `🔍 Reviewer assigned` card on the production Chat channel, and that the job leaves the Waiting tab (status → REVIEWING). The Google Sheet must NOT gain a row for the reviewer (reviewers are Chat-only).

---

## Task 7: Finish the branch

- [ ] **Step 1: Final full-suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 2: Open the PR (or merge per the prior workflow)**

```bash
git push -u origin feat/decoupled-review-scan
gh pr create --title "Decoupled review scan (Fix B): find aged WAITING_REVIEW jobs" --body "$(cat <<'EOF'
## Summary
- Adds a second scan pass (wide bounded Created window, default 7d) that surfaces lo-LA jobs in WAITING_REVIEW which aged out of the 24h translation window, so the configured reviewer (LO_T2) is finally assigned (e.g. 62466/62475).
- Review-pass candidates are tagged `reviewOnly`; a one-line loop guard assigns only reviewers to them — translators are never assigned to aged backlog.
- New `isReviewScanSkippable` predicate keeps ABANDONED / cooling-down jobs out of the pass. New config `review.scanLookbackHours` (168) + `review.maxCandidatesPerTick` (10), both defaulted.

## Test plan
- [ ] `npm run typecheck` clean
- [ ] `npm test` green (new: config defaults, isReviewScanSkippable truth table)
- [ ] Live dry-run shows `review scan window` + 62466/62475 as reviewOnly candidates with `role: reviewer` (no translator dry-run on aged jobs)
- [ ] Live `dryRun:false`: reviewer assigned, production Chat card, no Sheet row
EOF
)"
```

Then follow the established review/merge workflow (squash-merge after review).

---

## Self-Review

**Spec coverage:**
- Wide bounded review window (`review.scanLookbackHours`, 168) → Task 1 (config) + Task 3 (`scanForReview` uses it). ✓
- `Job.reviewOnly` tag → Task 3. ✓
- `reviewOnly` role guard (never translate aged backlog) → Task 4 Step 4. ✓
- `isReviewScanSkippable` (ABANDONED / cooldown; FULL-no-recheck not skipped) → Task 2. ✓
- Dedup vs translation candidates + oldest-first + per-tick cap → Task 3 `scanForReview`. ✓
- `review.maxCandidatesPerTick` separate budget → Task 1 + Task 3. ✓
- Wiring at both `JobScanner` construction sites → Task 4 Steps 2-3. ✓
- "No change to outcome.ts / notifications / sheets / health" → none of those files are touched. ✓
- Testing: unit (config defaults, predicate truth table) + live dry-run for the browser layer → Tasks 1, 2, 6. ✓
- Config documented in committed example → Task 5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. ✓

**Type consistency:** `ReviewScanOptions` fields (`languages`, `lookbackHours`, `maxCandidatesPerTick`, `isSkippable`) are identical in the scanner declaration (Task 3 Step 2) and the index.ts literal (Task 4 Step 2). `isReviewScanSkippable(entry, now)` signature matches its test (Task 2), its implementation (Task 2), and the call site (Task 4: `state.getProcessedEntry(jobId)`, `Date.now()`). `Job.reviewOnly?: boolean` defined in Task 3 Step 1, consumed in Task 4 Step 4. `Settings.review.scanLookbackHours`/`maxCandidatesPerTick` defined in Task 1 (type + zod), consumed in Task 4 Step 2. ✓
