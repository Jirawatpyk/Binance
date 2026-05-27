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
import { captureScreenshot } from './core/screenshot.js';
import { GoogleChatNotifier } from './notifications/google-chat.js';
import type { SupportedLanguage } from './types/index.js';
import { ReAuthManager } from './auth/reauth-manager.js';
import { HealthMonitor } from './core/health-monitor.js';
import { runWithWatchdog } from './core/watchdog.js';
import { isBrowserDeadError } from './core/recovery-utils.js';

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

  const lock = new ProcessLock(LOCK_PATH);
  await lock.acquire();
  logger.info('process lock acquired', { lockPath: LOCK_PATH });

  const state = new StateStore(settings.storage.statePath);
  await state.load();

  const session = new AuthSession(settings, logger);
  let page = await session.start();

  const engine = new AssignmentEngine(translators, state);
  let scanner = new JobScanner(page, logger, settings.scan);
  let processor = new JobProcessor(page, logger);
  let assigner = new Assigner(page, logger, settings.assignment.dryRun);

  const rebuildPipeline = (p: typeof page): void => {
    scanner = new JobScanner(p, logger, settings.scan);
    processor = new JobProcessor(p, logger);
    assigner = new Assigner(p, logger, settings.assignment.dryRun);
  };

  const health = new HealthMonitor('./data/health.json');
  await health.load();

  const reauth = new ReAuthManager({
    ensureLoggedIn: () => session.ensureLoggedIn(),
    notify: settings.reliability.reauth.alertOnExpiry
      ? (t, s) => notifier.notify(t, s)
      : async () => {},
    logger,
    onPause: () => health.recordAuthEpisode(),
  });

  const tick = async (): Promise<void> => {
    logger.info('tick started');
    health.recordTickStart();

    if (!(await reauth.ensureReady())) {
      await health.save();
      return; // paused awaiting manual cookie refresh
    }

    try {
      const candidates = await scanner.scan();
      for (const job of candidates) {
        if (state.isProcessed(job.id)) continue;
        try {
          logger.info('processing job', { jobId: job.id, name: job.name });
          const detail = await processor.open(job.detailUrl, job.id);
          const assigned: Partial<Record<SupportedLanguage, string>> = {};
          const failed: SupportedLanguage[] = [];
          for (const lang of detail.targetLanguages) {
            if (lang.translator !== null) continue;
            if (lang.status !== 'WAITING_TRANSLATION' && !lang.status.includes('WAITING')) continue;
            try {
              const pick = engine.pick(lang.code, detail.wordCount);
              await retry(
                () => assigner.assign(lang.code, pick.translator, lang.rowIndex),
                { maxAttempts: settings.assignment.maxRetries + 1, baseDelayMs: settings.assignment.retryDelayMs },
                (err, attempt) => logger.warn('assign attempt failed', { attempt, language: lang.code, error: (err as Error).message })
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
                health.recordAssignment(true);
                if (pick.useRoundRobin && pick.rrKey) {
                  state.incrementRR(pick.rrKey);
                }
                await notifier.notify(
                  `Assigned job ${job.id} "${job.name}" — ${lang.code} → ${pick.translator} (${detail.wordCount} words)`,
                  'info'
                );
              }
            } catch (err) {
              if (isBrowserDeadError(err)) throw err; // bubble to outer handler for browser recovery
              failed.push(lang.code);
              health.recordAssignment(false);
              logger.error('assignment failed', { jobId: job.id, language: lang.code, error: (err as Error).message });
              await captureScreenshot(page, settings.storage.logsDir, `assign-${job.id}-${lang.code}`);
            }
          }
          if (!settings.assignment.dryRun && Object.keys(assigned).length > 0) {
            health.recordJobAssigned();
          }
          if (failed.length === 0 && Object.keys(assigned).length > 0) {
            state.markProcessed(job.id, assigned);
          } else if (Object.keys(assigned).length > 0) {
            state.markPartial(job.id, assigned, failed);
          } else if (failed.length === 0) {
            logger.info('job already fully assigned externally', { jobId: job.id });
            state.markProcessed(job.id, {});
          } else {
            logger.error('all language assignments failed for job', { jobId: job.id, failed });
            state.markPartial(job.id, {}, failed);
          }
          await state.save();
        } catch (err) {
          if (isBrowserDeadError(err)) throw err; // bubble to outer handler for recovery
          logger.error('job processing error', { jobId: job.id, error: (err as Error).message });
          await captureScreenshot(page, settings.storage.logsDir, `job-${job.id}`);
          await notifier.notify(`Job ${job.id} processing error: ${(err as Error).message}`, 'error');
        }
      }
      health.recordTickSuccess();
    } catch (err) {
      health.recordTickError();
      if (isBrowserDeadError(err)) {
        logger.error('browser died; recovering', { error: (err as Error).message });
        await notifier.notify('Browser crashed — recovering', 'warn');
        page = await session.recover();
        rebuildPipeline(page);
      } else {
        logger.error('tick failed', { error: (err as Error).message });
        if (health.shouldAlertErrorRate(settings.reliability.monitoring.consecutiveErrorAlert)) {
          await notifier.notify(
            `Bot failing: ${settings.reliability.monitoring.consecutiveErrorAlert} consecutive ticks errored`,
            'error'
          );
        }
      }
    }

    if (health.isDailySummaryDue(new Date(), settings.reliability.monitoring.dailySummaryTime)) {
      await notifier.notify(health.buildDailySummary(), 'info');
      health.markDailySummarySent();
    }
    await health.save();
    logger.info('tick complete');
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
