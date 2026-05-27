import { promises as fs } from 'fs';
import path from 'path';
import type { Page } from 'playwright';

export async function captureScreenshot(
  page: Page,
  logsDir: string,
  context: string,
  maxPerDay = 0
): Promise<string | null> {
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.join(logsDir, 'screenshots', today);
  await fs.mkdir(dir, { recursive: true });

  // Per-day cap: skip writing if we've already hit the limit
  if (maxPerDay > 0) {
    const existing = await fs.readdir(dir).catch(() => [] as string[]);
    const pngCount = existing.filter((f) => f.endsWith('.png')).length;
    if (pngCount >= maxPerDay) {
      return null;
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeContext = context.replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(dir, `${timestamp}_${safeContext}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/** Delete screenshot day-folders (logs/screenshots/YYYY-MM-DD) older than retainDays. Returns count removed. */
export async function cleanOldScreenshots(logsDir: string, retainDays: number): Promise<number> {
  const root = path.join(logsDir, 'screenshots');
  const cutoff = Date.now() - retainDays * 86_400_000;
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let removed = 0;
  for (const entry of entries) {
    const t = new Date(entry).getTime(); // folder name "YYYY-MM-DD"
    if (!Number.isNaN(t) && t < cutoff) {
      await fs.rm(path.join(root, entry), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
