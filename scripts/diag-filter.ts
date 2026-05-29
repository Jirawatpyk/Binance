import 'dotenv/config';
import { loadSettings } from '../src/storage/config.js';
import { createLogger } from '../src/core/logger.js';
import { AuthSession } from '../src/auth/session.js';
import { formatBoardDate } from '../src/scraper/date-utils.js';

// DECISIVE read-only test for the "filter LO but KM rows come back" race.
// Drives the board with ONLY the lo-LA language filter (no preceding km-KH
// pass), waits GENEROUSLY for the table to settle, then dumps every row id +
// its visible language tags. If the km-only-claimable jobs (62482-99) do NOT
// appear under a patient lo-LA filter, the bot's review pass getting them =
// stale-table read after the km->lo filter switch (clickSearch races).
// Never assigns. Usage: npx tsx scripts/diag-filter.ts
const settings = loadSettings(process.env.SETTINGS_PATH ?? './config/settings.yml');
settings.browser.headless = false; // watchable
const logger = createLogger({ level: 'info', logsDir: 'logs/diag', rotateDays: 1 });

const session = new AuthSession(settings, logger);
const page = await session.start();

const BOARD = 'https://www.translationtms.com/job-board';
console.log('navigating to', BOARD);
await page.goto(BOARD, { waitUntil: 'networkidle' });
await page.waitForSelector('table, [role="table"]', { timeout: 30_000 });
await page.waitForSelector('.ant-spin-spinning', { state: 'hidden', timeout: 15_000 }).catch(() => {});

// --- status filter: "Available to Claim" (.ant-select nth(0)) ---
const statusSelect = page.locator('.ant-select').nth(0);
await statusSelect.click();
await page.waitForTimeout(400);
await page
  .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
  .filter({ hasText: 'Available to Claim' })
  .first()
  .click();
await page.waitForTimeout(400);
console.log('status filter -> Available to Claim');

// --- Created date filter: wide 8-day window so 05-27 jobs are NOT date-excluded ---
const from = new Date(Date.now() - 8 * 24 * 3600_000);
const to = new Date(Date.now() + 24 * 3600_000);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const rangePicker = page.locator('.ant-picker-range').nth(1); // Created From/To
const rangeInputs = rangePicker.locator('input');
await rangeInputs.nth(0).click({ timeout: 10_000 });
await page.waitForTimeout(400);
await rangeInputs.nth(0).fill('');
await page.keyboard.type(formatBoardDate(from), { delay: 40 });
await page.waitForTimeout(300);
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
await rangeInputs.nth(1).fill('');
await page.keyboard.type(formatBoardDate(to), { delay: 40 });
await page.waitForTimeout(300);
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
console.log('created filter ->', formatBoardDate(from), '..', formatBoardDate(to));

// --- language filter: lo-LA ONLY (clear any tag first) ---
for (let i = 0; i < 5; i++) {
  const btn = page.locator('.ant-select-selection-item-remove').first();
  if (!(await btn.isVisible({ timeout: 1_000 }).catch(() => false))) break;
  await btn.click();
  await page.waitForTimeout(200);
}
const langSelect = page.locator('.ant-select').nth(1);
await langSelect.click();
await page.waitForTimeout(300);
await page.keyboard.type('lo', { delay: 80 });
await page.waitForTimeout(800);
await page
  .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
  .filter({ hasText: 'lo-LA' })
  .first()
  .click();
await page.waitForTimeout(300);
console.log('language filter -> lo-LA');

// --- search, then wait GENEROUSLY for the table to actually reflect the filter ---
await page.locator('button').filter({ hasText: /^Search$/ }).first().click();
await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
await page.waitForSelector('.ant-spin-spinning', { state: 'hidden', timeout: 10_000 }).catch(() => {});
await page.waitForTimeout(3000); // deliberately patient — the whole point is a fully-settled lo-LA table

// --- dump every row across all pages: id + visible language tags ---
const seen = new Set<string>();
const dump: Array<{ id: string; tags: string }> = [];
for (let pageNum = 1; pageNum <= 10; pageNum++) {
  const rows = await page.$$eval('table tbody tr, [role="row"]', (els) =>
    (els as Element[])
      .map((row) => {
        const cells = row.querySelectorAll('td, [role="cell"]');
        if (cells.length < 10) return null;
        const id = (cells[1]?.textContent ?? '').trim();
        if (!/^\d+$/.test(id)) return null;
        const tags = Array.from(cells[7].querySelectorAll('[class*="tag"], span'))
          .map((el) => el.textContent?.trim() ?? '')
          .filter((s) => s.length > 0)
          .join('|');
        return { id, tags };
      })
      .filter((r): r is { id: string; tags: string } => r !== null)
  );
  for (const r of rows) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      dump.push(r);
    }
  }
  console.log(`page ${pageNum}: ${rows.length} rows`);
  const nextBtn = page.locator('button').filter({ hasText: /^Next$/ }).first();
  if (!(await nextBtn.isVisible({ timeout: 1_000 }).catch(() => false))) break;
  if (await nextBtn.isDisabled().catch(() => true)) break;
  await nextBtn.click();
  await page.waitForSelector('.ant-spin-spinning', { state: 'hidden', timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

console.log('\n=== lo-LA + Available-to-Claim results (patient) ===');
console.log('total ids:', dump.length);
for (const r of dump) console.log(`  ${r.id}  tags=[${r.tags}]`);

const suspects = ['62482', '62483', '62485', '62489', '62490', '62493', '62499'];
const present = suspects.filter((s) => seen.has(s));
console.log('\n=== VERDICT ===');
console.log('km-only-claimable suspects present under lo-LA filter:', present.length ? present.join(',') : 'NONE');
console.log(
  present.length
    ? '→ board matches "has lo target any status" — my "filter correct" stands; NOT a race.'
    : '→ patient lo-LA filter does NOT show them → bot review pass read a STALE km table → RACE confirmed.'
);

await page.screenshot({ path: 'logs/screenshots/diag-filter-lo.png', fullPage: true }).catch(() => {});
await session.close();
console.log('\nDone. Screenshot: logs/screenshots/diag-filter-lo.png');
