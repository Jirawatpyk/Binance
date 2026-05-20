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
import type { SupportedLanguage } from './types/index.js';

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

  const username = process.env.TMS_USERNAME;
  const password = process.env.TMS_PASSWORD;
  if (!username || !password) {
    logger.error('TMS_USERNAME / TMS_PASSWORD missing from environment');
    process.exit(1);
  }

  const lock = new ProcessLock(LOCK_PATH);
  await lock.acquire();
  logger.info('process lock acquired', { lockPath: LOCK_PATH });

  const state = new StateStore(settings.storage.statePath);
  await state.load();

  const session = new AuthSession(settings, { username, password }, logger);
  const page = await session.start();

  const engine = new AssignmentEngine(translators, state);
  const scanner = new JobScanner(page, logger);
  const processor = new JobProcessor(page, logger);
  const assigner = new Assigner(page, logger, settings.assignment.dryRun);

  const tick = async (): Promise<void> => {
    logger.info('tick started');
    await retry(
      () => session.ensureLoggedIn(),
      { maxAttempts: settings.assignment.maxRetries + 1, baseDelayMs: settings.assignment.retryDelayMs },
      (err, attempt) => logger.warn('login attempt failed', { attempt, error: (err as Error).message })
    );
    const candidates = await scanner.scan();
    for (const job of candidates) {
      if (state.isProcessed(job.id)) continue;
      try {
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
            if (pick.useRoundRobin && pick.rrKey) state.incrementRR(pick.rrKey);
          } catch (err) {
            failed.push(lang.code);
            logger.error('assignment failed', {
              jobId: job.id,
              language: lang.code,
              error: (err as Error).message,
            });
            await captureScreenshot(page, settings.storage.logsDir, `assign-${job.id}-${lang.code}`);
          }
        }
        if (failed.length === 0 && Object.keys(assigned).length > 0) {
          state.markProcessed(job.id, assigned);
        } else if (Object.keys(assigned).length > 0) {
          state.markPartial(job.id, assigned, failed);
        } else if (failed.length === 0) {
          // Nothing to assign — all languages already had a translator (e.g., assigned manually)
          logger.info('job already fully assigned externally', { jobId: job.id });
          state.markProcessed(job.id, {});
        }
        await state.save();
      } catch (err) {
        logger.error('job processing error', { jobId: job.id, error: (err as Error).message });
        await captureScreenshot(page, settings.storage.logsDir, `job-${job.id}`);
      }
    }
    logger.info('tick complete');
  };

  const scheduler = new Scheduler(
    { intervalMinutes: settings.polling.intervalMinutes, jitterSeconds: settings.polling.jitterSeconds },
    tick,
    logger
  );

  const shutdown = async (): Promise<void> => {
    scheduler.stop('shutdown');
    await session.close();
    await state.save();
    await lock.release();
    logger.info('shutdown complete');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  scheduler.start();
}

main().catch((err) => {
  console.error('fatal error:', err);
  process.exit(1);
});
