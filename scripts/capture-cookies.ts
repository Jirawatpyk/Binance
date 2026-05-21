import { chromium } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';

const LOGIN_URL = 'https://www.translationtms.com/login';
const COOKIES_PATH = './data/cookies.json';
const SUCCESS_URL_PATTERN = /job-board|dashboard/i;
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to complete login + 2FA

async function main(): Promise<void> {
  console.log('Opening browser. Please log in manually (including 2FA code).');
  console.log('The browser will close automatically once you reach the Job Board.');
  console.log(`Timeout: ${TIMEOUT_MS / 1000}s\n`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  try {
    await page.goto(LOGIN_URL);
    console.log('Waiting for you to log in and reach the Job Board...');
    await page.waitForURL(SUCCESS_URL_PATTERN, { timeout: TIMEOUT_MS });

    await fs.mkdir(path.dirname(COOKIES_PATH), { recursive: true });
    await context.storageState({ path: COOKIES_PATH });
    console.log(`\n✅ Cookies saved to ${COOKIES_PATH}`);
    console.log('You can now run: npm start');
  } catch (err) {
    console.error('\n❌ Login was not completed in time. Cookies NOT saved.');
    console.error('Error:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
