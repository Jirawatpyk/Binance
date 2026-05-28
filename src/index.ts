import 'dotenv/config';
import { loadSettings, loadTranslators } from './storage/config.js';
import { createLogger } from './core/logger.js';
import { StateStore } from './storage/state.js';
import { AssignmentEngine, type PickResult } from './assignment/engine.js';
import { AuthSession } from './auth/session.js';
import { JobScanner } from './scraper/job-scanner.js';
import { JobProcessor } from './scraper/job-processor.js';
import { Assigner } from './assignment/assigner.js';
import { Scheduler } from './core/scheduler.js';
import { retry } from './core/retry.js';
import { ProcessLock } from './core/lock.js';
import { captureScreenshot, cleanOldScreenshots } from './core/screenshot.js';
import type { Page } from 'playwright';
import { GoogleChatNotifier, type AssignmentSummaryItem, type ReviewSummaryItem } from './notifications/google-chat.js';
import { SheetsAssignmentLogger } from './integrations/google-sheets.js';
import type { SupportedLanguage, Settings, TranslatorsConfig } from './types/index.js';
import { ReAuthManager } from './auth/reauth-manager.js';
import { HealthMonitor } from './core/health-monitor.js';
import { runWithWatchdog } from './core/watchdog.js';
import { isBrowserDeadError } from './core/recovery-utils.js';
import { TranslatorNotFoundError } from './core/errors.js';
import { pendingRole } from './assignment/eligibility.js';
import { classifyOutcome } from './assignment/outcome.js';

const SETTINGS_PATH = process.env.SETTINGS_PATH ?? './config/settings.yml';
const TRANSLATORS_PATH = process.env.TRANSLATORS_PATH ?? './config/translators.yml';
const LOCK_PATH = './data/.lock';

async function main(): Promise<void> {
  let settings: Settings;
  let translators: TranslatorsConfig;
  try {
    settings = loadSettings(SETTINGS_PATH);
    translators = loadTranslators(TRANSLATORS_PATH);
  } catch (err) {
    // Config failed to load/validate. This throws before the normal logger/
    // notifier exist, so a Windows-service restart loop would otherwise be
    // silent — alert via a bootstrap notifier, then rethrow to exit.
    const msg = (err as Error).message;
    console.error('FATAL: config load failed —', msg);
    if (process.env.GOOGLE_CHAT_TEST_WEBHOOK_URL) {
      const bootLogger = createLogger({ level: 'error', logsDir: './logs', rotateDays: 1 });
      await new GoogleChatNotifier(process.env.GOOGLE_CHAT_TEST_WEBHOOK_URL, bootLogger)
        .notify(`Bot FAILED to start: config error — ${msg}. Fix config/settings.yml or config/translators.yml.`, 'error')
        .catch(() => {});
    }
    throw err;
  }
  const logger = createLogger({
    level: settings.logging.level,
    logsDir: settings.storage.logsDir,
    rotateDays: settings.logging.rotateDays,
  });

  // Validate-only mode: config + translators already loaded and zod-validated
  // above. Exit here WITHOUT acquiring the lock, launching a browser, or touching
  // the live board — so config can be safely checked (e.g. before a service
  // restart) without any risk of starting a real scan/assignment.
  if (process.argv.includes('--check-config')) {
    logger.info('config valid', {
      settingsPath: SETTINGS_PATH,
      translatorsPath: TRANSLATORS_PATH,
      dryRun: settings.assignment.dryRun,
    });
    return;
  }

  // Production (team) channel: ONLY the assignment / reviewer / daily-summary
  // cards go here (notifier.notifyAssignments / notifyReviews / notifyDailySummary),
  // so the team channel stays signal-only.
  const notifier = new GoogleChatNotifier(process.env.GOOGLE_CHAT_WEBHOOK_URL, logger);
  // Diagnostics (ops) channel: every lifecycle + alert message — bot started/
  // stopped, errors, browser recovery, re-auth, watchdog, scan/sheet alerts,
  // zero-scan — goes here instead, to keep ops noise off the team channel.
  // Falls back to log-only when GOOGLE_CHAT_TEST_WEBHOOK_URL is unset.
  const diagNotifier = new GoogleChatNotifier(process.env.GOOGLE_CHAT_TEST_WEBHOOK_URL, logger);
  // Best-effort mirror of real assignments into Google Sheets. Failures alert on
  // the diagnostics channel but never block a tick.
  const sheetsLogger = new SheetsAssignmentLogger(settings.sheets, logger, (msg) => {
    void diagNotifier.notify(msg, 'error');
  });

  if (!process.env.GOOGLE_CHAT_WEBHOOK_URL) {
    logger.warn('GOOGLE_CHAT_WEBHOOK_URL not set — assignment/summary cards are disabled');
  }
  if (!process.env.GOOGLE_CHAT_TEST_WEBHOOK_URL) {
    logger.warn('GOOGLE_CHAT_TEST_WEBHOOK_URL not set — ops/diagnostic alerts are log-only');
  }
  logger.info('bot starting', { node: process.version, dryRun: settings.assignment.dryRun });

  const lock = new ProcessLock(LOCK_PATH);
  const state = new StateStore(settings.storage.statePath);
  const session = new AuthSession(settings, logger);
  const health = new HealthMonitor('./data/health.json');
  let page: Page;
  let stateRecovered = false;
  let healthRecovered = false;
  try {
    await lock.acquire();
    logger.info('process lock acquired', { lockPath: LOCK_PATH });
    stateRecovered = await state.load();
    healthRecovered = await health.load();
    page = await session.start();
  } catch (err) {
    await diagNotifier.notify(`Bot FAILED to start: ${(err as Error).message} — check host logs`, 'error');
    throw err;
  }

  // A corrupt state.json/health.json was renamed to .corrupt.* and reset to
  // empty during load — silent data loss that can make the bot re-assign jobs
  // it already handled (state.json holds the processed ledger + RR counters).
  // Surface it loudly rather than let recovery hide it.
  if (stateRecovered || healthRecovered) {
    const files = [stateRecovered && 'state.json', healthRecovered && 'health.json']
      .filter(Boolean)
      .join(' + ');
    logger.error('recovered from corrupt persistence file(s) — reset to empty', { files });
    await diagNotifier
      .notify(
        `Recovered from corrupt ${files} (reset to empty; a .corrupt.* backup was kept). Round-robin counters / processed-job history were lost — the bot may re-assign jobs it already handled this cycle.`,
        'error'
      )
      .catch(() => {});
  }

  await sheetsLogger.init();

  let lastBrowserStart = Date.now();
  // Warn once when the session token drops under this many minutes to expiry;
  // re-armed automatically if a refresh extends it.
  const SESSION_EXPIRY_WARN_MIN = 90;
  let expiryAlerted = false;
  // The pre-expiry warning depends on reading auth_token from localStorage. If
  // that read keeps failing (e.g. TMS renames the key) the warning would die
  // silently — so we surface that too, gated so it alerts once until it recovers.
  let expiryReadFailedAlerted = false;
  // Persisting the refreshed token is best-effort, but a SUSTAINED failure
  // (disk full, cookies.json locked) silently reintroduces the stale-snapshot
  // bug. Swallow transient failures; alert once when they pile up past this.
  const SESSION_SAVE_FAILURE_ALERT_THRESHOLD = 3;
  let consecutiveSaveFailures = 0;
  // state.json holds the round-robin counters + processed/abandoned ledger. A
  // sustained write failure silently corrupts correctness (jobs re-assigned,
  // counters frozen on one translator), so escalate a streak like the session
  // save above rather than warn-and-forget every tick.
  const STATE_SAVE_FAILURE_ALERT_THRESHOLD = 3;
  let consecutiveStateSaveFailures = 0;

  // One-time maintenance at startup: bound state.json and screenshot disk usage.
  const prunedAtStart = state.pruneOldJobs(settings.scan.processedJobRetainHours);
  if (prunedAtStart > 0) {
    logger.info('pruned old processed jobs', { removed: prunedAtStart });
    await state.save();
  }
  await cleanOldScreenshots(settings.storage.logsDir, settings.logging.screenshotRetainDays);

  const scanAlert = (msg: string): void => {
    void diagNotifier.notify(msg, 'warn');
  };
  const engine = new AssignmentEngine(translators, state);
  // Per-language reviewer map (WAITING_REVIEW → reviewer), or undefined when the
  // review feature is off — pendingRole uses it to decide reviewer assignments.
  const reviewers = settings.review?.enabled ? settings.review.reviewers : undefined;
  let scanner = new JobScanner(page, logger, settings.scan, scanAlert);
  let processor = new JobProcessor(page, logger);
  let assigner = new Assigner(page, logger, settings.assignment.dryRun);

  const rebuildPipeline = (p: Page): void => {
    scanner = new JobScanner(p, logger, settings.scan, scanAlert);
    processor = new JobProcessor(p, logger);
    assigner = new Assigner(p, logger, settings.assignment.dryRun);
  };

  const reauth = new ReAuthManager({
    ensureLoggedIn: () => session.ensureLoggedIn(),
    notify: settings.reliability.reauth.alertOnExpiry
      ? (t, s) => diagNotifier.notify(t, s)
      : async () => {},
    logger,
    onPause: () => health.recordAuthEpisode(),
  });

  const tick = async (): Promise<void> => {
    const tickStart = Date.now();
    logger.info('tick started');
    health.recordTickStart();

    // Daily summary is a heartbeat — send it regardless of auth/work state.
    if (health.isDailySummaryDue(new Date(), settings.reliability.monitoring.dailySummaryTime)) {
      await notifier.notifyDailySummary(health.dailySummaryStats());
      health.markDailySummarySent();
      // Daily maintenance alongside the heartbeat. Best-effort: never let a
      // maintenance error abort the tick.
      try {
        const pruned = state.pruneOldJobs(settings.scan.processedJobRetainHours);
        if (pruned > 0) {
          logger.info('pruned old processed jobs', { removed: pruned });
          await state.save();
        }
        await cleanOldScreenshots(settings.storage.logsDir, settings.logging.screenshotRetainDays);
      } catch (err) {
        logger.warn('daily maintenance failed (non-fatal)', { error: (err as Error).message });
      }
    }

    if (!(await reauth.ensureReady())) {
      try {
        await health.save();
      } catch (err) {
        logger.warn('health.save failed (non-fatal)', { error: (err as Error).message });
      }
      return; // paused awaiting manual cookie refresh
    }

    // ReAuthManager.ensureReady() may have rebuilt the browser context (cookie
    // refresh) — adopt the new page into the pipeline.
    if (session.getPage() !== page) {
      page = session.getPage();
      rebuildPipeline(page);
      lastBrowserStart = Date.now();
      logger.info('pipeline rebuilt after context change (cookie refresh)');
    }

    // Proactive browser recycle for memory hygiene.
    if (Date.now() - lastBrowserStart >= settings.reliability.browserRecycleHours * 3_600_000) {
      logger.info('scheduled browser recycle (memory hygiene)');
      try {
        page = await session.recover();
        rebuildPipeline(page);
        lastBrowserStart = Date.now();
      } catch (err) {
        // recover() already closed the old browser before throwing (e.g. cookies
        // expired → LoginFailedError), so `page` now points at a dead browser.
        // Don't run the scan on it — defer this tick; next tick's
        // reauth.ensureReady() drives the clean PAUSED_AUTH flow. Count it as an
        // error (so a recurring recycle failure can trip the alert) and persist
        // health before bailing out of the tick.
        health.recordTickError();
        logger.error('browser recycle failed; deferring tick to next cycle', { error: (err as Error).message });
        await health.save().catch(() => {});
        return;
      }
    }

    const assignedThisTick: AssignmentSummaryItem[] = [];
    const reviewedThisTick: ReviewSummaryItem[] = [];
    try {
      health.recordPoll(); // a real board poll (we're past the auth-pause gate)
      const candidates = await scanner.scan();
      if (candidates.length === 0) {
        health.recordZeroScan();
        const zeros = health.getConsecutiveZeroScans();
        // Alert ONCE when the streak first reaches the threshold; the counter
        // resets to 0 the next time a scan finds work, which re-arms this. Always
        // logged, and routed to the diagnostics webhook (not production) to keep
        // the main channel quiet during genuinely empty-board stretches.
        if (zeros === settings.reliability.consecutiveZeroScanAlert) {
          logger.warn('zero-scan streak reached alert threshold', { consecutiveZeroScans: zeros });
          await diagNotifier.notify(
            `Scanned 0 candidates for ${settings.reliability.consecutiveZeroScanAlert} consecutive ticks — possible selector drift (or genuinely empty board)`,
            'warn'
          );
        }
      } else {
        health.resetZeroScans();
      }
      for (const job of candidates) {
        const entry = state.getProcessedEntry(job.id);
        // Skip only jobs we've given up on. Do NOT skip FULL jobs in general: a
        // job's lo-LA and km-KH rows can become claimable at different times, and
        // the board only re-surfaces a job (Available to Claim + language filter)
        // when it still has claimable work. Re-open it and let the live
        // Waiting-tab read decide which languages remain — an already-assigned
        // row is no longer WAITING_TRANSLATION, so pendingRole skips it
        // (no double-assign). Exception: a FULL job that recently re-opened to
        // nothing assignable (e.g. rows stuck in WAITING_REVIEW, which the board
        // still lists as claimable) is on cooldown to avoid re-opening it every
        // tick for no work.
        if (entry?.status === 'ABANDONED') continue;
        if (
          entry?.status === 'PARTIAL' &&
          (entry.retryCount ?? 0) >= settings.assignment.maxPartialRetries
        ) {
          logger.error('job exceeded max PARTIAL retries; abandoning', {
            jobId: job.id,
            retryCount: entry.retryCount,
            failed: entry.failed,
          });
          await diagNotifier.notify(
            `Job ${job.id} abandoned after ${settings.assignment.maxPartialRetries} PARTIAL retries — failed: ${entry.failed?.join(', ') ?? '?'}. Manual fix needed (check translators.yml / TMS).`,
            'error'
          );
          state.markAbandoned(job.id);
          continue; // persisted by the single save after the loop
        }
        // Cooldown is checked AFTER the abandon gate above so an exhausted
        // PARTIAL is still abandoned+alerted on schedule. A FULL job that
        // re-opened to nothing assignable (e.g. rows stuck in WAITING_REVIEW,
        // which the board still lists) waits out the cooldown before re-opening.
        // Status-blind: a newly-claimable language is delayed up to
        // scan.fullRecheckCooldownMinutes, self-healing at expiry. Corrupt
        // timestamp → NaN → does not skip (fail-open toward doing work).
        if (entry?.recheckAfter && Date.now() < new Date(entry.recheckAfter).getTime()) continue;
        if (settings.scan.detailPageDelayMs > 0) {
          await new Promise((r) => setTimeout(r, settings.scan.detailPageDelayMs));
        }
        try {
          logger.info('processing job', { jobId: job.id, name: job.name });
          const detail = await processor.open(job.detailUrl, job.id);
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
                () => assigner.assign(lang.code, assignee, lang.rowIndex, expectCleared, role),
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
              } else if (role === 'translator') {
                // Real translator assignment only (dry-run never affects metrics/
                // RR). Kept separate from reviewer counts so the daily summary's
                // translation figures (assigned/byLang/failed) stay consistent.
                health.recordAssignment(true, lang.code);
                if (pick?.useRoundRobin && pick.rrKey) {
                  state.incrementRR(pick.rrKey);
                }
              } else {
                // Real reviewer assignment — counted in its own daily-summary
                // metric, not blended into the translation figures.
                health.recordReview();
              }
            } catch (err) {
              if (isBrowserDeadError(err)) throw err; // bubble to outer handler for browser recovery
              failed.push(lang.code);
              if (role === 'translator') health.recordAssignment(false, lang.code);
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
          // Dry-run is preview-only: never persist processed-job state, otherwise
          // dry-run would mark jobs FULL and the eventual live run would skip them.
          if (!settings.assignment.dryRun) {
            // Pure decision (unit-tested in outcome.test.ts); side effects below.
            const outcome = classifyOutcome({
              assignedCount: Object.keys(assigned).length + Object.keys(reviewed).length,
              failedCount: failed.length,
              targetLanguageCount: detail.targetLanguages.length,
              prevStatus: entry?.status,
            });
            switch (outcome) {
              case 'PROCESSED':
                state.markProcessed(job.id, assigned);
                break;
              case 'PARTIAL':
                state.markPartial(job.id, assigned, failed);
                break;
              case 'ALL_FAILED':
                logger.error('all language assignments failed for job', { jobId: job.id, failed });
                state.markPartial(job.id, {}, failed);
                break;
              case 'EMPTY_PARSE':
                // Board matched lo-LA/km-KH but the Waiting tab parsed zero such
                // rows — a transient render/load race or work claimed since the
                // scan. Don't mark it done; leave unpersisted to re-check next tick.
                logger.warn('no lo-LA/km-KH rows parsed on detail page — not marking processed, will retry next tick', { jobId: job.id });
                await captureScreenshot(page, settings.storage.logsDir, `empty-detail-${job.id}`, settings.logging.screenshotMaxPerDay).catch(() => null);
                break;
              case 'COOLDOWN_PARTIAL':
              case 'COOLDOWN_FULL': {
                // Rows existed but none were assignable (already assigned, or in
                // WAITING_REVIEW). Cool down the re-check so the board re-listing
                // this job doesn't re-open it every tick. PARTIAL keeps its
                // status (preserving failed[]/retryCount → ABANDONED net).
                const recheckAfter = new Date(
                  Date.now() + settings.scan.fullRecheckCooldownMinutes * 60_000
                ).toISOString();
                logger.info('job has no assignable rows — cooling down recheck', { jobId: job.id, recheckAfter });
                if (outcome === 'COOLDOWN_PARTIAL') state.setRecheckAfter(job.id, recheckAfter);
                else state.markProcessed(job.id, {}, recheckAfter);
                break;
              }
            }
          }
        } catch (err) {
          if (isBrowserDeadError(err)) throw err; // bubble to outer handler for recovery
          logger.error('job processing error', { jobId: job.id, error: (err as Error).message });
          await captureScreenshot(page, settings.storage.logsDir, `job-${job.id}`, settings.logging.screenshotMaxPerDay).catch(() => null);
          await diagNotifier.notify(`Job ${job.id} processing error: ${(err as Error).message}`, 'error');
        }
      }
      health.recordTickSuccess();

      // Session maintenance (best-effort; never fail the tick):
      //  1) Persist the current session so any JWT the app refreshed this tick
      //     survives a restart (the stale-snapshot-on-restart problem).
      //  2) Warn before the token expires so it can be refreshed proactively.
      const expMs = await session.getAuthExpiryMs().catch((e) => {
        logger.debug('reading auth token expiry failed', { error: (e as Error).message });
        return null;
      });

      // expMs === null means we could not read the token expiry on a session
      // ensureLoggedIn just declared valid — token absent, key renamed, or eval
      // failed. That silently disables BOTH save-gating and the expiry warning,
      // so surface it (gated) rather than no-op.
      if (expMs === null) {
        if (!expiryReadFailedAlerted) {
          await diagNotifier
            .notify(
              'Could not read TMS session token expiry — the pre-expiry warning is not functioning. Check whether the TMS app changed its auth_token storage.',
              'warn'
            )
            .catch(() => {});
          expiryReadFailedAlerted = true;
        }
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
            consecutiveSaveFailures += 1;
            logger.error('persisting session failed', {
              error: (e as Error).message,
              consecutiveSaveFailures,
            });
            if (consecutiveSaveFailures === SESSION_SAVE_FAILURE_ALERT_THRESHOLD) {
              await diagNotifier
                .notify(
                  `Failed to persist the TMS session ${consecutiveSaveFailures}× in a row (cookies.json may be locked or the disk full). On restart the bot will load a stale token and likely pause for re-auth.`,
                  'error'
                )
                .catch(() => {});
            }
          }
        }

        const minsLeft = Math.max(0, Math.round((expMs - Date.now()) / 60_000));
        if (minsLeft <= SESSION_EXPIRY_WARN_MIN && !expiryAlerted) {
          await diagNotifier
            .notify(
              `TMS session token expires in ~${minsLeft}m — refresh the session (npm run capture-cookies) before it dies, or the bot will pause for re-auth`,
              'warn'
            )
            .catch(() => {});
          expiryAlerted = true;
        } else if (minsLeft > SESSION_EXPIRY_WARN_MIN) {
          expiryAlerted = false; // token was refreshed/extended — re-arm the warning
        }
      }
    } catch (err) {
      if (isBrowserDeadError(err)) {
        logger.error('browser died; recovering', { error: (err as Error).message });
        await diagNotifier.notify('Browser crashed — recovering', 'warn');
        try {
          page = await session.recover();
          rebuildPipeline(page);
          lastBrowserStart = Date.now();
        } catch (recoverErr) {
          // recover() can itself throw (e.g. cookies gone → LoginFailedError).
          // Don't let it escape the tick uncounted/un-alerted: record the error
          // and notify. The next tick's reauth.ensureReady() drives PAUSED_AUTH
          // if the session is genuinely expired.
          health.recordTickError();
          logger.error('browser recovery failed', { error: (recoverErr as Error).message });
          await diagNotifier.notify(`Browser recovery failed: ${(recoverErr as Error).message}`, 'error');
        }
      } else {
        health.recordTickError();
        logger.error('tick failed', { error: (err as Error).message });
        if (health.shouldAlertErrorRate(settings.reliability.monitoring.consecutiveErrorAlert)) {
          await diagNotifier.notify(
            `Bot failing: ${settings.reliability.monitoring.consecutiveErrorAlert} consecutive ticks errored`,
            'error'
          );
        }
      }
    } finally {
      // Persist this tick's state mutations in one write — in finally so a
      // browser-dead throw (recovered in the catch above) still saves processed/
      // abandoned status and the round-robin counters. No-op if nothing changed.
      // A single failure is swallowed; a sustained one is alerted at error level
      // because it silently corrupts correctness (duplicate assigns, frozen RR).
      try {
        await state.save();
        consecutiveStateSaveFailures = 0;
      } catch (e) {
        consecutiveStateSaveFailures += 1;
        logger.error('state.save failed', {
          error: (e as Error).message,
          consecutiveStateSaveFailures,
        });
        if (consecutiveStateSaveFailures === STATE_SAVE_FAILURE_ALERT_THRESHOLD) {
          await diagNotifier
            .notify(
              `state.json failed to save ${consecutiveStateSaveFailures}× in a row — round-robin counters and processed-job history are not persisting. The bot may re-assign jobs and skew translator load until this is fixed (check disk space / file locks).`,
              'error'
            )
            .catch(() => {});
        }
      }
    }

    // Anti-spam: one summary card per cycle for all jobs assigned this tick —
    // sent even if the tick later threw (browser crash mid-loop) so assignments
    // are never silently dropped.
    await notifier.notifyAssignments(assignedThisTick);
    // Mirror the same real assignments into Google Sheets (best-effort).
    await sheetsLogger.appendAssignments(assignedThisTick);
    // Reviewer assignments notify Chat only — never the Sheet.
    await notifier.notifyReviews(reviewedThisTick);

    try {
      await health.save();
    } catch (err) {
      logger.warn('health.save failed (non-fatal)', { error: (err as Error).message });
    }
    logger.info('tick complete', { durationMs: Date.now() - tickStart });
  };

  const guardedTick = (): Promise<void> =>
    runWithWatchdog(tick, settings.reliability.watchdog.tickTimeoutMs, () => {
      logger.error('tick hung beyond watchdog timeout; exiting for service restart', {
        tickTimeoutMs: settings.reliability.watchdog.tickTimeoutMs,
      });
      // Hard-exit safety net: fires even if notify hangs in a wedged event loop.
      setTimeout(() => process.exit(1), 6_000).unref();
      void diagNotifier
        .notify('Bot tick hung — exiting for auto-restart', 'error')
        .catch(() => {})
        .finally(() => process.exit(1));
    });

  const scheduler = new Scheduler(
    { intervalMinutes: settings.polling.intervalMinutes, jitterSeconds: settings.polling.jitterSeconds },
    guardedTick,
    logger
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return; // a second SIGINT/SIGTERM must not re-run teardown
    shuttingDown = true;
    // Hard-exit backstop: guarantee the process exits even if an await below
    // stalls (e.g. a wedged browser close or webhook). Generous enough to let
    // the normal waitForIdle(30s) finish first.
    const hardExit = setTimeout(() => process.exit(0), 40_000);
    hardExit.unref();
    try {
      scheduler.stop('shutdown');
      await scheduler.waitForIdle(30_000);
      await state.save();
      await health.save();
      await session.close();
      await lock.release();
      logger.info('shutdown complete');
      await diagNotifier.notify('Bot stopped', 'info');
    } catch (err) {
      // Never let a teardown failure surface as an unhandled rejection — exit cleanly.
      logger.error('error during shutdown (exiting anyway)', { error: (err as Error).message });
    } finally {
      clearTimeout(hardExit);
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await diagNotifier.notify(
    `Bot started (dryRun=${settings.assignment.dryRun}, interval=${settings.polling.intervalMinutes}min)`,
    'info'
  );
  scheduler.start();
}

main().catch((err) => {
  console.error('fatal error:', err);
  process.exit(1);
});
