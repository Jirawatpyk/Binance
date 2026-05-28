# Google Sheets Assignment Logging — Design

**Date:** 2026-05-28
**Status:** Approved (design)
**Author:** brainstormed with the bot owner

## Purpose

Mirror every **real** (non-dry-run) translator assignment the bot makes into a
shared Google Sheet, so the team has a human-readable, append-only log of who
was assigned which job. Lao (`lo-LA`) and Khmer (`km-KH`) assignments go to
separate tabs of one spreadsheet.

This is a **secondary sink**: the live assignment, `state.json`, and the Google
Chat card remain the source of truth. A Sheets failure must never block, retry,
or fail a tick.

## Target spreadsheet

- **Spreadsheet ID:** `1Y1cua4PwwZaDdxOiZVbWK-YOsxvM9f1OMD2JHD46zC4`
- **Tabs:** `Lao Assign` (lo-LA), `Khmer Assign` (km-KH)
- **Columns written (C–G), one row per assigned language:**

  | Col | Field      | Source                         |
  |-----|------------|--------------------------------|
  | C   | Job ID     | `job.id`                       |
  | D   | File name  | `job.name`                     |
  | E   | Due Date   | `job.dueDate` → `YYYY-MM-DD HH:mm UTC` (empty if unknown) |
  | F   | WC         | `detail.wordCount`             |
  | G   | Assigned   | translator **full email** (e.g. `LO_T1@eqho.com`) |

  Columns A–B are left untouched (reserved for manual entry).

## Decisions (from brainstorming)

1. **Duplicate prevention:** dedup by **Job ID per tab**. Before appending, read
   the tab's column C and skip any item whose Job ID is already present. Because
   lo-LA only ever lands in the Lao tab and km-KH in the Khmer tab, Job-ID-within-tab
   uniqueness is equivalent to job+language uniqueness. Survives restart / state loss.
2. **Scope:** new assignments only — no backfill of historically-assigned jobs.
3. **Assigned column value:** full translator email.

## Authentication & prerequisites

- **Service account:** `email-fetcher-bot@email-fetcher-476604.iam.gserviceaccount.com`
- **Credentials file:** `./google-credentials.json` (now gitignored — never committed).
- **Prerequisite:** the spreadsheet MUST be shared with the service-account email
  as **Editor**, or writes return HTTP 403. Verified at startup (see below).
- **Scope:** `https://www.googleapis.com/auth/spreadsheets`.

## Approach

**Library:** `google-auth-library` (official, small) + the global `fetch` (Node 20).
Only two Sheets REST endpoints are needed — `values:append` (write) and
`values.get` (read column C for dedup) — so the full `googleapis` SDK is
unnecessary weight. This matches the project's lean ESM + `fetch` conventions.

(Considered and rejected: full `googleapis` SDK — too large for two calls;
hand-rolled JWT signing — fragile token handling, not worth it.)

## Architecture

A new sink module, parallel to `GoogleChatNotifier`, that does NOT touch the
assignment logic.

```
tick (index.ts)
  └─ after notifier.notifyAssignments(assignedThisTick)
       └─ await sheetsLogger.appendAssignments(assignedThisTick)   // best-effort
```

### Component: `src/integrations/google-sheets.ts` — `SheetsAssignmentLogger`

- `constructor(config: SheetsConfig, logger)`
- `async init(): Promise<void>` — load credentials, build a JWT auth client, and
  run a one-time connectivity check (open the spreadsheet, confirm both configured
  tabs exist). On failure: log error, alert, and set an internal `disabled` flag —
  the bot keeps assigning; Sheets logging is simply off.
- `async appendAssignments(items: AssignmentSummaryItem[]): Promise<void>` —
  never throws. For each item, split by assigned language → route to the matching
  tab. Per tab: read existing Job IDs (column C), drop duplicates, batch-append the
  remaining rows via `values:append` (range `'<tab>'!C:G`, `insertDataOption:
  INSERT_ROWS`, `valueInputOption: USER_ENTERED`). A single failure is logged; a
  sustained streak escalates to an error-level alert (same pattern as the notifier
  and state-save hardening). Always a no-op when `disabled` or when `items` is empty
  (dry-run produces no items).

### Pure logic (unit-tested): `buildSheetRows`

Extract the row-construction + dedup decision into a pure function:

```ts
buildSheetRows(
  items: AssignmentSummaryItem[],
  existingIdsByTab: Record<string, Set<string>>,
  tabMap: Record<SupportedLanguage, string>,
): Record<string /*tab*/, string[][] /*rows C..G*/>
```

It takes already-fetched existing Job IDs (so it has no I/O) and returns the rows
to append per tab. This is the testable core; the network/auth wrapper around it
is verified manually (like the browser layer).

## Config (`config/settings.yml`, zod-validated)

```yaml
sheets:
  enabled: true
  spreadsheetId: "1Y1cua4PwwZaDdxOiZVbWK-YOsxvM9f1OMD2JHD46zC4"
  credentialsPath: "./google-credentials.json"
  tabs:
    lo-LA: "Lao Assign"
    km-KH: "Khmer Assign"
```

- `enabled: false` → the logger is a complete no-op (mirrors "webhook not set").
- Added to `settings.example.yml` (with `enabled: false`) and to the zod schema
  in `src/storage/config.ts`. The credentials *file* is the only secret; the
  spreadsheet ID and tab names are not sensitive and live in settings.

## Error handling (must never break a tick)

| Failure | Behavior |
|---------|----------|
| Bad/missing credentials, init network error | log error + alert once, set `disabled`, bot continues assigning |
| Spreadsheet/tab not found at startup | same as above (clear message: check sharing / tab names) |
| `values:append` / `values.get` fails mid-tick | log; increment consecutive-failure counter; alert at threshold (3); never retry, never block the tick |
| 403 (not shared with service account) | surfaced via the init/append error path with a hint to share as Editor |

## Testing

- **Unit (pure):** `tests/unit/google-sheets.test.ts` for `buildSheetRows` —
  language split (lo-LA→Lao tab, km-KH→Khmer tab, a job with both → one row in
  each), dedup against `existingIdsByTab`, empty-input no-op, due-date formatting
  and empty-when-unknown, full-email in column G, column order C..G.
- **Manual smoke:** `scripts/test-sheets.ts` appends a clearly-marked test row to
  each tab to confirm credentials + Editor sharing on the real spreadsheet (the
  network/auth layer is not unit-tested, by the project's existing convention).
- The full existing suite (`npm test`) and `npm run typecheck` must stay green.

## Out of scope

- Backfilling historically-assigned jobs.
- Updating/curating existing rows (append-only).
- Reading the sheet for any purpose other than dedup.
- A Phase-2 dashboard (separate effort).

## Security note (done)

`google-credentials.json` and `*-credentials.json` were added to `.gitignore`
(commit `391f43b`); the file was not previously tracked, so no history scrub was
needed.
