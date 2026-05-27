// Reuse your ALREADY-LOGGED-IN Chrome session (no re-login / no 2FA) by pulling
// its translationtms.com cookies into the bot's data/cookies.json.
//
// Prereq: launch Chrome with remote debugging on your normal profile, e.g.
//   (close all Chrome first, then in PowerShell)
//   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
//   ...log into translationtms.com if needed, then run:  npx tsx scripts/import-chrome-session.ts
import { chromium } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';

const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
const COOKIES_PATH = './data/cookies.json';

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
if (!ctx) {
  console.error('No browser context found over CDP. Is Chrome running with --remote-debugging-port=9222?');
  process.exit(1);
}

const state = await ctx.storageState();
// Keep ONLY translationtms.com cookies — never write your whole cookie jar.
const cookies = state.cookies.filter((c) => c.domain.includes('translationtms'));
const origins = state.origins.filter((o) => o.origin.includes('translationtms'));

if (cookies.length === 0) {
  console.error('❌ No translationtms.com cookies found in that Chrome. Open/login to the site there first.');
  process.exit(1);
}

await fs.mkdir(path.dirname(COOKIES_PATH), { recursive: true });
await fs.writeFile(COOKIES_PATH, JSON.stringify({ cookies, origins }, null, 2), 'utf-8');
console.log(`✅ Saved ${cookies.length} translationtms.com cookie(s) → ${COOKIES_PATH}`);
console.log('   (your Chrome is untouched; verify with: npx tsx scripts/check-session.ts)');
// NOTE: do NOT browser.close() — that would close your real Chrome. Just exit.
process.exit(0);
