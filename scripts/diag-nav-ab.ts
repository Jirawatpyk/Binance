import 'dotenv/config';
import { loadSettings } from '../src/storage/config.js';
import { createLogger } from '../src/core/logger.js';
import { AuthSession } from '../src/auth/session.js';
import type { Page } from 'playwright';

// Reproduce the BOT's exact scan path (start session -> goto board -> wait table)
// and A/B every nav strategy back-to-back in ONE process, dumping page state on
// failure. Diagnoses why the long-running bot times out on the table-wait while
// a fresh diag passes. Read-only. Usage: npx tsx scripts/diag-nav-ab.ts
const BOARD = 'https://www.translationtms.com/job-board';
const settings = loadSettings(process.env.SETTINGS_PATH ?? './config/settings.yml');
settings.browser.headless = true;
const logger = createLogger({ level: 'warn', logsDir: settings.storage.logsDir, rotateDays: 1 });

const session = new AuthSession(settings, logger);
const page: Page = await session.start(); // ensureLoggedIn already did one domcontentloaded nav

async function dump(tag: string): Promise<void> {
  const url = page.url();
  const title = await page.title().catch(() => '?');
  const tableCount = await page.locator('table').count().catch(() => -1);
  const tableVisible = await page.locator('table, [role="table"]').first().isVisible().catch(() => false);
  const spinner = await page.locator('.ant-spin-spinning').first().isVisible().catch(() => false);
  const selects = await page.locator('.ant-select').count().catch(() => -1);
  const login = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
  const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
  console.log(`   [${tag}] url=${url}`);
  console.log(`   [${tag}] title="${title}" tableCount=${tableCount} tableVisible=${tableVisible} spinner=${spinner} antSelect=${selects} loginField=${login}`);
  console.log(`   [${tag}] body: ${body}`);
  await page.screenshot({ path: `logs/screenshots/nav-ab-${tag}.png`, fullPage: true }).catch(() => {});
}

async function trial(waitUntil: 'domcontentloaded' | 'networkidle' | 'load', round: number): Promise<void> {
  const tag = `${waitUntil}-r${round}`;
  const t0 = Date.now();
  let navMs = -1;
  try {
    await page.goto(BOARD, { waitUntil });
    navMs = Date.now() - t0;
  } catch (e) {
    navMs = Date.now() - t0;
    console.log(`❌ ${tag}: goto threw after ${navMs}ms — ${(e as Error).message.split('\n')[0]}`);
    await dump(tag);
    return;
  }
  const t1 = Date.now();
  const ok = await page
    .waitForSelector('table, [role="table"]', { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  const waitMs = Date.now() - t1;
  if (ok) {
    console.log(`✅ ${tag}: goto ${navMs}ms, table visible after ${waitMs}ms`);
  } else {
    console.log(`❌ ${tag}: goto ${navMs}ms, table NOT visible within ${waitMs}ms`);
    await dump(tag);
  }
}

// Mimic several ticks hitting the same long-lived page, alternating strategies.
for (let round = 1; round <= 2; round++) {
  await trial('networkidle', round);
  await trial('domcontentloaded', round);
  await trial('load', round);
}

await session.close();
console.log('done. screenshots (failures only): logs/screenshots/nav-ab-*.png');
