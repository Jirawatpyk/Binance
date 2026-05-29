import { promises as fs } from 'fs';
import path from 'path';

/** True if the error indicates the Playwright browser/page/context died and needs relaunch. */
export function isBrowserDeadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : '';
  return /target closed|target page, context or browser has been closed|browser has been closed|browsercontext.*closed|page was destroyed|connection closed/i.test(
    msg
  );
}

/**
 * Delete `*.corrupt.<timestamp>` backup files in `dir`, keeping the newest
 * `keep` (by the trailing timestamp). A recurring-corruption condition mints a
 * fresh backup on every load, so without this they accumulate unbounded.
 * Returns the number removed. Missing directory → 0 (nothing to prune).
 */
export async function pruneCorruptBackups(dir: string, keep: number): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  const backups = entries
    .map((f) => ({ f, m: f.match(/\.corrupt\.(\d+)$/) }))
    .filter((e): e is { f: string; m: RegExpMatchArray } => e.m !== null)
    .sort((a, b) => Number(b.m[1]) - Number(a.m[1])); // newest first
  let removed = 0;
  for (const { f } of backups.slice(keep)) {
    await fs.rm(path.join(dir, f), { force: true });
    removed += 1;
  }
  return removed;
}
