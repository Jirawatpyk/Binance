import { promises as fs } from 'fs';
import path from 'path';
import { LockHeldError } from './errors.js';

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't kill
    return true;
  } catch {
    return false;
  }
}

export class ProcessLock {
  constructor(private filePath: string) {}

  async acquire(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    // Clear a stale lock left by a previous abrupt exit (e.g. watchdog process.exit,
    // SIGKILL) where release() never ran. If the recorded PID is no longer alive,
    // the lock is stale and safe to remove.
    try {
      const contents = await fs.readFile(this.filePath, 'utf-8');
      const pid = parseInt(contents.split('\n')[0], 10);
      if (!Number.isNaN(pid) && !isProcessRunning(pid)) {
        await fs.unlink(this.filePath);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // ENOENT = no lock file, proceed normally
    }

    try {
      const handle = await fs.open(this.filePath, 'wx');
      await handle.write(`${process.pid}\n${new Date().toISOString()}`);
      await handle.close();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        let existingPid = 'unknown';
        try {
          existingPid = (await fs.readFile(this.filePath, 'utf-8')).split('\n')[0];
        } catch {
          /* swallow read error — lock content unreadable */
        }
        throw new LockHeldError(`Lock already held by PID ${existingPid}`, {
          lockFile: this.filePath,
        });
      }
      throw err;
    }
  }

  async release(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
