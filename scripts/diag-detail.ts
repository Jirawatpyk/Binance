import 'dotenv/config';
import { loadSettings } from '../src/storage/config.js';
import { createLogger } from '../src/core/logger.js';
import { AuthSession } from '../src/auth/session.js';

// Read-only diagnostic: open a job detail page and dump the tab + table
// structure so we can see why parseLanguageRows() returns []. Never assigns.
// Usage: npx tsx scripts/diag-detail.ts 62475
const jobId = process.argv[2] ?? '62475';
const settings = loadSettings(process.env.SETTINGS_PATH ?? './config/settings.yml');
// Force a visible browser so we can watch, regardless of settings.
settings.browser.headless = false;
const logger = createLogger({ level: 'info', logsDir: settings.storage.logsDir, rotateDays: 1 });

const session = new AuthSession(settings, logger);
const page = await session.start();

const url = `https://www.translationtms.com/job/${jobId}`;
console.log('navigating to', url);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=Word Count', { timeout: 15_000 }).catch(() => console.log('!! Word Count not found'));

// 1) Every tab on the page
const tabs = await page.locator('[role="tab"]').allTextContents();
console.log('\n=== TABS (role=tab) ===');
console.log(JSON.stringify(tabs));

// 2) Click the Waiting tab specifically
const waitingTab = page.getByRole('tab', { name: 'Waiting', exact: true });
const tabVisible = await waitingTab.isVisible().catch(() => false);
console.log('\nWaiting tab (exact) visible?', tabVisible);
if (tabVisible) {
  await waitingTab.click();
  await page.waitForSelector('.ant-spin-spinning', { state: 'hidden', timeout: 10_000 }).catch(() => {});
}

// 3) How many tables / rows exist, and each row's cell texts
await page.waitForTimeout(1500);
const tableCount = await page.locator('table').count();
const rows = page.locator('table tbody tr');
const rowCount = await rows.count();
console.log(`\n=== TABLES: ${tableCount}, ROWS in 'table tbody tr': ${rowCount} ===`);
for (let i = 0; i < rowCount; i++) {
  const cells = await rows.nth(i).locator('td').allTextContents();
  console.log(`row ${i} [${cells.length} cells]:`, JSON.stringify(cells.map((c) => c.trim())));
}

// 4) Save a screenshot + the tab panel HTML for offline inspection
await page.screenshot({ path: `logs/screenshots/diag-${jobId}.png`, fullPage: true }).catch(() => {});
const panelHtml = await page.locator('.ant-tabs-content, [role="tabpanel"]').first().innerHTML().catch(() => '(no tabpanel)');
console.log('\n=== TAB PANEL HTML (first 2000 chars) ===');
console.log(panelHtml.slice(0, 2000));

await session.close();
console.log('\nDone. Screenshot: logs/screenshots/diag-' + jobId + '.png');
