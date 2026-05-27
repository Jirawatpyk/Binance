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

// Match the host exactly (not a substring) so a look-alike domain can't leak in.
const TMS = /(^|\.)translationtms\.com$/i;
const state = await ctx.storageState();
// Keep ONLY translationtms.com cookies + localStorage origins — never write your
// whole jar. NOTE: TMS auth is a JWT in localStorage, so `origins` is the part
// that actually carries the session; cookies are usually empty.
const cookies = state.cookies.filter((c) => TMS.test(c.domain.replace(/^\./, '')));
const origins = state.origins.filter((o) => {
  try {
    return TMS.test(new URL(o.origin).hostname);
  } catch {
    return false;
  }
});

const lsCount = origins.reduce((n, o) => n + (o.localStorage?.length ?? 0), 0);
if (lsCount === 0 && cookies.length === 0) {
  console.error('❌ No translationtms.com session found in that Chrome (no localStorage/cookies). Open/login to the site there first.');
  process.exit(1);
}

await fs.mkdir(path.dirname(COOKIES_PATH), { recursive: true });
// Back up the current session first, so a bad import is recoverable.
await fs.copyFile(COOKIES_PATH, `${COOKIES_PATH}.bak.${Date.now()}`).catch(() => {});
await fs.writeFile(COOKIES_PATH, JSON.stringify({ cookies, origins }, null, 2), 'utf-8');
console.log(`✅ Saved ${cookies.length} cookie(s) + ${lsCount} localStorage item(s) for translationtms.com → ${COOKIES_PATH}`);
console.log('   (your Chrome is untouched; verify with: npx tsx scripts/check-session.ts)');
// NOTE: do NOT browser.close() — that would close your real Chrome. Just exit.
process.exit(0);
