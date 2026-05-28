# Decoupled Review Scan (Fix B) — Design

**Date:** 2026-05-28
**Status:** Approved (design), pending implementation
**Related:** `2026-05-28-review-assign-design.md` (the reviewer-assignment feature this fixes)

## Problem

The reviewer-assignment feature assigns a fixed reviewer (`LO_T2@eqho.com`) to
`lo-LA` rows in `WAITING_REVIEW`. But it never fires, because the Job Board scan
only surfaces jobs created within `scan.lookbackHours` (24h):

- The scan filters the board by status `Available to Claim` + language + a
  **Created-date window** (`createdFrom = now - lookbackHours`), enforced both by
  the board filter and a client-side `isCreatedAfterCutoff` guard.
- A job needs review **after** it is translated. By the time `lo-LA` reaches
  `WAITING_REVIEW`, the job was usually created more than 24h ago, so it falls
  outside the window and the scan never lists it as a candidate.

Confirmed example: jobs `62466` (created 2026-05-27 09:01) and `62475` (created
2026-05-27 10:45). Both are `FULL` in `state.json` (the bot translated them on
2026-05-27) and are now `WAITING_REVIEW` on the board under `Available to Claim` +
`lo-LA` — but a 24h scan window (`createdFrom ≈ 2026-05-27 15:42 UTC`) returns
`found: 0` for them, so the reviewer is never assigned.

The 24h window exists deliberately to bound the **translation** backlog. It must
not be widened globally — that would make the bot start translating arbitrarily
old untranslated jobs. The review path needs its own, wider scan window.

## Goal

Find `lo-LA` jobs in `WAITING_REVIEW` regardless of whether they fall in the 24h
translation window, and assign the configured reviewer — **without** ever
assigning a *translator* to an aged backlog job, and without blowing the per-tick
time budget.

## Chosen approach

**Approach 1 — separate review scan pass with a wide, bounded Created window.**

Add a second scan pass that runs after the existing translation passes, for each
language that has a configured reviewer (currently `lo-LA` only). It uses a wider
Created window (`review.scanLookbackHours`, default **168h = 7 days**) instead of
the 24h translation window. Candidates found by this pass are tagged
`reviewOnly: true`; the processing loop assigns only **reviewers** to them
(translator rows are skipped, preserving the translation-backlog guard).

### Approaches considered (and why not)

- **Approach 2 — review pass with no Created filter (truly unlimited).** Rejected
  for now: pagination is unbounded (could hit `MAX_PAGES` every tick), and a large
  backlog could truncate before reaching the aged review jobs. A 7-day window
  covers all realistic review lag (reviews start 1–3 days after creation) while
  keeping pagination bounded. `review.scanLookbackHours` can be raised later if a
  longer lag is ever observed.
- **Approach 3 — state-driven recheck of bot-translated jobs.** Re-open jobs the
  bot marked `FULL` in `state.json` and check for `WAITING_REVIEW`, with no board
  re-scan. Rejected: it only covers jobs the **bot** translated, missing
  human-translated `lo-LA` jobs that also need a reviewer. The board re-scan covers
  both.

## Architecture

One pass of work (a *tick*) is unchanged in shape. `JobScanner.scan()` gains a
second collection pass; `src/index.ts` gains a one-line role guard and wires the
new inputs into the scanner. No other layer changes.

### Data flow

```
scan():
  nav + setStatusFilter("Available to Claim")

  # Translation pass (unchanged)
  setDateFilter(now - lookbackHours … now)            # 24h window, padded ±1 day
  for lang in [lo-LA, km-KH]:
      scanForLanguage(lang, translationCutoff)         # client-side cutoff
  → translationMap (Job, reviewOnly = false)

  # Review pass (new; only if reviewScan provided)
  setDateFilter(now - review.scanLookbackHours … now)  # 7d window, padded ±1 day
  for lang in reviewScan.languages:                    # [lo-LA]
      rows = scanForLanguage(lang, reviewCutoff)
      for r in rows:
          if translationMap.has(r.id): continue        # dedup — already a candidate
          if reviewScan.isSkippable(r.id): continue    # ABANDONED / still in cooldown
          reviewList.push({ ...r, reviewOnly: true })
  reviewList.sort(by id ascending)                     # oldest (longest-waiting) first
  reviewCandidates = reviewList.slice(0, review.maxCandidatesPerTick)

  translationCandidates = [...translationMap.values()]
      .sort(id desc).slice(0, scan.maxCandidatesPerTick)   # unchanged

  return [...translationCandidates, ...reviewCandidates]
```

Processing loop (`src/index.ts`), per detail-page language row — add one guard:

```ts
const role = pendingRole(lang, reviewers);
if (role === null) continue;
if (job.reviewOnly && role !== 'reviewer') continue;  // never translate aged backlog
```

Everything downstream (assigner, `classifyOutcome`, `state`, notifications,
sheets, health metrics) is unchanged: a `reviewOnly` job whose `lo-LA` row is
`WAITING_REVIEW` produces a `reviewed[lo-LA]` entry → Chat-only reviewer card
(never the Sheet) → `health.recordReview()` → `markProcessed` (FULL).

## Components

### `JobScanner` (`src/scraper/job-scanner.ts`)

New optional constructor input — when omitted, `scan()` behaves exactly as today
(no second pass), so the change is inert until wired:

```ts
interface ReviewScanOptions {
  languages: SupportedLanguage[];          // languages that have a configured reviewer
  lookbackHours: number;                   // review.scanLookbackHours (e.g. 168)
  maxCandidatesPerTick: number;            // review.maxCandidatesPerTick (e.g. 10)
  isSkippable: (jobId: string) => boolean; // state-backed: ABANDONED or still in cooldown
}
```

`scan()` runs the existing translation passes first, then (if `reviewScan` is
provided) re-sets the Created date filter to the wider window and runs the review
passes, building `reviewList` as above. The review pass reuses the existing
`scanForLanguage` / `collectAllPages` machinery (which re-asserts the status
filter, clears+sets the language filter, clicks Search, paginates, and applies the
client-side `isCreatedAfterCutoff` guard with the review cutoff).

The candidate type is `Job` with a new optional field `reviewOnly?: boolean`
(absent/false for translation candidates, `true` for review-pass candidates).

### Review-scan skip predicate (pure)

`isReviewScanSkippable(entry: ProcessedJobEntry | undefined, now: number): boolean`
— returns `true` when the job should NOT be re-surfaced by the review pass:

- `entry?.status === 'ABANDONED'` → true (we gave up on it)
- `entry?.recheckAfter && now < Date.parse(entry.recheckAfter)` → true (cooling down)
- otherwise false (including no entry, and `FULL` with no `recheckAfter`)

Pure and unit-tested. `src/index.ts` adapts it into the
`(jobId) => boolean` predicate by reading `state.getProcessedEntry(jobId)`.

Note `FULL`-with-no-`recheckAfter` is intentionally **not** skipped — that is
exactly the state of `62466`/`62475` (translated, now awaiting review). The first
re-open that finds nothing assignable sets `recheckAfter` (via `COOLDOWN_FULL`),
after which the predicate skips it for the cooldown window.

### Config (`src/storage/config.ts`, `config/settings.yml`, `Settings` type)

Extend the existing `review` block (both defaulted, so a `settings.yml` written
before this change still loads):

```ts
review: z.object({
  enabled: z.boolean(),
  scanLookbackHours: z.number().positive().default(168),       // 7 days
  maxCandidatesPerTick: z.number().int().positive().default(10),
  reviewers: z.object({ 'lo-LA': z.string().email().optional(),
                        'km-KH': z.string().email().optional() }).strict(),
}).optional()
```

`config/settings.yml`:

```yaml
review:
  enabled: true
  scanLookbackHours: 168    # review pass Created window (decoupled from scan.lookbackHours)
  maxCandidatesPerTick: 10  # separate per-tick cap for review-pass detail opens
  reviewers:
    lo-LA: "LO_T2@eqho.com"
```

### Wiring (`src/index.ts`)

- Build `reviewScan` options only when `settings.review?.enabled` and at least one
  reviewer email is configured; `languages` = the reviewer keys with a non-empty
  email.
- `isSkippable: (id) => isReviewScanSkippable(state.getProcessedEntry(id), Date.now())`.
- Pass `reviewScan` into `new JobScanner(...)` at **both** construction sites
  (initial construction and `rebuildPipeline`).
- Add the one-line `reviewOnly` role guard in the per-language loop.

## Why it is safe and self-limiting

- **Translation backlog stays bounded.** The `reviewOnly` guard skips translator
  rows, so the review pass can never cause a translator assignment on an aged job.
  `scan.lookbackHours` continues to govern translation exactly as before.
- **No per-tick churn.** A review job with nothing assignable (reviewer already
  set, or row not yet `WAITING_REVIEW`) yields `COOLDOWN_FULL`/`COOLDOWN_PARTIAL`,
  which sets `recheckAfter`; `isSkippable` then drops it from the review pass for
  the cooldown window.
- **No double work.** Review jobs still inside the 24h window are caught by the
  translation pass; the review pass dedups them via `translationMap`.
- **Bounded cost.** Review window 7 days + `maxCandidatesPerTick` (10) +
  `MAX_PAGES` (50) cap pagination and detail opens. Worst case ≈ 25 (translation)
  + 10 (review) = 35 detail opens/tick, comfortably under the 900s watchdog.
- **Failure lifecycle reused.** A failed reviewer assign records as `failed[]` →
  `ALL_FAILED`/`PARTIAL` → normal retry, and after `maxPartialRetries` →
  `ABANDONED` → skipped by the predicate.

## Edge cases

- **`reviewOnly` job with a mixed detail page** (`lo-LA` in `WAITING_REVIEW` +
  `km-KH` still `WAITING_TRANSLATION`, aged): the `km-KH` translator row is
  skipped by the guard. `classifyOutcome` uses "attempted" semantics
  (`assignedCount > 0 && failedCount === 0 → PROCESSED`), so assigning the `lo-LA`
  reviewer marks the job `FULL` without mis-classifying it `PARTIAL`. The aged
  `km-KH` is intentionally left for the translation path (it will only be acted on
  if it re-enters the 24h window). **No `outcome.ts` change required.**
- **`reviewOnly` job, `lo-LA` not assignable** (reviewer already present): all rows
  skipped → `assignedCount = 0, failedCount = 0, targetLanguageCount ≥ 1` →
  `COOLDOWN_FULL` → `recheckAfter` set → predicate skips next ticks.
- **Empty detail parse** (`targetLanguages.length === 0`, transient race): →
  `EMPTY_PARSE` → not persisted → retried next review scan. Unchanged.
- **Review disabled** (`reviewScan` undefined): `scan()` skips the second pass
  entirely; behavior identical to today.

## Out of scope / unchanged

- `outcome.ts`, notification routing (reviewer = Chat-only via `reviewedThisTick`),
  Google Sheets logging (reviewers never logged), `HealthMonitor.recordReview`,
  and the daily-summary "Reviews assigned" line — all already correct.

## Testing

- **Unit:** `isReviewScanSkippable` — ABANDONED → true; `recheckAfter` in future →
  true; `recheckAfter` in past → false; `FULL` no `recheckAfter` → false; no entry
  → false. Config loader — `review.scanLookbackHours` / `review.maxCandidatesPerTick`
  default when omitted; reject non-positive.
- **Browser layer** (`job-scanner.ts`) has no unit tests by project convention —
  verify live with `dryRun: true`: confirm the scan log shows a review pass that
  surfaces `62466`/`62475` as `reviewOnly` candidates, then have the operator flip
  `dryRun: false` for a real run.
