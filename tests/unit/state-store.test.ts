import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { StateStore } from '../../src/storage/state.js';

function newStore(): { store: StateStore; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'state-'));
  const file = path.join(dir, 'state.json');
  return { store: new StateStore(file), file };
}

describe('StateStore', () => {
  it('starts empty when no file exists', async () => {
    const { store } = newStore();
    await store.load();
    expect(store.isProcessed('any')).toBe(false);
  });

  it('marks job as FULL', async () => {
    const { store, file } = newStore();
    await store.load();
    store.markProcessed('61514', { 'lo-LA': 'a@eqho.com' });
    await store.save();
    expect(store.isProcessed('61514')).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it('marks job as PARTIAL (still re-processable)', async () => {
    const { store } = newStore();
    await store.load();
    store.markPartial('61515', { 'lo-LA': 'a@eqho.com' }, ['km-KH']);
    expect(store.isProcessed('61515')).toBe(false);
    expect(store.getProcessStatus('61515')).toBe('PARTIAL');
  });

  it('round-robin counter increments', async () => {
    const { store } = newStore();
    await store.load();
    expect(store.getRRIndex('lo-LA:rule2')).toBe(0);
    store.incrementRR('lo-LA:rule2');
    expect(store.getRRIndex('lo-LA:rule2')).toBe(1);
    store.incrementRR('lo-LA:rule2');
    expect(store.getRRIndex('lo-LA:rule2')).toBe(2);
  });

  it('persists and reloads state', async () => {
    const { store, file } = newStore();
    await store.load();
    store.markProcessed('61514', { 'lo-LA': 'a@eqho.com' });
    store.incrementRR('lo-LA:rule2');
    await store.save();

    const store2 = new (await import('../../src/storage/state.js')).StateStore(file);
    await store2.load();
    expect(store2.isProcessed('61514')).toBe(true);
    expect(store2.getRRIndex('lo-LA:rule2')).toBe(1);
  });

  it('prunes processed jobs older than retain window', async () => {
    const { store } = newStore();
    await store.load();
    store.markProcessed('111', { 'lo-LA': 'a@eqho.com' });
    // recent job should NOT be pruned when retainHours is 24
    const removedRecent = store.pruneOldJobs(24);
    expect(removedRecent).toBe(0);
    expect(store.isProcessed('111')).toBe(true);
  });

  it('prunes a job whose processedAt is older than retainHours', async () => {
    const { store, file } = newStore();
    const old = new Date(Date.now() - 200 * 3_600_000).toISOString(); // 200h ago
    writeFileSync(file, JSON.stringify({
      processedJobs: { '999': { processedAt: old, status: 'FULL', assigned: {} } },
      roundRobinCounters: {},
    }));
    await store.load();
    const removed = store.pruneOldJobs(96);
    expect(removed).toBe(1);
    expect(store.isProcessed('999')).toBe(false);
  });

  it('does NOT prune an ABANDONED job even when older than retainHours', async () => {
    const { store, file } = newStore();
    const old = new Date(Date.now() - 200 * 3_600_000).toISOString(); // 200h ago
    writeFileSync(file, JSON.stringify({
      processedJobs: { '777': { processedAt: old, status: 'ABANDONED', assigned: {} } },
      roundRobinCounters: {},
    }));
    await store.load();
    const removed = store.pruneOldJobs(96);
    expect(removed).toBe(0);
    expect(store.getProcessStatus('777')).toBe('ABANDONED');
  });

  it('recovers from corrupt state.json by starting fresh and signals the recovery', async () => {
    const { store, file } = newStore();
    writeFileSync(file, '{ broken');
    await expect(store.load()).resolves.toBe(true);
    expect(store.isProcessed('anything')).toBe(false);
  });

  it('load() returns false on a clean (non-corrupt) file', async () => {
    const { store } = newStore();
    await expect(store.load()).resolves.toBe(false); // missing file (ENOENT)
  });

  it('increments retryCount across repeated markPartial', async () => {
    const { store } = newStore();
    await store.load();
    store.markPartial('p1', {}, ['km-KH']);
    store.markPartial('p1', {}, ['km-KH']);
    expect(store.getProcessedEntry('p1')?.retryCount).toBe(2);
    expect(store.isProcessed('p1')).toBe(false); // PARTIAL not FULL
  });

  it('setRecheckAfter sets cooldown without changing status/assigned (PARTIAL preserved)', async () => {
    const { store } = newStore();
    await store.load();
    store.markPartial('rc1', { 'lo-LA': 'a@eqho.com' }, ['km-KH']);
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    store.setRecheckAfter('rc1', until);
    const e = store.getProcessedEntry('rc1');
    expect(e?.status).toBe('PARTIAL'); // not demoted to FULL
    expect(e?.recheckAfter).toBe(until);
    expect(e?.assigned).toEqual({ 'lo-LA': 'a@eqho.com' });
    expect(e?.failed).toEqual(['km-KH']);
    expect(e?.retryCount).toBe(1); // retry tracking preserved
  });

  it('markAbandoned persists an ABANDONED entry even when no prior entry exists', async () => {
    const { store } = newStore();
    await store.load();
    store.markAbandoned('gone'); // entry was pruned between ticks
    const e = store.getProcessedEntry('gone');
    expect(e?.status).toBe('ABANDONED');
    expect(e?.assigned).toEqual({});
  });

  it('markAbandoned flips status and isProcessed stays false', async () => {
    const { store } = newStore();
    await store.load();
    store.markPartial('p2', {}, ['km-KH']);
    store.markAbandoned('p2');
    expect(store.getProcessStatus('p2')).toBe('ABANDONED');
    expect(store.isProcessed('p2')).toBe(false);
  });

  it('markProcessed merges assigned across separate ticks (km-KH then lo-LA)', async () => {
    const { store } = newStore();
    await store.load();
    store.markProcessed('m1', { 'km-KH': 'kh_e3@eqho.com' });
    // job re-opens later when lo-LA becomes claimable; re-marking FULL must keep km-KH
    store.markProcessed('m1', { 'lo-LA': 'LO_T4@eqho.com' });
    const e = store.getProcessedEntry('m1');
    expect(e?.status).toBe('FULL');
    expect(e?.assigned).toEqual({ 'km-KH': 'kh_e3@eqho.com', 'lo-LA': 'LO_T4@eqho.com' });
  });

  it('markProcessed sets recheckAfter when given, and a later productive call clears it', async () => {
    const { store } = newStore();
    await store.load();
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    // re-opened to nothing assignable → cooldown
    store.markProcessed('cd1', {}, until);
    expect(store.getProcessedEntry('cd1')?.recheckAfter).toBe(until);
    // later a language became claimable and was assigned → cooldown cleared
    store.markProcessed('cd1', { 'lo-LA': 'a@eqho.com' });
    expect(store.getProcessedEntry('cd1')?.recheckAfter).toBeUndefined();
    expect(store.getProcessedEntry('cd1')?.assigned).toEqual({ 'lo-LA': 'a@eqho.com' });
  });

  it('markPartial accumulates assigned across retries', async () => {
    const { store } = newStore();
    await store.load();
    store.markPartial('acc1', { 'lo-LA': 'a@eqho.com' }, ['km-KH']);
    store.markPartial('acc1', { 'km-KH': 'b@eqho.com' }, []);
    const e = store.getProcessedEntry('acc1');
    expect(e?.assigned).toEqual({ 'lo-LA': 'a@eqho.com', 'km-KH': 'b@eqho.com' });
    expect(e?.retryCount).toBe(2);
  });

  it('markAbandoned refreshes processedAt and keeps prior assigned', async () => {
    const { store } = newStore();
    await store.load();
    store.markPartial('ab1', { 'lo-LA': 'a@eqho.com' }, ['km-KH']);
    const before = store.getProcessedEntry('ab1')?.processedAt;
    await new Promise((r) => setTimeout(r, 5));
    store.markAbandoned('ab1');
    const e = store.getProcessedEntry('ab1');
    expect(e?.status).toBe('ABANDONED');
    expect(e?.assigned).toEqual({ 'lo-LA': 'a@eqho.com' });
    expect(e?.processedAt).not.toBe(before);
  });
});
