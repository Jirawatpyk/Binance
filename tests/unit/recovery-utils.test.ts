import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { isBrowserDeadError, pruneCorruptBackups } from '../../src/core/recovery-utils.js';

describe('isBrowserDeadError', () => {
  it('detects "Target closed"', () => {
    expect(isBrowserDeadError(new Error('Target closed'))).toBe(true);
  });
  it('detects "Target page, context or browser has been closed"', () => {
    expect(isBrowserDeadError(new Error('Target page, context or browser has been closed'))).toBe(true);
  });
  it('detects "Browser has been closed"', () => {
    expect(isBrowserDeadError(new Error('Browser has been closed'))).toBe(true);
  });
  it('detects a BrowserContext closed message', () => {
    expect(isBrowserDeadError(new Error('BrowserContext has been closed'))).toBe(true);
  });
  it('detects "Page was destroyed"', () => {
    expect(isBrowserDeadError(new Error('Page was destroyed'))).toBe(true);
  });
  it('detects "Connection closed"', () => {
    expect(isBrowserDeadError(new Error('Connection closed while reading'))).toBe(true);
  });
  it('false for an ordinary error', () => {
    expect(isBrowserDeadError(new Error('TranslatorNotFoundError: x not in popup'))).toBe(false);
  });
  it('false for non-Error input', () => {
    expect(isBrowserDeadError('nope')).toBe(false);
    expect(isBrowserDeadError(undefined)).toBe(false);
  });
});

describe('pruneCorruptBackups', () => {
  it('keeps the newest N .corrupt.* backups and deletes the rest, leaving other files alone', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corrupt-'));
    writeFileSync(path.join(dir, 'state.json'), '{}');
    writeFileSync(path.join(dir, 'health.json'), '{}');
    for (const ts of [1000, 2000, 3000, 4000, 5000]) {
      writeFileSync(path.join(dir, `state.json.corrupt.${ts}`), 'x');
    }
    const removed = await pruneCorruptBackups(dir, 2);
    expect(removed).toBe(3);
    const left = readdirSync(dir).sort();
    // the two newest backups + the live files survive
    expect(left).toEqual(['health.json', 'state.json', 'state.json.corrupt.4000', 'state.json.corrupt.5000']);
  });

  it('returns 0 when the directory does not exist or has no backups', async () => {
    expect(await pruneCorruptBackups(path.join(tmpdir(), 'does-not-exist-xyz'), 5)).toBe(0);
    const dir = mkdtempSync(path.join(tmpdir(), 'corrupt-'));
    writeFileSync(path.join(dir, 'state.json'), '{}');
    expect(await pruneCorruptBackups(dir, 5)).toBe(0);
  });
});
