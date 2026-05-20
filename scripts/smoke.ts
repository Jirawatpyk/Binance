import 'dotenv/config';
import { chromium } from 'playwright-extra';
// @ts-ignore — puppeteer-extra plugin types
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

async function main(): Promise<void> {
  const username = process.env.TMS_USERNAME;
  const password = process.env.TMS_PASSWORD;
  if (!username || !password) throw new Error('Missing TMS credentials');

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  await page.goto('https://www.translationtms.com/login');
  await page.fill('input[type="email"], input[name="email"]', username);
  await page.fill('input[type="password"]', password);
  await Promise.all([
    page.waitForURL(/job-board|dashboard/i, { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
  console.log('SMOKE OK — logged in, landed at:', page.url());
  await browser.close();
}

main().catch((err) => {
  console.error('SMOKE FAIL:', err);
  process.exit(1);
});
