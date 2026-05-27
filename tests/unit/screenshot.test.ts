import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { cleanOldScreenshots } from '../../src/core/screenshot.js';

describe('cleanOldScreenshots', () => {
  it('returns 0 when the screenshots dir does not exist', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ss-'));
    expect(await cleanOldScreenshots(dir, 7)).toBe(0);
  });

  it('removes day-folders older than retainDays and keeps recent ones', async () => {
    const logsDir = mkdtempSync(path.join(tmpdir(), 'ss-'));
    const root = path.join(logsDir, 'screenshots');
    const oldDay = '2020-01-01';
    const today = new Date().toISOString().slice(0, 10);
    mkdirSync(path.join(root, oldDay), { recursive: true });
    mkdirSync(path.join(root, today), { recursive: true });
    const removed = await cleanOldScreenshots(logsDir, 7);
    expect(removed).toBe(1);
    expect(existsSync(path.join(root, oldDay))).toBe(false);
    expect(existsSync(path.join(root, today))).toBe(true);
  });
});
