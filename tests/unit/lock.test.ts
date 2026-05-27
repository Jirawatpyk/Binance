import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { ProcessLock } from '../../src/core/lock.js';
import { LockHeldError } from '../../src/core/errors.js';

function lockPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'lock-')), '.lock');
}

describe('ProcessLock', () => {
  it('acquires when no lock exists', async () => {
    const p = lockPath();
    const lock = new ProcessLock(p);
    await lock.acquire();
    expect(existsSync(p)).toBe(true);
    await lock.release();
    expect(existsSync(p)).toBe(false);
  });

  it('clears a stale lock from a dead PID and acquires', async () => {
    const p = lockPath();
    // PID 999999 is not running; simulate a stale lock from an abrupt exit
    writeFileSync(p, '999999\n2026-01-01T00:00:00Z');
    const lock = new ProcessLock(p);
    await expect(lock.acquire()).resolves.toBeUndefined();
    await lock.release();
  });

  it('throws LockHeldError when the lock is held by a live process', async () => {
    const p = lockPath();
    // current process is alive
    writeFileSync(p, `${process.pid}\n2026-01-01T00:00:00Z`);
    const lock = new ProcessLock(p);
    await expect(lock.acquire()).rejects.toBeInstanceOf(LockHeldError);
  });
});
