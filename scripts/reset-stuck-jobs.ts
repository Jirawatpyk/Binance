import 'dotenv/config';
import { promises as fs } from 'fs';
import type { State } from '../src/types/index.js';

// One-time recovery: remove processed-job records that were wrongly marked FULL
// with NO assignments (the empty-parse bug). These jobs never actually received
// a translator, so clearing them lets the bot re-evaluate them live next tick.
// Real assignments (non-empty `assigned`) and PARTIAL/ABANDONED records are kept.
// STOP the bot before running, then restart it so it reloads the cleaned state.
// Usage: npx tsx scripts/reset-stuck-jobs.ts [path-to-state.json]
const statePath = process.argv[2] ?? './data/state.json';

const state = JSON.parse(await fs.readFile(statePath, 'utf-8')) as State;
const before = Object.keys(state.processedJobs).length;

const removed: string[] = [];
for (const [id, e] of Object.entries(state.processedJobs)) {
  const empty = !e.assigned || Object.keys(e.assigned).length === 0;
  if (e.status === 'FULL' && empty) {
    removed.push(id);
    delete state.processedJobs[id];
  }
}

if (removed.length === 0) {
  console.log('Nothing to clean — no FULL-with-empty-assignments records found.');
  process.exit(0);
}

const backup = `${statePath}.bak.${Date.now()}`;
await fs.copyFile(statePath, backup);
await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');

console.log(`Backed up to ${backup}`);
console.log(`Removed ${removed.length} wrongly-FULL job(s): ${removed.join(', ')}`);
console.log(`processedJobs: ${before} -> ${Object.keys(state.processedJobs).length}`);
console.log('Round-robin counters left untouched. Now restart the bot.');
