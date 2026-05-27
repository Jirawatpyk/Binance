import 'dotenv/config';
import { loadSettings } from '../src/storage/config.js';
import { createLogger } from '../src/core/logger.js';
import { AuthSession } from '../src/auth/session.js';
import { LoginFailedError } from '../src/core/errors.js';

// Verify ensureLoggedIn() correctly detects an expired session. With the current
// (expired) cookies.json this MUST throw LoginFailedError; before the fix it
// wrongly returned a page. Usage: npx tsx scripts/diag-auth-check.ts
const settings = loadSettings(process.env.SETTINGS_PATH ?? './config/settings.yml');
settings.browser.headless = true;
const logger = createLogger({ level: 'warn', logsDir: settings.storage.logsDir, rotateDays: 1 });

const session = new AuthSession(settings, logger);
try {
  await session.start();
  console.log('❌ FAIL: start() returned a page — expired session NOT detected');
  await session.close();
  process.exit(1);
} catch (err) {
  if (err instanceof LoginFailedError) {
    console.log('✅ PASS: expired session detected →', err.message);
    process.exit(0);
  }
  console.log('❌ FAIL: threw a non-auth error →', (err as Error).message);
  process.exit(1);
}
