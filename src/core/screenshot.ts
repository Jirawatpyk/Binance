import { promises as fs } from 'fs';
import path from 'path';
import type { Page } from 'playwright';

export async function captureScreenshot(
  page: Page,
  logsDir: string,
  context: string
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.join(logsDir, 'screenshots', today);
  await fs.mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeContext = context.replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(dir, `${timestamp}_${safeContext}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}
