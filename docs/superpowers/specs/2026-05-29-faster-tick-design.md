# Faster tick + lower new-job latency — Design

**Date:** 2026-05-29
**Status:** Approved (brainstorming) — ready for implementation plan
**Scope:** Reduce the time from a new `lo-LA`/`km-KH` job appearing on the board to it being assigned, without increasing load on the (fragile, occasionally-flaky) live `translationtms.com` site.

## Goal

Primary objective: **lower latency for new jobs.** Today a freshly-posted job is detected and assigned in roughly ~2 minutes; the target is ~1 minute, achieved safely.

Non-goals (explicitly out of scope — see "Rejected options"):
- Reworking the scan (pagination, filter timing) — the measured cost there is fixed-sleep/filter overhead, not pagination, and touching it risks the flaky-scan failure mode the reliability work just hardened against.
- Parallelising detail-page opens (adds simultaneous load — conflicts with the conservative-load constraint).
- Throttling the review scan — review jobs are claimed competitively, so the review pass must keep its current frequency.

## Measured baseline (real production tick, 2026-05-29 15:42:27, 48.6s total)

| Phase | Time | Notes |
|-------|------|-------|
| `ensureLoggedIn` | ~6s | re-verify board every tick |
| translation scan (lo-LA + km-KH) | ~11s | `found: 1` each — **fixed filter-setup, not pagination** |
| review scan (lo-LA) | ~7s | `found: 0` — fixed setup; kept frequent (competition) |
| open + parse detail | <1s | parse is cheap when row count is low |
| **assign cycle** | **~17s** | dominated by a ~15s wait on an **unverified success-toast selector** |
| sheet write | ~4s | best-effort |

Key finding: `confirmedBy: "row-cleared"` in the log proves the 15s toast wait **timed out fully** before the real (row-cleared) confirmation was used — i.e. ~15s of every real assignment is wasted on a selector that never matches.

## Changes

Two changes, both low-risk. They do not add page requests beyond the (user-accepted) higher poll frequency.

### Component 1 — Assign confirmation fix (`src/assignment/assigner.ts`)

**Problem.** After clicking the assignee button, `assign()` waits up to 15s for `.ant-message-success, .ant-notification-notice-success` (documented as unverified in CLAUDE.md) *before* falling back to the authoritative confirmations. On a real assign the toast never matches, so the full 15s elapses every time.

**Change.** Remove the blocking toast wait and rely on the confirmations the code already uses as fallback — they are the real proof, not the toast:

1. After `assigneeBtn.click()`, wait for the modal to close: `modal.waitFor({ state: 'hidden', timeout: 12_000 })`. Modal closing is the natural success signal (this wait already exists at the current line 87).
2. Keep the existing "modal still open ⇒ assign did not go through ⇒ throw `AssignmentFailedError`" check.
3. Keep the existing positive verification: re-select the Waiting tab and poll until the row for this language is no longer `expectClearedStatus` (current lines 102–126).
4. Set `confirmedBy` from whichever real proof fired (`'modal-closed'` / `'row-cleared'`). The toast is no longer awaited; if a brief, **non-blocking** toast peek is kept it must use a ≤1.5s timeout purely for the log label, never as a gate.

**Effect.** Assign tail drops from ~15s+ to ~2–4s (modal close + row clear). On a successful assign the 12s modal-hidden timeout never fully elapses; it only matters on a genuine failure, where the still-open check then fails the assign so the caller retries — same behaviour as today, minus the wasted 15s.

**Risk.** Low. `modal-hidden` + `row-cleared` are already the authoritative confirmations (the toast was explicitly "a fast-path hint — never the sole proof of success"). The change only removes a wait.

### Component 2 — Lower polling interval (`config/settings.yml`)

`polling.intervalMinutes: 3 → 1.5` (keep `jitterSeconds: 30`).

After Component 1, a work-tick is ~31s and an idle tick ~24s, so a 90s interval leaves comfortable margin. The Scheduler's existing "skip a tick if the previous one is still running" guard prevents pile-up if a tick occasionally runs long.

This is the single load/latency dial. It roughly doubles scan frequency (the only added load), which is acceptable per the agreed scope; if the site shows strain (rising zero-scan alerts / flaky scans) raise it toward 2 minutes.

## Data flow (unchanged in shape)

```
every ~1.5 min (was 3):
  ensureLoggedIn  →  translation scan (lo-LA, km-KH)  →  review scan (lo-LA)
                  →  per candidate: open detail → assign  ← assign now confirms in ~2-4s (was ~17s)
                  →  notify + sheet
```

Latency estimate: detection lag (avg interval/2) ~45s + tick-to-assign (~18s scan + ~3s assign) ≈ ~66s, versus ~125s today.

## Rejected options (and why)

- **Early-stop pagination scan.** No benefit at typical volume — the scan reads a single page (`found: 1`); the time is fixed filter-setup overhead, not pagination.
- **Trim the scanner's fixed `waitForTimeout` sleeps / remove redundant filter re-application.** Would save a few seconds but is high-risk on the flaky site (these settles guard against the `found: 0` flakiness already fought elsewhere) and the per-language status re-assert is deliberately defensive ("Ant Select may reset on language change").
- **Throttle the review scan.** Rejected — review jobs are competitively claimed; reducing review-scan frequency loses jobs to competitors.
- **Throttle `ensureLoggedIn` / make the sheet write non-blocking.** Deferred — `ensureLoggedIn` throttling touches session safety (risk), and the sheet write affects tick *duration* but not assignment *latency* (the goal). Can revisit later if tick duration becomes the binding constraint on interval.

## Testing & verification

- **`assigner.ts` is browser-layer** (no unit tests, per project convention) **and `dryRun: true` returns before the assign click**, so the new confirmation path is exercised only under `dryRun: false`. Verify from real production ticks: `tick complete durationMs` should drop materially (from ~48s) and the assign tail should shrink (watch `assignment submitted` timing and `confirmedBy`).
- **Interval:** confirm from logs that ticks do not overlap (Scheduler logs a skip when they would) and that `durationMs` stays below the 90s interval in steady state.

## Open assumptions to confirm against the live site

- The modal reliably reaches `state: 'hidden'` on a successful assign (the current log's `row-cleared` confirmation already works, so the proof chain is sound; modal-hidden is the same DOM the existing fallback observes).
- A 1.5-min interval does not measurably increase scan flakiness (monitor the consecutive-zero-scan alert after rollout).
