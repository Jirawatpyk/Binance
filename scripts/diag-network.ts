import 'dotenv/config';
import { loadSettings } from '../src/storage/config.js';
import { createLogger } from '../src/core/logger.js';
import { AuthSession } from '../src/auth/session.js';

// Read-only: capture auth/token/refresh-related network calls the TMS SPA makes,
// to discover the refresh endpoint for a possible auto-renew implementation.
// Usage: npx tsx scripts/diag-network.ts
const settings = loadSettings(process.env.SETTINGS_PATH ?? './config/settings.yml');
settings.browser.headless = true;
const logger = createLogger({ level: 'warn', logsDir: settings.storage.logsDir, rotateDays: 1 });

const session = new AuthSession(settings, logger);
const page = await session.start();

const apiHosts = new Set<string>();
const authCalls: string[] = [];
page.on('request', (req) => {
  const u = req.url();
  try {
    const h = new URL(u).host;
    if (!/google|gstatic|sentry|analytics|\.png|\.css|\.woff/i.test(u)) apiHosts.add(h);
  } catch {
    /* ignore */
  }
  if (/auth|token|refresh|login|session|jwt/i.test(u)) authCalls.push(`${req.method()} ${u}`);
});

await page.goto('https://www.translationtms.com/job-board', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12_000);

console.log('=== API hosts seen ===');
for (const h of apiHosts) console.log(' ', h);
console.log('\n=== auth/token/refresh-related requests ===');
for (const c of [...new Set(authCalls)]) console.log(' ', c);

// Grep the app's JS bundles for refresh-endpoint hints.
console.log('\n=== refresh hints in app JS ===');
const scripts: string[] = await page.$$eval('script[src]', (els) =>
  (els as HTMLScriptElement[]).map((e) => e.src).filter((s) => s.includes('translationtms'))
);
for (const src of scripts.slice(0, 8)) {
  try {
    const txt = await (await page.request.get(src)).text();
    const matches = [...txt.matchAll(/["'`](\/[a-z0-9/_-]*(?:refresh|auth|token)[a-z0-9/_-]*)["'`]/gi)]
      .map((m) => m[1])
      .filter((p) => p.length < 60);
    for (const p of [...new Set(matches)].slice(0, 12)) console.log('  [js]', p);
  } catch {
    /* ignore */
  }
}

await session.close();
