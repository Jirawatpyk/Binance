# Reviewer Assignment (WAITING_REVIEW) — Design

**Date:** 2026-05-28
**Status:** Approved (design)
**Author:** brainstormed with the bot owner

## Purpose

Extend the auto-assign bot so it also assigns a **reviewer** to `lo-LA` rows that
are waiting for review (`WAITING_REVIEW`), in addition to the existing behavior of
assigning a **translator** to rows waiting for translation (`WAITING_TRANSLATION`).

A `lo-LA` row's lifecycle on translationtms.com:
`WAITING_TRANSLATION` → (translator assigned, translated) → `WAITING_REVIEW` → (reviewer assigned) → `REVIEWING` → … → published.

Today the bot assigns the translator and then **skips/cools-down** the row once it
reaches `WAITING_REVIEW`. This feature fills the **Reviewer** with a fixed reviewer.

## Confirmed against the live site (Job #62403)

A `lo-LA` row in `WAITING_REVIEW`:

- Detail-page **Waiting tab** columns (0-indexed `td`): `Language(0) · Due Date(1) · Translator(2) · Reviewer(3) · Progress(4) · Status(5) · Actions(6)`.
- The row has the **Translator** already set (e.g. `LO_T4@eqho.com`), **Reviewer** = `-` (empty), Progress 100%, Status tag `WAITING_REVIEW`, and an **Assign** button (the same one used for translation).
- Clicking **Assign** opens a modal titled "Assign Strings - lo-LA" with **"Current Step: WAITING_REVIEW / Required Role: REVIEWER"**, listing eligible reviewers as `li.ant-list-item` rows (e.g. `LO_E1@eqho.com`, `LO_T2@eqho.com`), each with its own **Assign** button and `REVIEWER` / `lo-LA` tags — the **same modal structure** the translator flow already drives.

So the existing `Assigner` modal logic works unchanged except for its post-assign verification.

## Decisions (from brainstorming)

1. **Scope: lo-LA only**, reviewer = `LO_T2@eqho.com`. km-KH review is out of scope (no reviewer configured → review skipped).
2. **Reviewer is fixed** (not word-count based): a config map `review.reviewers['lo-LA'] = 'LO_T2@eqho.com'`.
3. **Notify Google Chat** on a successful reviewer assignment.
4. **Do NOT log reviewer assignments to Google Sheets** — review-assigns are kept out of the sheet pipeline entirely.

## Approach

**Generalize "assignment" to carry a role** (`translator` | `reviewer`) rather than
duplicating a parallel review path. The Assign modal flow is identical for both
roles, so the existing `Assigner` is reused; only assignee *selection* and the
post-assign *verification status* differ by role.

(Rejected: a separate `ReviewAssigner`/path — duplicates the identical modal logic;
a hardcoded `LO_T2` hack — not configurable, conflates roles.)

## Architecture & components

### Data model — `src/types/index.ts`
`TargetLanguage` gains `reviewer: string | null`. `JobProcessor.parseLanguageRows`
reads the **Reviewer** column (`td` index 3), normalizing `-`/empty → `null`, in
addition to the existing translator (index 2) and status (index 5).

### Role resolution (pure) — `src/assignment/eligibility.ts`
Replace the boolean `isLanguageAssignable` with a role resolver:

```ts
type AssignRole = 'translator' | 'reviewer';
function pendingRole(lang: TargetLanguage, hasReviewer: (code) => boolean): AssignRole | null
```

- `WAITING_TRANSLATION` && `translator === null` → `'translator'`
- `WAITING_REVIEW` && `reviewer === null` && `hasReviewer(lang.code)` → `'reviewer'`
- otherwise → `null`

`hasReviewer` is true only for languages present in the review config (so km-KH,
unconfigured, yields `null` → review skipped). Pure and unit-tested.

### Reviewer selection — config
A new optional `review` block in `config/settings.yml` (zod-validated, toggleable):

```yaml
review:
  enabled: true
  reviewers:
    lo-LA: "LO_T2@eqho.com"
```

- `review.enabled: false` (or block omitted) → the feature is a no-op: `pendingRole`
  never returns `'reviewer'` (treated as no reviewer configured).
- The reviewer for a row is `review.reviewers[lang.code]` (a fixed lookup; no
  word-count rules). Translator selection is unchanged (`AssignmentEngine.pick`).

### Assigner — `src/assignment/assigner.ts`
`assign()` gains an `expectClearedStatus` argument (`'WAITING_TRANSLATION'` |
`'WAITING_REVIEW'`). The whole modal interaction is unchanged (open Assign → wait
for `li.ant-list-item` → filter by the assignee email → click that row's Assign →
confirm modal closed). The **positive verification** re-reads the Waiting tab and
fails if a row for this language still shows `expectClearedStatus` (today this is
hardcoded to `WAITING_TRANSLATION`). After a reviewer assign, the row leaves
`WAITING_REVIEW`, so the check uses `WAITING_REVIEW`.

### Tick loop & state — `src/index.ts`
For each candidate row, resolve `pendingRole`:
- `'translator'` → assignee via `AssignmentEngine.pick(lang, wordCount)`;
  `assigner.assign(code, translator, rowIndex, 'WAITING_TRANSLATION')`. Recorded in
  `assignedThisTick` (→ Chat card **and** Sheet, unchanged).
- `'reviewer'` → assignee = `review.reviewers[code]`;
  `assigner.assign(code, reviewer, rowIndex, 'WAITING_REVIEW')`. Recorded in a
  **separate** `reviewedThisTick` list (→ Chat card only, **never** the Sheet).

Idempotency is by live re-read, exactly as today: once the reviewer is set, the
row is no longer `WAITING_REVIEW` (and `reviewer !== null`), so `pendingRole`
returns `null` and it is not re-assigned. The existing "don't skip FULL jobs,
re-open and let the live read decide" logic already re-surfaces a translated job
when it reaches `WAITING_REVIEW`; after the reviewer is assigned the row becomes
`REVIEWING` (not assignable) and the existing cooldown handles it. Dry-run gates
reviewer assignment exactly like translator assignment (no state/metrics/notify in
dry-run).

The per-tick outcome classification (`classifyOutcome` → PROCESSED/PARTIAL/
COOLDOWN_*) treats a reviewer assignment as an assignment for that tick (so a tick
that only assigned a reviewer is PROCESSED, not COOLDOWN). Health metrics may
count reviewer assignments; exact metric placement is an implementation detail
that must keep dry-run excluded.

### Notifications — `src/notifications/google-chat.ts`
`reviewedThisTick` posts a Chat card (or a distinct section/line, e.g.
"🔍 Reviewer assigned — lo-LA → LO_T2") on real (non-dry-run) reviewer assigns.
It is **not** added to `assignedThisTick`, so `SheetsAssignmentLogger` never sees
reviewer assignments — the sheet stays translator-only.

## Error handling

- A reviewer not found in the modal list (`review.reviewers[code]` isn't an
  eligible reviewer for that locale) → `TranslatorNotFoundError` (existing path) →
  the per-language failure handler records it; the row is retried/cooled like any
  failed assign. Never crashes the tick.
- All existing reliability behavior (never-throw notifier/sheets, watchdog,
  per-job try/catch, browser recovery) is unchanged.

## Testing

- **Pure (unit):** `pendingRole` — translator / reviewer / null across status ×
  translator/reviewer-null × hasReviewer combinations; the `review` zod schema
  (present, omitted, `enabled:false`, missing reviewer email).
- **Browser layer (no unit tests, by project convention):** the Reviewer-column
  parse and the `expectClearedStatus` verification are verified by running
  `npm run dev` with `dryRun: true` against the live site, plus a manual check
  against a real `WAITING_REVIEW` lo-LA row.

## Out of scope

- km-KH reviewer assignment (no reviewer configured).
- Word-count-based reviewer selection (reviewer is fixed per language).
- Logging reviewer assignments to Google Sheets.
- Anything beyond filling the Reviewer on `WAITING_REVIEW` rows (the review process
  itself, approvals, publishing).
