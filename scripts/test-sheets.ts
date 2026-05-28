import 'dotenv/config';
import { loadSettings } from '../src/storage/config.js';
import { createLogger } from '../src/core/logger.js';
import { SheetsAssignmentLogger } from '../src/integrations/google-sheets.js';
import type { AssignmentSummaryItem } from '../src/notifications/google-chat.js';

// Appends one clearly-marked test row to each configured tab to confirm the
// service-account credentials + Editor sharing work against the real sheet.
// Requires sheets.enabled: true in config/settings.yml.
// Usage: npx tsx scripts/test-sheets.ts
const settings = loadSettings(process.env.SETTINGS_PATH ?? './config/settings.yml');
const logger = createLogger({ level: 'info', logsDir: settings.storage.logsDir, rotateDays: 1 });

if (!settings.sheets?.enabled) {
  console.error('sheets.enabled is false in settings.yml — enable it (with real values) to smoke-test.');
  process.exit(1);
}

const sheets = new SheetsAssignmentLogger(settings.sheets, logger, (m) => console.warn('ALERT:', m));
await sheets.init();

const stamp = new Date().toISOString();
const sample: AssignmentSummaryItem[] = [
  {
    jobId: `TEST-${Date.now()}`,
    name: `SMOKE TEST ${stamp} (safe to delete)`,
    wordCount: 1,
    assigned: { 'lo-LA': 'smoke@eqho.com', 'km-KH': 'smoke@eqho.com' },
    dueDate: new Date(),
  },
];
await sheets.appendAssignments(sample);
console.log('Done. Check both tabs for a row whose name starts with "SMOKE TEST".');
process.exit(0);
