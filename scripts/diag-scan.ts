import 'dotenv/config';
import { loadSettings } from '../src/storage/config.js';
import { createLogger } from '../src/core/logger.js';
import { AuthSession } from '../src/auth/session.js';
import { JobScanner } from '../src/scraper/job-scanner.js';
import type { SupportedLanguage } from '../src/types/index.js';

// Read-only repro for the intermittent translation `found:0`. Runs the REAL
// JobScanner at debug level a few times so the per-language debug lines reveal
// WHY a language returns 0 on some passes:
//   - `date filter set {fromAccepted, toAccepted}`  → did the Created filter snap back?
//   - `page parsed {lang, pageNum, rowsOnPage}`     → did the board return 0 rows?
//   - `row excluded by client-side date filter`     → rows present but date-cut?
//   - `language scan complete {lang, found}`        → final per-language count
// Compare lo-LA vs km-KH vs the review pass (wider window, same languages) within
// ONE scan() run — if lo-LA returns 0 while review-lo-LA finds the same job, the
// difference is the (narrow) translation Created filter, not an empty board.
// Read-only: never assigns. Usage: npx tsx scripts/diag-scan.ts [iterations]
const ITER = Number(process.argv[2] ?? 4);
const settings = loadSettings(process.env.SETTINGS_PATH ?? './config/settings.yml');
settings.browser.headless = true;
// Separate logs dir so this diag never interleaves with the running bot's log file.
const logger = createLogger({ level: 'debug', logsDir: 'logs/diag', rotateDays: 1 });

const session = new AuthSession(settings, logger);
let page;
try {
  page = await session.start();
} catch (err) {
  console.log('SESSION START FAILED →', (err as Error).message);
  console.log('VERDICT: cookies expired. Run: npm run capture-cookies');
  process.exit(0);
}

const reviewers = settings.review?.enabled ? settings.review.reviewers : undefined;
const reviewScan =
  reviewers && settings.review
    ? {
        languages: (Object.keys(reviewers) as SupportedLanguage[]).filter((k) => reviewers[k]),
        lookbackHours: settings.review.scanLookbackHours,
        maxCandidatesPerTick: settings.review.maxCandidatesPerTick,
        isSkippable: () => false, // diag: surface everything, don't hide cooled jobs
      }
    : undefined;

const scanner = new JobScanner(page, logger, settings.scan, (m) => console.log('[ALERT]', m), reviewScan);

for (let i = 1; i <= ITER; i++) {
  console.log(`\n========== diag-scan iteration ${i}/${ITER} ==========`);
  try {
    const jobs = await scanner.scan();
    const translation = jobs.filter((j) => !j.reviewOnly).map((j) => j.id);
    const review = jobs.filter((j) => j.reviewOnly).map((j) => j.id);
    console.log(`RESULT iter ${i}: translation=[${translation.join(',')}] reviewOnly=[${review.join(',')}]`);
  } catch (err) {
    console.log(`iter ${i} scan threw:`, (err as Error).message);
  }
  if (i < ITER) await page.waitForTimeout(8000);
}

await session.close();
console.log('\ndiag-scan done.');
