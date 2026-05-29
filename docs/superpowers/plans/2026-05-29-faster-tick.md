# Faster Tick + Lower New-Job Latency — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the time from a new lo-LA/km-KH job appearing to being assigned (~2 min → ~1 min) by removing a wasted 15s wait in the assign path and polling more frequently.

**Architecture:** Two small, low-risk changes — (P1) `assigner.ts` confirms an assignment via the modal closing + the row leaving the Waiting tab (the proofs it already uses as fallback) instead of first blocking up to 15s on an unverified success-toast selector; (P2) lower `polling.intervalMinutes` from 3 to 1.5. No scan, review-scan, or session changes (see spec "Rejected options").

**Tech Stack:** TypeScript (ESM, NodeNext), Playwright, vitest, YAML config (zod-validated).

**Spec:** `docs/superpowers/specs/2026-05-29-faster-tick-design.md`
**Branch:** `feat/faster-tick`

> **Testing note (project convention, from CLAUDE.md):** the browser layer (`scraper/`, `auth/`, `assignment/assigner.ts`) has **no automated tests by design** and is verified by running the bot. Additionally, `dryRun: true` returns from `Assigner.assign()` *before* the assignee click, so the changed confirmation path runs only under `dryRun: false` (real production assigns). Task 1 is therefore verified by `npm run typecheck` + observing a real production tick, not by a unit test. This is intentional, not a gap.

---

### Task 1: Remove the blocking success-toast wait in the assign confirmation path

**Files:**
- Modify: `src/assignment/assigner.ts` (the block from `await assigneeBtn.click();` to the end of `assign()`, currently lines 77–134)

- [ ] **Step 1: Replace the post-click confirmation block**

In `src/assignment/assigner.ts`, replace this exact block:

```typescript
    await assigneeBtn.click();
    // The Ant success toast selector is unverified against a real assign, so it
    // is only a fast-path hint — never the sole proof of success.
    const sawToast = await this.page
      .locator('.ant-message-success, .ant-notification-notice-success')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    await modal.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
    if (await modal.isVisible().catch(() => false)) {
      // Modal still open ⇒ the assign did not go through (error stayed in the dialog).
      throw new AssignmentFailedError('modal still open after assign', {
        language,
        role,
        assignee,
        rowIndex,
      });
    }

    // Positive verification independent of the unverified toast: on a real
    // assign the row leaves the Waiting tab. Re-read it; if a row for this
    // language is still WAITING_TRANSLATION, the assign did NOT take — fail so
    // the caller retries instead of silently recording a false success.
    await this.selectWaitingTab(false);
    const stillWaitingRow = () =>
      this.page
        .locator('table tbody tr')
        .filter({ hasText: language })
        .filter({ hasText: expectClearedStatus })
        .count()
        .catch(() => 0);
    // Poll briefly: the Waiting list can take a moment to drop the assigned row.
    // Succeed as soon as it clears rather than failing on one slow read (which
    // would cause a needless retry + false failure metric).
    let stillWaiting = await stillWaitingRow();
    const deadline = Date.now() + 3_000;
    while (stillWaiting > 0 && Date.now() < deadline) {
      await this.page.waitForTimeout(300);
      stillWaiting = await stillWaitingRow();
    }
    if (stillWaiting > 0) {
      throw new AssignmentFailedError(`row still ${expectClearedStatus} after assign — not confirmed`, {
        language,
        role,
        assignee,
        rowIndex,
      });
    }

    this.logger.info('assignment submitted', {
      language,
      role,
      assignee,
      confirmedBy: sawToast ? 'toast' : 'row-cleared',
    });
```

with this:

```typescript
    await assigneeBtn.click();

    // Success closes the modal; that — together with the row leaving the Waiting
    // tab below — is the authoritative confirmation of the assign. The Ant
    // success-toast selector is unverified and never matched in practice, so we
    // no longer block on it: a real assign previously wasted the full 15s toast
    // timeout here before falling back to these same proofs.
    await modal.waitFor({ state: 'hidden', timeout: 12_000 }).catch(() => {});
    if (await modal.isVisible().catch(() => false)) {
      // Modal still open ⇒ the assign did not go through (error stayed in the dialog).
      throw new AssignmentFailedError('modal still open after assign', {
        language,
        role,
        assignee,
        rowIndex,
      });
    }

    // Positive verification: on a real assign the row leaves the Waiting tab.
    // Re-read it; if a row for this language is still expectClearedStatus, the
    // assign did NOT take — fail so the caller retries instead of silently
    // recording a false success.
    await this.selectWaitingTab(false);
    const stillWaitingRow = () =>
      this.page
        .locator('table tbody tr')
        .filter({ hasText: language })
        .filter({ hasText: expectClearedStatus })
        .count()
        .catch(() => 0);
    // Poll briefly: the Waiting list can take a moment to drop the assigned row.
    // Succeed as soon as it clears rather than failing on one slow read (which
    // would cause a needless retry + false failure metric).
    let stillWaiting = await stillWaitingRow();
    const deadline = Date.now() + 3_000;
    while (stillWaiting > 0 && Date.now() < deadline) {
      await this.page.waitForTimeout(300);
      stillWaiting = await stillWaitingRow();
    }
    if (stillWaiting > 0) {
      throw new AssignmentFailedError(`row still ${expectClearedStatus} after assign — not confirmed`, {
        language,
        role,
        assignee,
        rowIndex,
      });
    }

    this.logger.info('assignment submitted', {
      language,
      role,
      assignee,
      confirmedBy: 'row-cleared',
    });
```

The only changes: the `sawToast` toast-wait block is deleted, the modal-hidden timeout is raised 10s → 12s (it is now the primary success signal, not a fallback), and `confirmedBy` is the constant `'row-cleared'`.

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: no output / exit 0. (If `AssignmentFailedError`/`TranslatorNotFoundError` show as unused, they are still used elsewhere in `assign()` — do not remove imports.)

- [ ] **Step 3: Confirm the existing unit suite is unaffected**

Run: `npm test`
Expected: all tests pass (assigner has no unit tests; this confirms nothing else broke).

- [ ] **Step 4: Smoke that the surrounding flow still boots**

Run: `npm run smoke`
Expected: `SMOKE OK — cookie session valid`. (Smoke does not assign; it only confirms the build + session path are intact.)

- [ ] **Step 5: Commit**

```bash
git add src/assignment/assigner.ts
git commit -m "perf(assigner): drop the 15s unverified-toast wait from assign confirmation

A real assign waited the full 15s toast timeout (the .ant-message-success
selector is unverified and never matches) before falling back to the real
proofs. Confirm via modal-hidden (primary) + row-cleared (positive) directly,
cutting ~15s off every real assignment.

Spec: docs/superpowers/specs/2026-05-29-faster-tick-design.md"
```

- [ ] **Step 6: Post-deploy verification (manual, after the branch runs in production with `dryRun: false`)**

Watch the structured logs for a real assign. Expected vs the 2026-05-29 baseline:
- `assignment submitted` now logs `confirmedBy: "row-cleared"` and arrives ~2–4s after the assignee click (was ~17s).
- `tick complete durationMs` drops materially from ~48s on a tick that assigns one job.
If the modal does NOT reliably reach `hidden` on success (assign starts failing with `modal still open after assign`), revert this task — but the prior log already confirmed the row-cleared proof works, so this is not expected.

---

### Task 2: Lower the polling interval 3 → 1.5 minutes

**Files:**
- Modify: `config/settings.example.yml` (committed template)
- Modify: `config/settings.yml` (runtime working copy — gitignored, **not** committed; change it so the new cadence actually takes effect)

- [ ] **Step 1: Update the committed example template**

In `config/settings.example.yml`, change:

```yaml
polling:
  intervalMinutes: 3
  jitterSeconds: 30
```

to:

```yaml
polling:
  intervalMinutes: 1.5   # poll every ~90s for lower new-job latency; the single load/latency dial — raise toward 2 if scans turn flaky
  jitterSeconds: 30
```

(`intervalMinutes` is validated as `z.number().positive()` in `src/storage/config.ts`, so the fractional value is accepted.)

- [ ] **Step 2: Mirror the change into the runtime working copy**

In `config/settings.yml`, make the identical `intervalMinutes: 3 → 1.5` change so the running bot uses the new cadence. (This file is gitignored and will not be committed.)

- [ ] **Step 3: Verify config still loads/validates**

Run: `npm run typecheck`
Expected: exit 0.
Then sanity-load the config (it parses + zod-validates on startup):
Run: `npm run smoke`
Expected: `SMOKE OK` (a failing/invalid config would throw before the session check).

- [ ] **Step 4: Commit the template change**

```bash
git add config/settings.example.yml
git commit -m "perf(config): poll every 1.5 min (was 3) for lower new-job latency

Enabled by the faster assign confirmation (the tick now fits well under a 90s
interval); the scheduler's skip-if-running guard still prevents overlap.

Spec: docs/superpowers/specs/2026-05-29-faster-tick-design.md"
```

- [ ] **Step 5: Post-deploy verification (manual)**

In the logs confirm: ticks do not overlap (no repeated "skipped — previous tick still running" warnings in steady state), and `tick complete durationMs` stays comfortably below 90s. Watch the consecutive-zero-scan alert for any rise (a sign 1.5 min is too aggressive for the site — raise toward 2 min if so).

---

## Self-Review

**Spec coverage:**
- P1 (remove 15s toast wait, use modal-hidden + row-cleared) → Task 1. ✓
- P2 (intervalMinutes 3 → 1.5) → Task 2. ✓
- Rejected options (scan / review-scan / session / sheet) → no tasks, as intended. ✓
- Testing notes (browser layer not unit-tested; dryRun skips assign; verify via production logs) → captured in the header note + Task 1 Steps 2–6 and Task 2 Step 5. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" — both code blocks are complete and literal. ✓

**Type/identifier consistency:** `AssignmentFailedError`, `selectWaitingTab(false)`, `expectClearedStatus`, `confirmedBy`, `intervalMinutes` all match the existing code in `assigner.ts` / `config.ts`. The replacement preserves every identifier except the deleted `sawToast`. ✓
