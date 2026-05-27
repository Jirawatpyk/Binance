import 'dotenv/config';
import { loadSettings } from '../src/storage/config.js';
import { createLogger } from '../src/core/logger.js';
import { AuthSession } from '../src/auth/session.js';

// Opens the Job Board in a VISIBLE browser using the BOT's saved session
// (data/cookies.json) — NOT your interactive Chrome login. Lets you see with
// your own eyes whether the bot's cookie session still works (table shows data)
// or is dead (redirects to /login, or board loads empty). Read-only.
// Run:  npx tsx scripts/check-session.ts
const settings = loadSettings(process.env.SETTINGS_PATH ?? './config/settings.yml');
settings.browser.headless = false; // VISIBLE — watch the window
const logger = createLogger({ level: 'info', logsDir: settings.storage.logsDir, rotateDays: 1 });

const session = new AuthSession(settings, logger);
let page;
try {
  page = await session.start(); // throws if the bot session redirects to /login
} catch (err) {
  console.log('\n❌ SESSION DEAD — redirected to /login:', (err as Error).message);
  console.log('→ cookies.json expired. Fix: npm run capture-cookies\n');
  process.exit(0);
}

await page.goto('https://www.translationtms.com/job-board', { waitUntil: 'domcontentloaded' });
const tableOk = await page
  .waitForSelector('table, [role="table"]', { timeout: 30_000 })
  .then(() => true)
  .catch(() => false);
const rows = await page.locator('table tbody tr').count().catch(() => -1);
const loginVisible = await page.locator('input[type="password"]').first().isVisible().catch(() => false);

console.log('\n================ BOT SESSION CHECK ================');
console.log('url       :', page.url());
console.log('table loaded (30s):', tableOk, '| rows:', rows);
console.log('login form visible :', loginVisible);
if (!tableOk || loginVisible) {
  console.log('VERDICT   : ❌ bot session NOT working (data/table not served) → npm run capture-cookies');
} else {
  console.log('VERDICT   : ✅ bot session works — board loads with the saved cookies');
}
console.log('===================================================');
console.log('Window stays open 90s — LOOK at the board: normal data, empty, or login?\n');
await page.waitForTimeout(90_000);
await session.close();
