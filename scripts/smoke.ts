import 'dotenv/config';
import { loadSettings } from '../src/storage/config.js';
import { createLogger } from '../src/core/logger.js';
import { AuthSession } from '../src/auth/session.js';

// Login-only sanity check: confirm the captured cookie session still reaches the
// Job Board. The bot is cookie-based (2FA, no runtime password), so this never
// uses TMS credentials. Run `npm run capture-cookies` first if it fails.
// Usage: npx tsx scripts/smoke.ts
async function main(): Promise<void> {
  const settings = loadSettings(process.env.SETTINGS_PATH ?? './config/settings.yml');
  settings.browser.headless = false; // visible so a human can eyeball the board
  const logger = createLogger({ level: 'info', logsDir: settings.storage.logsDir, rotateDays: 1 });

  const session = new AuthSession(settings, logger);
  const page = await session.start(); // throws LoginFailedError if cookies are missing/expired
  console.log('SMOKE OK — cookie session valid, landed at:', page.url());
  await session.close();
}

main().catch((err) => {
  console.error('SMOKE FAIL:', (err as Error).message);
  process.exit(1);
});
