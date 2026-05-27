import 'dotenv/config';
import { loadSettings } from '../src/storage/config.js';
import { createLogger } from '../src/core/logger.js';
import { AuthSession } from '../src/auth/session.js';

// Read-only: open the job board with the current cookies and report what the
// bot actually sees (login page / empty / spinner / table). Diagnoses whether
// the scan timeouts are stale cookies vs a slow site. Usage: npx tsx scripts/diag-board.ts
const settings = loadSettings(process.env.SETTINGS_PATH ?? './config/settings.yml');
settings.browser.headless = true;
const logger = createLogger({ level: 'info', logsDir: settings.storage.logsDir, rotateDays: 1 });

const session = new AuthSession(settings, logger);
let page;
try {
  page = await session.start(); // throws LoginFailedError if cookies fully expired (/login redirect)
} catch (err) {
  console.log('SESSION START FAILED →', (err as Error).message);
  console.log('VERDICT: cookies fully expired (redirected to /login). Run: npm run capture-cookies');
  process.exit(0);
}

await page.goto('https://www.translationtms.com/job-board', { waitUntil: 'domcontentloaded' });
console.log('url after nav:', page.url());
console.log('title:', await page.title().catch(() => '?'));

// Give the table up to 20s (bot only waits 15s) to tell "slow" from "never".
const tableAppeared = await page
  .waitForSelector('table, [role="table"]', { timeout: 20_000 })
  .then(() => true)
  .catch(() => false);
console.log('table appeared within 20s:', tableAppeared);

const tableCount = await page.locator('table').count().catch(() => -1);
const rowCount = await page.locator('table tbody tr').count().catch(() => -1);
const spinnerVisible = await page.locator('.ant-spin-spinning').first().isVisible().catch(() => false);
const loginVisible = await page.locator('input[type="password"], input[name="email"]').first().isVisible().catch(() => false);
const selectCount = await page.locator('.ant-select').count().catch(() => -1);
console.log({ tableCount, rowCount, spinnerVisible, loginVisible, antSelectCount: selectCount });

const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ');
console.log('body text (first 300):', bodyText);

await page.screenshot({ path: 'logs/screenshots/diag-board.png', fullPage: true }).catch(() => {});
console.log('screenshot: logs/screenshots/diag-board.png');
await session.close();
