import 'dotenv/config';
import { loadSettings, loadTranslators } from './storage/config.js';
import { createLogger } from './core/logger.js';
import { StateStore } from './storage/state.js';
import { AssignmentEngine } from './assignment/engine.js';
import { AuthSession } from './auth/session.js';
import { JobScanner } from './scraper/job-scanner.js';
import { JobProcessor } from './scraper/job-processor.js';
import { Assigner } from './assignment/assigner.js';
import { Scheduler } from './core/scheduler.js';
import { retry } from './core/retry.js';
import { ProcessLock } from './core/lock.js';
import { captureScreenshot, cleanOldScreenshots } from './core/screenshot.js';
import type { Page } from 'playwright';
import { GoogleChatNotifier, type AssignmentSummaryItem } from './notifications/google-chat.js';
import type { SupportedLanguage } from './types/index.js';
import { ReAuthManager } from './auth/reauth-manager.js';
import { HealthMonitor } from './core/health-monitor.js';
import { runWithWatchdog } from './core/watchdog.js';
import { isBrowserDeadError } from './core/recovery-utils.js';
import { TranslatorNotFoundError } from './core/errors.js';
import { isLanguageAssignable } from './assignment/eligibility.js';

const SETTINGS_PATH = process.env.SETTINGS_PATH ?? './config/settings.yml';
const TRANSLATORS_PATH = process.env.TRANSLATORS_PATH ?? './config/translators.yml';
const LOCK_PATH = './data/.lock';

async function main(): Promise<void> {
  const settings = loadSettings(SETTINGS_PATH);
  const translators = loadTranslators(TRANSLATORS_PATH);
  const logger = createLogger({
    level: settings.logging.level,
    logsDir: settings.storage.logsDir,
    rotateDays: settings.logging.rotateDays,
  });

  const notifier = new GoogleChatNotifier(process.env.GOOGLE_CHAT_WEBHOOK_URL, logger);

  if (!process.env.GOOGLE_CHAT_WEBHOOK_URL) {
    logger.warn('GOOGLE_CHAT_WEBHOOK_URL not set — Google Chat notifications are disabled');
  }
  logger.info('bot starting', { node: process.version, dryRun: settings.assignment.dryRun });

  const lock = new ProcessLock(LOCK_PATH);
  const state = new StateStore(settings.storage.statePath);
  const session = new AuthSession(settings, logger);
  const health = new HealthMonitor('./data/health.json');
  let page: Page;
  try {
    await lock.acquire();
    logger.info('process lock acquired', { lockPath: LOCK_PATH });
    await state.load();
    await health.load();
    page = await session.start();
  } catch (err) {
    await notifier.notify(`Bot FAILED to start: ${(err as Error).message} — check host logs`, 'error');
    throw err;
  }

  let lastBrowserStart = Date.now();

  // One-time maintenance at startup: bound state.json and screenshot disk usage.
  const prunedAtStart = state.pruneOldJobs(settings.scan.processedJobRetainHours);
  if (prunedAtStart > 0) {
    logger.info('pruned old processed jobs', { removed: prunedAtStart });
    await state.save();
  }
  await cleanOldScreenshots(settings.storage.logsDir, settings.logging.screenshotRetainDays);

  const scanAlert = (msg: string): void => {
    void notifier.notify(msg, 'warn');
  };
  const engine = new AssignmentEngine(translators, state);
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
      ? (t, s) => notifier.notify(t, s)
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
        // reauth.ensureReady() drives the clean PAUSED_AUTH flow.
        logger.error('browser recycle failed; deferring tick to next cycle', { error: (err as Error).message });
        return;
      }
    }

    const assignedThisTick: AssignmentSummaryItem[] = [];
    try {
      health.recordPoll(); // a real board poll (we're past the auth-pause gate)
      const candidates = await scanner.scan();
      if (candidates.length === 0) {
        health.recordZeroScan();
        const zeros = health.getConsecutiveZeroScans();
        if (zeros > 0 && zeros % settings.reliability.consecutiveZeroScanAlert === 0) {
          await notifier.notify(
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
        // row is no longer WAITING_TRANSLATION, so isLanguageAssignable skips it
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
          await notifier.notify(
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
          const failed: SupportedLanguage[] = [];
          for (const lang of detail.targetLanguages) {
            if (!isLanguageAssignable(lang)) continue; // unassigned AND status === WAITING_TRANSLATION (exact)
            try {
              const pick = engine.pick(lang.code, detail.wordCount);
              await retry(
                () => assigner.assign(lang.code, pick.translator, lang.rowIndex),
                { maxAttempts: settings.assignment.maxRetries + 1, baseDelayMs: settings.assignment.retryDelayMs },
                (err, attempt) => {
                  if (
                    err instanceof TranslatorNotFoundError ||
                    isBrowserDeadError(err) ||
                    (err as Error).message?.includes('Timeout')
                  ) {
                    throw err; // deterministic / unrecoverable — don't waste retries
                  }
                  logger.warn('assign attempt failed', { attempt, language: lang.code, error: (err as Error).message });
                }
              );
              assigned[lang.code] = pick.translator;
              if (settings.assignment.dryRun) {
                logger.info('[DRY-RUN] would assign (not counted in metrics)', {
                  jobId: job.id,
                  name: job.name,
                  language: lang.code,
                  translator: pick.translator,
                });
              } else {
                // Real assignment only — dry-run must not affect health metrics,
                // round-robin counters, or notifications.
                health.recordAssignment(true, lang.code);
                if (pick.useRoundRobin && pick.rrKey) {
                  state.incrementRR(pick.rrKey);
                }
                // Reported once per tick as a single summary card (see after the loop).
              }
            } catch (err) {
              if (isBrowserDeadError(err)) throw err; // bubble to outer handler for browser recovery
              failed.push(lang.code);
              health.recordAssignment(false, lang.code);
              logger.error('assignment failed', { jobId: job.id, language: lang.code, error: (err as Error).message });
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
          // Dry-run is preview-only: never persist processed-job state, otherwise
          // dry-run would mark jobs FULL and the eventual live run would skip them.
          if (!settings.assignment.dryRun) {
            if (failed.length === 0 && Object.keys(assigned).length > 0) {
              state.markProcessed(job.id, assigned);
            } else if (Object.keys(assigned).length > 0) {
              state.markPartial(job.id, assigned, failed);
            } else if (detail.targetLanguages.length === 0) {
              // The board filter matched this job for lo-LA/km-KH, yet the
              // Waiting tab parsed zero such rows. That is almost always a
              // transient render/load race (a brand-new job whose rows haven't
              // populated) or work claimed in the seconds since the scan — NOT a
              // reason to mark the job done forever. Leave it unpersisted so the
              // next tick re-checks it live.
              logger.warn('no lo-LA/km-KH rows parsed on detail page — not marking processed, will retry next tick', { jobId: job.id });
              await captureScreenshot(page, settings.storage.logsDir, `empty-detail-${job.id}`, settings.logging.screenshotMaxPerDay).catch(() => null);
              // No state mutation → nothing to persist; re-checked next tick.
            } else if (failed.length === 0) {
              // Target-language rows existed but none were assignable (already
              // have a translator, or are in WAITING_REVIEW / in progress). Cool
              // down the re-check so the board re-listing this job (which happens
              // for review-stage rows) doesn't re-open it every tick.
              const recheckAfter = new Date(
                Date.now() + settings.scan.fullRecheckCooldownMinutes * 60_000
              ).toISOString();
              logger.info('job has no assignable rows — cooling down recheck', { jobId: job.id, recheckAfter });
              if (entry?.status === 'PARTIAL') {
                // Do NOT demote a PARTIAL to FULL — that discards failed[]/
                // retryCount and bypasses the maxPartialRetries→ABANDONED net.
                // Keep it PARTIAL; just cool down the re-check.
                state.setRecheckAfter(job.id, recheckAfter);
              } else {
                state.markProcessed(job.id, {}, recheckAfter);
              }
            } else {
              logger.error('all language assignments failed for job', { jobId: job.id, failed });
              state.markPartial(job.id, {}, failed);
            }
          }
        } catch (err) {
          if (isBrowserDeadError(err)) throw err; // bubble to outer handler for recovery
          logger.error('job processing error', { jobId: job.id, error: (err as Error).message });
          await captureScreenshot(page, settings.storage.logsDir, `job-${job.id}`, settings.logging.screenshotMaxPerDay).catch(() => null);
          await notifier.notify(`Job ${job.id} processing error: ${(err as Error).message}`, 'error');
        }
      }
      // Persist all state mutations from this tick in one write (no-op if nothing changed).
      await state.save();
      health.recordTickSuccess();
    } catch (err) {
      if (isBrowserDeadError(err)) {
        logger.error('browser died; recovering', { error: (err as Error).message });
        await notifier.notify('Browser crashed — recovering', 'warn');
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
          await notifier.notify(`Browser recovery failed: ${(recoverErr as Error).message}`, 'error');
        }
      } else {
        health.recordTickError();
        logger.error('tick failed', { error: (err as Error).message });
        if (health.shouldAlertErrorRate(settings.reliability.monitoring.consecutiveErrorAlert)) {
          await notifier.notify(
            `Bot failing: ${settings.reliability.monitoring.consecutiveErrorAlert} consecutive ticks errored`,
            'error'
          );
        }
      }
    }

    // Anti-spam: one summary card per cycle for all jobs assigned this tick —
    // sent even if the tick later threw (browser crash mid-loop) so assignments
    // are never silently dropped.
    await notifier.notifyAssignments(assignedThisTick);

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

  const shutdown = async (): Promise<void> => {
    scheduler.stop('shutdown');
    await scheduler.waitForIdle(30_000);
    await state.save();
    await health.save();
    await session.close();
    await lock.release();
    logger.info('shutdown complete');
    await notifier.notify('Bot stopped', 'info');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await notifier.notify(
    `Bot started (dryRun=${settings.assignment.dryRun}, interval=${settings.polling.intervalMinutes}min)`,
    'info'
  );
  scheduler.start();
}

main().catch((err) => {
  console.error('fatal error:', err);
  process.exit(1);
});
