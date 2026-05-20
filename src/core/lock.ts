import { promises as fs } from 'fs';
import path from 'path';
import { LockHeldError } from './errors.js';

export class ProcessLock {
  constructor(private filePath: string) {}

  async acquire(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
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
