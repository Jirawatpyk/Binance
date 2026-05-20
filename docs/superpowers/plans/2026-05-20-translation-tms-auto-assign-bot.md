# Translation TMS Auto-Assign Bot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Playwright-based Node.js bot that polls translationtms.com, detects unassigned `lo-LA` / `km-KH` translation jobs, and assigns translators based on YAML-driven word-count rules.

**Architecture:** Modular layered service — Scheduler → AuthSession → JobScanner → JobProcessor → AssignmentEngine (pure logic) → Assigner → StateStore. Pure logic separated from browser interaction for unit testability. Configuration externalized to YAML; secrets in `.env`.

**Tech Stack:** Node.js 20+, TypeScript 5, Playwright + playwright-extra + stealth plugin, winston (structured JSON logs), zod (schema validation), yaml, vitest (unit), @playwright/test (integration), Docker.

**Spec:** `docs/superpowers/specs/2026-05-20-translation-tms-auto-assign-bot-design.md`

---

## File Structure

**Create these files (in dependency order):**

| File | Responsibility |
|------|----------------|
| `package.json`, `tsconfig.json`, `.gitignore`, `.env.example` | Project scaffold |
| `src/types/index.ts` | Shared TypeScript types |
| `src/core/errors.ts` | Custom error classes |
| `src/core/logger.ts` | winston structured logger |
| `src/storage/config.ts` | YAML loader + zod validation |
| `src/storage/state.ts` | JSON state persistence (atomic write) |
| `src/assignment/engine.ts` | **Pure logic:** word-count → translator selection |
| `src/auth/session.ts` | Playwright login + cookie persistence |
| `src/scraper/job-scanner.ts` | Parse Job Board, filter lo-LA/km-KH |
| `src/scraper/job-processor.ts` | Parse Job Detail waiting languages |
| `src/assignment/assigner.ts` | Click Assign + verify (browser action) |
| `src/core/lock.ts` | Single-instance lock file |
| `src/core/screenshot.ts` | Error screenshot helper |
| `src/core/scheduler.ts` | Polling loop + shutdown handling |
| `src/index.ts` | Entry point — wires everything |
| `config/settings.example.yml`, `config/translators.example.yml` | Config templates |
| `tests/unit/*.test.ts` | Unit tests (vitest) |
| `tests/integration/*.test.ts` | Integration tests (Playwright Test) |
| `Dockerfile`, `docker-compose.yml` | Container deployment |
| `scripts/install-windows-service.js` | Windows service registration |
| `README.md` | Setup and operation docs |

---

## Prerequisites

Before starting, verify the workstation has:

- Node.js 20+ (`node --version`)
- Git
- PowerShell 5+
- Project root: `C:\Users\Jirawat.p\Documents\Binance` (current git repo)

All commands assume PowerShell from project root.

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `playwright.config.ts`
- Create: `vitest.config.ts`

- [ ] **Step 1.1: Initialize npm and write `package.json`**

```json
{
  "name": "binance-translation-bot",
  "version": "0.1.0",
  "description": "Auto-Assign Bot for translationtms.com (lo-LA / km-KH)",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "playwright test",
    "typecheck": "tsc --noEmit"
  },
  "engines": { "node": ">=20.0.0" },
  "dependencies": {
    "playwright": "^1.49.0",
    "playwright-extra": "^4.3.6",
    "puppeteer-extra-plugin-stealth": "^2.11.2",
    "winston": "^3.17.0",
    "winston-daily-rotate-file": "^5.0.0",
    "zod": "^3.24.1",
    "yaml": "^2.6.1",
    "dotenv": "^16.4.7"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "@types/node": "^22.10.5",
    "typescript": "^5.7.2",
    "tsx": "^4.19.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 1.2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 1.3: Write `.gitignore`**

```
node_modules/
dist/
.env
config/settings.yml
config/translators.yml
data/
logs/
*.log
playwright-report/
test-results/
```

- [ ] **Step 1.4: Write `.env.example`**

```
TMS_USERNAME=binance@eqho.com
TMS_PASSWORD=Eqho-Binance2025
```

- [ ] **Step 1.5: Write `playwright.config.ts`**

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/integration',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
```

- [ ] **Step 1.6: Write `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
```

- [ ] **Step 1.7: Install dependencies and verify**

```powershell
npm install
npx playwright install chromium
npm run typecheck
```

Expected: `typecheck` exits 0 (no errors; project compiles).

- [ ] **Step 1.8: Commit**

```powershell
git add package.json package-lock.json tsconfig.json .gitignore .env.example playwright.config.ts vitest.config.ts
git commit -m "chore: scaffold TypeScript + Playwright project"
```

---

## Task 2: Type Definitions

**Files:**
- Create: `src/types/index.ts`

- [ ] **Step 2.1: Write all shared types**

```typescript
export type SupportedLanguage = 'lo-LA' | 'km-KH';

export interface Job {
  id: string;
  name: string;
  dueDate: Date;
  project: string;
  languageCount: number;
  languagesNeeded: string[];
  wordCount: number;
  detailUrl: string;
}

export interface TargetLanguage {
  code: SupportedLanguage;
  status: string;
  translator: string | null;
  rowIndex: number;
}

export interface JobDetail {
  jobId: string;
  wordCount: number;
  targetLanguages: TargetLanguage[];
}

export interface AssignmentRule {
  maxWords: number | null;
  translators: string[];
}

export interface LanguageConfig {
  rules: AssignmentRule[];
}

export interface TranslatorsConfig {
  'lo-LA'?: LanguageConfig;
  'km-KH'?: LanguageConfig;
}

export interface Settings {
  polling: { intervalMinutes: number; jitterSeconds: number };
  browser: { headless: boolean; viewport: { width: number; height: number }; navigationTimeoutMs: number };
  storage: { statePath: string; logsDir: string; cookiesPath: string };
  assignment: { dryRun: boolean; maxRetries: number; retryDelayMs: number };
  logging: { level: 'debug' | 'info' | 'warn' | 'error'; rotateDays: number };
}

export type ProcessStatus = 'FULL' | 'PARTIAL';

export interface ProcessedJobEntry {
  processedAt: string;
  status: ProcessStatus;
  assigned: Partial<Record<SupportedLanguage, string>>;
  failed?: SupportedLanguage[];
}

export interface State {
  processedJobs: Record<string, ProcessedJobEntry>;
  roundRobinCounters: Record<string, number>;
}

export interface AssignmentResult {
  language: SupportedLanguage;
  success: boolean;
  translator?: string;
  error?: string;
}
```

- [ ] **Step 2.2: Verify compile**

```powershell
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 2.3: Commit**

```powershell
git add src/types/index.ts
git commit -m "feat(types): add shared type definitions"
```

---

## Task 3: Custom Errors

**Files:**
- Create: `src/core/errors.ts`

- [ ] **Step 3.1: Write error classes**

```typescript
export class BotError extends Error {
  constructor(message: string, public context?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class LoginFailedError extends BotError {}
export class SelectorNotFoundError extends BotError {}
export class TranslatorNotFoundError extends BotError {}
export class AssignmentFailedError extends BotError {}
export class ConfigValidationError extends BotError {}
export class LockHeldError extends BotError {}
```

- [ ] **Step 3.2: Verify compile**

```powershell
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 3.3: Commit**

```powershell
git add src/core/errors.ts
git commit -m "feat(core): add custom error classes"
```

---

## Task 4: Logger

**Files:**
- Create: `src/core/logger.ts`

- [ ] **Step 4.1: Write logger factory**

```typescript
import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';

export interface LoggerConfig {
  level: string;
  logsDir: string;
  rotateDays: number;
}

export function createLogger(config: LoggerConfig): winston.Logger {
  const fileFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  );

  const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf((info) => {
      const { timestamp, level, message, ...meta } = info;
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `${String(timestamp)} [${level}] ${String(message)}${metaStr}`;
    })
  );

  return winston.createLogger({
    level: config.level,
    format: fileFormat,
    transports: [
      new winston.transports.Console({ format: consoleFormat }),
      new winston.transports.DailyRotateFile({
        filename: path.join(config.logsDir, 'app-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxFiles: `${config.rotateDays}d`,
      }),
      new winston.transports.DailyRotateFile({
        filename: path.join(config.logsDir, 'error-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        level: 'error',
        maxFiles: `${config.rotateDays}d`,
      }),
    ],
  });
}
```

- [ ] **Step 4.2: Verify compile**

```powershell
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 4.3: Commit**

```powershell
git add src/core/logger.ts
git commit -m "feat(core): add winston logger factory"
```

---

## Task 5: Config Loader (TDD)

**Files:**
- Create: `src/storage/config.ts`
- Create: `tests/unit/config-loader.test.ts`
- Create: `config/settings.example.yml`
- Create: `config/translators.example.yml`

- [ ] **Step 5.1: Write example YAMLs**

`config/settings.example.yml`:
```yaml
polling:
  intervalMinutes: 5
  jitterSeconds: 30

browser:
  headless: true
  viewport: { width: 1920, height: 1080 }
  navigationTimeoutMs: 30000

storage:
  statePath: ./data/state.json
  logsDir: ./logs
  cookiesPath: ./data/cookies.json

assignment:
  dryRun: false
  maxRetries: 3
  retryDelayMs: 5000

logging:
  level: info
  rotateDays: 14
```

`config/translators.example.yml`:
```yaml
lo-LA:
  rules:
    - maxWords: 500
      translators: [LO_T1@eqho.com]
    - maxWords: 2000
      translators: [LO_T3@eqho.com]
    - maxWords: null
      translators: [LO_T3@eqho.com, LO_T4@eqho.com]

km-KH:
  rules:
    - maxWords: 500
      translators: [KM_T1@eqho.com]
    - maxWords: null
      translators: [KM_T1@eqho.com, KM_T2@eqho.com]
```

- [ ] **Step 5.2: Write failing tests**

`tests/unit/config-loader.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { loadSettings, loadTranslators } from '../../src/storage/config.js';

function makeTmp(file: string, content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const p = path.join(dir, file);
  writeFileSync(p, content);
  return p;
}

describe('loadSettings', () => {
  it('parses valid settings yaml', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000 }
logging: { level: info, rotateDays: 14 }
`);
    const s = loadSettings(p);
    expect(s.polling.intervalMinutes).toBe(5);
    expect(s.logging.level).toBe('info');
  });

  it('throws on invalid level', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: x, logsDir: y, cookiesPath: z }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000 }
logging: { level: WRONG, rotateDays: 14 }
`);
    expect(() => loadSettings(p)).toThrow();
  });
});

describe('loadTranslators', () => {
  it('parses translator rules', () => {
    const p = makeTmp('t.yml', `
lo-LA:
  rules:
    - maxWords: 500
      translators: [a@eqho.com]
    - maxWords: null
      translators: [b@eqho.com, c@eqho.com]
`);
    const t = loadTranslators(p);
    expect(t['lo-LA']?.rules.length).toBe(2);
    expect(t['lo-LA']?.rules[1].maxWords).toBeNull();
  });

  it('rejects empty translators array', () => {
    const p = makeTmp('t.yml', `
lo-LA:
  rules:
    - maxWords: 500
      translators: []
`);
    expect(() => loadTranslators(p)).toThrow();
  });
});
```

- [ ] **Step 5.3: Run tests to verify FAIL**

```powershell
npm run test
```

Expected: 4 tests fail (`loadSettings`, `loadTranslators` not found).

- [ ] **Step 5.4: Implement `src/storage/config.ts`**

```typescript
import { z } from 'zod';
import { readFileSync } from 'fs';
import * as YAML from 'yaml';
import type { Settings, TranslatorsConfig } from '../types/index.js';
import { ConfigValidationError } from '../core/errors.js';

const settingsSchema = z.object({
  polling: z.object({
    intervalMinutes: z.number().positive(),
    jitterSeconds: z.number().min(0),
  }),
  browser: z.object({
    headless: z.boolean(),
    viewport: z.object({ width: z.number().positive(), height: z.number().positive() }),
    navigationTimeoutMs: z.number().positive(),
  }),
  storage: z.object({
    statePath: z.string().min(1),
    logsDir: z.string().min(1),
    cookiesPath: z.string().min(1),
  }),
  assignment: z.object({
    dryRun: z.boolean(),
    maxRetries: z.number().int().nonnegative(),
    retryDelayMs: z.number().positive(),
  }),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']),
    rotateDays: z.number().positive(),
  }),
});

const ruleSchema = z.object({
  maxWords: z.number().positive().nullable(),
  translators: z.array(z.string().email()).min(1),
});

const langConfigSchema = z.object({ rules: z.array(ruleSchema).min(1) });

const translatorsSchema = z.object({
  'lo-LA': langConfigSchema.optional(),
  'km-KH': langConfigSchema.optional(),
});

export function loadSettings(filePath: string): Settings {
  const raw = YAML.parse(readFileSync(filePath, 'utf-8'));
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigValidationError('Invalid settings.yml', { issues: parsed.error.issues });
  }
  return parsed.data;
}

export function loadTranslators(filePath: string): TranslatorsConfig {
  const raw = YAML.parse(readFileSync(filePath, 'utf-8'));
  const parsed = translatorsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigValidationError('Invalid translators.yml', { issues: parsed.error.issues });
  }
  return parsed.data;
}
```

- [ ] **Step 5.5: Run tests to verify PASS**

```powershell
npm run test
```

Expected: 4 tests pass.

- [ ] **Step 5.6: Commit**

```powershell
git add src/storage/config.ts tests/unit/config-loader.test.ts config/settings.example.yml config/translators.example.yml
git commit -m "feat(storage): add YAML config loader with zod validation"
```

---

## Task 6: State Store (TDD)

**Files:**
- Create: `src/storage/state.ts`
- Create: `tests/unit/state-store.test.ts`

- [ ] **Step 6.1: Write failing tests**

`tests/unit/state-store.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync } from 'fs';
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
});
```

- [ ] **Step 6.2: Run tests to verify FAIL**

```powershell
npm run test
```

Expected: 5 new tests fail (`StateStore` not found).

- [ ] **Step 6.3: Implement `src/storage/state.ts`**

```typescript
import { promises as fs } from 'fs';
import path from 'path';
import type { State, SupportedLanguage } from '../types/index.js';

export class StateStore {
  private state: State = { processedJobs: {}, roundRobinCounters: {} };
  private dirty = false;

  constructor(private filePath: string) {}

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      this.state = JSON.parse(content);
      if (!this.state.processedJobs) this.state.processedJobs = {};
      if (!this.state.roundRobinCounters) this.state.roundRobinCounters = {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.state = { processedJobs: {}, roundRobinCounters: {} };
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
    await fs.rename(tmp, this.filePath);
    this.dirty = false;
  }

  isProcessed(jobId: string): boolean {
    return this.state.processedJobs[jobId]?.status === 'FULL';
  }

  getProcessStatus(jobId: string): 'FULL' | 'PARTIAL' | undefined {
    return this.state.processedJobs[jobId]?.status;
  }

  getProcessedEntry(jobId: string) {
    return this.state.processedJobs[jobId];
  }

  markProcessed(jobId: string, assigned: Partial<Record<SupportedLanguage, string>>): void {
    this.state.processedJobs[jobId] = {
      processedAt: new Date().toISOString(),
      status: 'FULL',
      assigned,
    };
    this.dirty = true;
  }

  markPartial(
    jobId: string,
    assigned: Partial<Record<SupportedLanguage, string>>,
    failed: SupportedLanguage[]
  ): void {
    this.state.processedJobs[jobId] = {
      processedAt: new Date().toISOString(),
      status: 'PARTIAL',
      assigned,
      failed,
    };
    this.dirty = true;
  }

  getRRIndex(key: string): number {
    return this.state.roundRobinCounters[key] ?? 0;
  }

  incrementRR(key: string): void {
    this.state.roundRobinCounters[key] = (this.state.roundRobinCounters[key] ?? 0) + 1;
    this.dirty = true;
  }
}
```

- [ ] **Step 6.4: Run tests to verify PASS**

```powershell
npm run test
```

Expected: all tests pass.

- [ ] **Step 6.5: Commit**

```powershell
git add src/storage/state.ts tests/unit/state-store.test.ts
git commit -m "feat(storage): add atomic JSON state store with round-robin counters"
```

---

## Task 7: Assignment Engine (TDD — pure logic)

**Files:**
- Create: `src/assignment/engine.ts`
- Create: `tests/unit/assignment-engine.test.ts`

- [ ] **Step 7.1: Write failing tests**

`tests/unit/assignment-engine.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { AssignmentEngine } from '../../src/assignment/engine.js';
import type { TranslatorsConfig } from '../../src/types/index.js';

const config: TranslatorsConfig = {
  'lo-LA': {
    rules: [
      { maxWords: 500, translators: ['LO_T1@eqho.com'] },
      { maxWords: 2000, translators: ['LO_T3@eqho.com'] },
      { maxWords: null, translators: ['LO_T3@eqho.com', 'LO_T4@eqho.com'] },
    ],
  },
  'km-KH': {
    rules: [
      { maxWords: 500, translators: ['KM_T1@eqho.com'] },
      { maxWords: null, translators: ['KM_T1@eqho.com', 'KM_T2@eqho.com'] },
    ],
  },
};

function makeEngine(rrCounters: Record<string, number> = {}) {
  return new AssignmentEngine(config, {
    getRRIndex: (k) => rrCounters[k] ?? 0,
  });
}

describe('AssignmentEngine.pick', () => {
  it('picks first-tier translator for low word count', () => {
    const r = makeEngine().pick('lo-LA', 100);
    expect(r.translator).toBe('LO_T1@eqho.com');
    expect(r.ruleIndex).toBe(0);
    expect(r.useRoundRobin).toBe(false);
  });

  it('picks second-tier at the upper boundary (inclusive)', () => {
    const r = makeEngine().pick('lo-LA', 500);
    expect(r.translator).toBe('LO_T1@eqho.com');
  });

  it('picks middle-tier when word count fits middle rule', () => {
    const r = makeEngine().pick('lo-LA', 1500);
    expect(r.translator).toBe('LO_T3@eqho.com');
    expect(r.ruleIndex).toBe(1);
  });

  it('uses round-robin for tier with multiple translators (idx 0)', () => {
    const r = makeEngine({ 'lo-LA:rule2': 0 }).pick('lo-LA', 5000);
    expect(r.translator).toBe('LO_T3@eqho.com');
    expect(r.useRoundRobin).toBe(true);
    expect(r.rrKey).toBe('lo-LA:rule2');
  });

  it('uses round-robin for tier with multiple translators (idx 1)', () => {
    const r = makeEngine({ 'lo-LA:rule2': 1 }).pick('lo-LA', 5000);
    expect(r.translator).toBe('LO_T4@eqho.com');
  });

  it('round-robin wraps using modulo', () => {
    const r = makeEngine({ 'lo-LA:rule2': 3 }).pick('lo-LA', 5000);
    expect(r.translator).toBe('LO_T4@eqho.com'); // 3 % 2 = 1
  });

  it('handles km-KH separately', () => {
    const r = makeEngine().pick('km-KH', 300);
    expect(r.translator).toBe('KM_T1@eqho.com');
  });

  it('throws if language has no config', () => {
    const engine = new AssignmentEngine({}, { getRRIndex: () => 0 });
    expect(() => engine.pick('lo-LA', 100)).toThrow();
  });
});
```

- [ ] **Step 7.2: Run tests to verify FAIL**

```powershell
npm run test
```

Expected: tests fail (`AssignmentEngine` not found).

- [ ] **Step 7.3: Implement `src/assignment/engine.ts`**

```typescript
import type { TranslatorsConfig, SupportedLanguage } from '../types/index.js';
import { BotError } from '../core/errors.js';

export interface RRReader {
  getRRIndex(key: string): number;
}

export interface PickResult {
  translator: string;
  ruleIndex: number;
  useRoundRobin: boolean;
  rrKey?: string;
}

export class AssignmentEngine {
  constructor(private config: TranslatorsConfig, private rr: RRReader) {}

  pick(language: SupportedLanguage, wordCount: number): PickResult {
    const langConfig = this.config[language];
    if (!langConfig) {
      throw new BotError(`No translator config for language ${language}`);
    }

    const ruleIndex = langConfig.rules.findIndex(
      (r) => r.maxWords === null || wordCount <= r.maxWords
    );
    if (ruleIndex < 0) {
      throw new BotError(`No matching rule for ${language} wordCount=${wordCount}`);
    }

    const rule = langConfig.rules[ruleIndex];
    if (rule.translators.length === 1) {
      return { translator: rule.translators[0], ruleIndex, useRoundRobin: false };
    }

    const rrKey = `${language}:rule${ruleIndex}`;
    const idx = this.rr.getRRIndex(rrKey) % rule.translators.length;
    return {
      translator: rule.translators[idx],
      ruleIndex,
      useRoundRobin: true,
      rrKey,
    };
  }
}
```

- [ ] **Step 7.4: Run tests to verify PASS**

```powershell
npm run test
```

Expected: all assignment-engine tests pass.

- [ ] **Step 7.5: Commit**

```powershell
git add src/assignment/engine.ts tests/unit/assignment-engine.test.ts
git commit -m "feat(assignment): add pure-logic word-count → translator engine"
```

---

## Task 8: Screenshot Helper

**Files:**
- Create: `src/core/screenshot.ts`

- [ ] **Step 8.1: Write helper**

```typescript
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
```

- [ ] **Step 8.2: Verify compile**

```powershell
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 8.3: Commit**

```powershell
git add src/core/screenshot.ts
git commit -m "feat(core): add screenshot helper for debugging"
```

---

## Task 9: Lock File (single-instance)

**Files:**
- Create: `src/core/lock.ts`

- [ ] **Step 9.1: Write lock helper**

```typescript
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
```

- [ ] **Step 9.2: Verify compile**

```powershell
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 9.3: Commit**

```powershell
git add src/core/lock.ts
git commit -m "feat(core): add single-instance process lock"
```

---

## Task 10: Auth Session (Playwright)

**Files:**
- Create: `src/auth/session.ts`

- [ ] **Step 10.1: Write session manager**

```typescript
import { chromium } from 'playwright-extra';
// @ts-expect-error — puppeteer-extra plugin types aren't bundled
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';
import type { Settings } from '../types/index.js';
import { LoginFailedError } from '../core/errors.js';
import type winston from 'winston';

chromium.use(StealthPlugin());

const LOGIN_URL = 'https://www.translationtms.com/login';
const JOB_BOARD_URL = 'https://www.translationtms.com/job-board';

export interface Credentials {
  username: string;
  password: string;
}

export class AuthSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  constructor(
    private settings: Settings,
    private creds: Credentials,
    private logger: winston.Logger
  ) {}

  async start(): Promise<Page> {
    this.browser = await chromium.launch({ headless: this.settings.browser.headless });
    const cookiesPath = this.settings.storage.cookiesPath;
    const contextOptions: Parameters<Browser['newContext']>[0] = {
      viewport: this.settings.browser.viewport,
    };
    try {
      await fs.access(cookiesPath);
      contextOptions.storageState = cookiesPath;
      this.logger.info('loaded existing session cookies', { cookiesPath });
    } catch {
      this.logger.info('no existing cookies; will login fresh');
    }
    this.context = await this.browser.newContext(contextOptions);
    this.context.setDefaultNavigationTimeout(this.settings.browser.navigationTimeoutMs);
    this.page = await this.context.newPage();
    await this.ensureLoggedIn();
    return this.page;
  }

  async ensureLoggedIn(): Promise<void> {
    if (!this.page || !this.context) throw new LoginFailedError('Session not started');
    await this.page.goto(JOB_BOARD_URL, { waitUntil: 'domcontentloaded' });
    if (!this.page.url().includes('/login')) {
      this.logger.info('session still valid');
      return;
    }
    this.logger.info('session expired or absent; performing login');
    await this.page.goto(LOGIN_URL);
    await this.page.fill('input[type="email"], input[name="email"], input[name="username"]', this.creds.username);
    await this.page.fill('input[type="password"], input[name="password"]', this.creds.password);
    await Promise.all([
      this.page.waitForURL(/job-board|dashboard/i, { timeout: this.settings.browser.navigationTimeoutMs }),
      this.page.click('button[type="submit"], button:has-text("Login"), button:has-text("Sign in")'),
    ]);
    if (this.page.url().includes('/login')) {
      throw new LoginFailedError('Still on login page after submit');
    }
    await fs.mkdir(path.dirname(this.settings.storage.cookiesPath), { recursive: true });
    await this.context.storageState({ path: this.settings.storage.cookiesPath });
    this.logger.info('login successful; cookies saved');
  }

  getPage(): Page {
    if (!this.page) throw new LoginFailedError('Session not started');
    return this.page;
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
  }
}
```

> **Note:** Selector strings (`input[name="email"]` etc.) are best-guess defaults — Task 18 (codegen verification) will confirm/adjust them against the real site.

- [ ] **Step 10.2: Verify compile**

```powershell
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 10.3: Commit**

```powershell
git add src/auth/session.ts
git commit -m "feat(auth): add Playwright session manager with cookie persistence"
```

---

## Task 11: Job Scanner

**Files:**
- Create: `src/scraper/job-scanner.ts`

- [ ] **Step 11.1: Write scanner**

```typescript
import type { Page } from 'playwright';
import type { Job, SupportedLanguage } from '../types/index.js';
import type winston from 'winston';

const SUPPORTED: SupportedLanguage[] = ['lo-LA', 'km-KH'];
const JOB_BOARD_URL = 'https://www.translationtms.com/job-board';

export class JobScanner {
  constructor(private page: Page, private logger: winston.Logger) {}

  async scan(): Promise<Job[]> {
    await this.page.goto(JOB_BOARD_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForSelector('table, [role="table"]', { timeout: 15_000 });
    const rows = await this.parseRows();
    const filtered = rows.filter((j) =>
      j.languagesNeeded.some((l) => (SUPPORTED as string[]).includes(l))
    );
    this.logger.info('job scan complete', {
      total: rows.length,
      candidates: filtered.length,
      candidateIds: filtered.map((j) => j.id),
    });
    return filtered;
  }

  private async parseRows(): Promise<Job[]> {
    return this.page.$$eval('table tbody tr, [role="row"]', (rowEls) => {
      const out: Array<{
        id: string;
        name: string;
        dueDate: string;
        project: string;
        languageCount: number;
        languagesNeeded: string[];
        wordCount: number;
        detailUrl: string;
      }> = [];
      for (const row of rowEls) {
        const cells = row.querySelectorAll('td, [role="cell"]');
        if (cells.length < 8) continue;
        const idText = cells[0]?.textContent?.trim() ?? '';
        if (!/^\d+$/.test(idText)) continue;
        const langTags = Array.from(cells[6].querySelectorAll('[class*="tag"], span, .badge'))
          .map((el) => el.textContent?.trim() ?? '')
          .filter((s) => s.length > 0 && !s.startsWith('+'));
        const openLink = (row.querySelector('a[href*="job"], button[data-href]') as HTMLAnchorElement | null);
        out.push({
          id: idText,
          name: cells[1]?.textContent?.trim() ?? '',
          dueDate: cells[2]?.textContent?.trim() ?? '',
          project: cells[4]?.textContent?.trim() ?? '',
          languageCount: Number(cells[5]?.textContent?.trim() ?? 0),
          languagesNeeded: langTags,
          wordCount: Number(cells[7]?.textContent?.trim().replace(/,/g, '') ?? 0),
          detailUrl: openLink?.href ?? `https://www.translationtms.com/job/${idText}`,
        });
      }
      return out;
    }).then((raw) =>
      raw.map((r) => ({
        ...r,
        dueDate: new Date(r.dueDate),
      }))
    );
  }
}
```

> **Note:** Cell indices and selectors are derived from the screenshot in the spec. If the real DOM differs, adjust during Task 18 codegen verification.

- [ ] **Step 11.2: Verify compile**

```powershell
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 11.3: Commit**

```powershell
git add src/scraper/job-scanner.ts
git commit -m "feat(scraper): add Job Board scanner with lo-LA/km-KH filter"
```

---

## Task 12: Job Processor

**Files:**
- Create: `src/scraper/job-processor.ts`

- [ ] **Step 12.1: Write processor**

```typescript
import type { Page } from 'playwright';
import type { JobDetail, SupportedLanguage, TargetLanguage } from '../types/index.js';
import type winston from 'winston';

const SUPPORTED: SupportedLanguage[] = ['lo-LA', 'km-KH'];

export class JobProcessor {
  constructor(private page: Page, private logger: winston.Logger) {}

  async open(detailUrl: string, jobId: string): Promise<JobDetail> {
    await this.page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
    await this.page.waitForSelector('text=Word Count', { timeout: 15_000 });
    const wordCount = await this.readWordCount();
    const waitingTab = this.page.locator('text=Waiting').first();
    if (await waitingTab.isVisible()) await waitingTab.click();
    await this.page.waitForTimeout(500);
    const languages = await this.parseLanguageRows();
    this.logger.info('job detail parsed', { jobId, wordCount, languages: languages.map((l) => l.code) });
    return { jobId, wordCount, targetLanguages: languages };
  }

  private async readWordCount(): Promise<number> {
    const txt = await this.page
      .locator('xpath=//*[contains(text(),"Word Count")]/following-sibling::*[1]')
      .first()
      .textContent();
    return Number((txt ?? '0').replace(/,/g, '').trim());
  }

  private async parseLanguageRows(): Promise<TargetLanguage[]> {
    const rows = this.page.locator('table tbody tr');
    const count = await rows.count();
    const out: TargetLanguage[] = [];
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const langText = (await row.locator('td').nth(0).textContent() ?? '').trim();
      const code = this.detectCode(langText);
      if (!code) continue;
      const translatorText = (await row.locator('td').nth(2).textContent() ?? '').trim();
      const statusText = (await row.locator('[class*="status"], td:has-text("WAITING"), td:has-text("IN_PROGRESS")').first().textContent() ?? '').trim();
      out.push({
        code,
        status: statusText || 'UNKNOWN',
        translator: translatorText === '-' || translatorText === '' ? null : translatorText,
        rowIndex: i,
      });
    }
    return out;
  }

  private detectCode(text: string): SupportedLanguage | null {
    if (text.includes('lo-LA') || text.toLowerCase().includes('lao')) return 'lo-LA';
    if (text.includes('km-KH') || text.toLowerCase().includes('khmer')) return 'km-KH';
    return null;
  }
}
```

- [ ] **Step 12.2: Verify compile**

```powershell
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 12.3: Commit**

```powershell
git add src/scraper/job-processor.ts
git commit -m "feat(scraper): add Job Detail processor parsing waiting languages"
```

---

## Task 13: Assigner

**Files:**
- Create: `src/assignment/assigner.ts`

- [ ] **Step 13.1: Write assigner**

```typescript
import type { Page } from 'playwright';
import type { SupportedLanguage } from '../types/index.js';
import { AssignmentFailedError, TranslatorNotFoundError } from '../core/errors.js';
import type winston from 'winston';

export class Assigner {
  constructor(
    private page: Page,
    private logger: winston.Logger,
    private dryRun: boolean
  ) {}

  async assign(language: SupportedLanguage, translatorEmail: string, rowIndex: number): Promise<void> {
    const row = this.page.locator('table tbody tr').nth(rowIndex);
    const assignBtn = row.locator('button:has-text("Assign")').first();
    if (!(await assignBtn.isVisible())) {
      throw new AssignmentFailedError('Assign button not visible', { language, rowIndex });
    }

    if (this.dryRun) {
      this.logger.info('[DRY-RUN] would click Assign', { language, translatorEmail, rowIndex });
      return;
    }

    await assignBtn.click();
    const modal = this.page.locator('[role="dialog"], .modal').first();
    await modal.waitFor({ state: 'visible', timeout: 10_000 });
    const userRow = modal.locator(`text=${translatorEmail}`).first();
    if (!(await userRow.isVisible({ timeout: 5_000 }).catch(() => false))) {
      throw new TranslatorNotFoundError(`Translator ${translatorEmail} not in popup`, {
        language,
      });
    }

    const rowAssign = modal
      .locator(`xpath=//*[contains(text(),"${translatorEmail}")]/ancestor::*[self::div or self::tr][1]//button[contains(text(),"Assign")]`)
      .first();
    await rowAssign.click();
    await modal.waitFor({ state: 'hidden', timeout: 10_000 });
    this.logger.info('assignment submitted', { language, translatorEmail });
  }
}
```

- [ ] **Step 13.2: Verify compile**

```powershell
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 13.3: Commit**

```powershell
git add src/assignment/assigner.ts
git commit -m "feat(assignment): add Assigner with dry-run + modal handling"
```

---

## Task 14: Scheduler

**Files:**
- Create: `src/core/scheduler.ts`

- [ ] **Step 14.1: Write scheduler**

```typescript
import type winston from 'winston';

export interface SchedulerConfig {
  intervalMinutes: number;
  jitterSeconds: number;
}

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopRequested = false;

  constructor(
    private config: SchedulerConfig,
    private tickFn: () => Promise<void>,
    private logger: winston.Logger
  ) {}

  start(): void {
    this.logger.info('scheduler started', { intervalMinutes: this.config.intervalMinutes });
    this.scheduleNext(0);
    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopRequested) return;
    this.timer = setTimeout(async () => {
      if (this.running) {
        this.logger.warn('previous tick still running; skipping');
        this.scheduleNext(this.calcDelay());
        return;
      }
      this.running = true;
      try {
        await this.tickFn();
      } catch (err) {
        this.logger.error('scheduler tick failed', { error: (err as Error).message });
      } finally {
        this.running = false;
      }
      this.scheduleNext(this.calcDelay());
    }, delayMs);
  }

  private calcDelay(): number {
    const base = this.config.intervalMinutes * 60 * 1000;
    const jitter = Math.random() * this.config.jitterSeconds * 1000;
    return base + jitter;
  }

  stop(reason: string): void {
    this.logger.info('scheduler stopping', { reason });
    this.stopRequested = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
```

- [ ] **Step 14.2: Verify compile**

```powershell
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 14.3: Commit**

```powershell
git add src/core/scheduler.ts
git commit -m "feat(core): add polling scheduler with jitter + overlap guard"
```

---

## Task 15: Entry Point

**Files:**
- Create: `src/index.ts`

- [ ] **Step 15.1: Write entry point**

```typescript
import 'dotenv/config';
import path from 'path';
import { loadSettings, loadTranslators } from './storage/config.js';
import { createLogger } from './core/logger.js';
import { StateStore } from './storage/state.js';
import { AssignmentEngine } from './assignment/engine.js';
import { AuthSession } from './auth/session.js';
import { JobScanner } from './scraper/job-scanner.js';
import { JobProcessor } from './scraper/job-processor.js';
import { Assigner } from './assignment/assigner.js';
import { Scheduler } from './core/scheduler.js';
import { ProcessLock } from './core/lock.js';
import { captureScreenshot } from './core/screenshot.js';
import type { SupportedLanguage } from './types/index.js';

const SETTINGS_PATH = process.env.SETTINGS_PATH ?? './config/settings.yml';
const TRANSLATORS_PATH = process.env.TRANSLATORS_PATH ?? './config/translators.yml';
const LOCK_PATH = './data/.lock';

async function main(): Promise<void> {
  const settings = loadSettings(SETTINGS_PATH);
  const translators = loadTranslators(TRANSLATORS_PATH);
  const logger = createLogger({
    level: settings.logging.level,
    logsDir: settings.storage.logsDir,
    rotateDays: settings.logging.rotateDays,
  });

  const username = process.env.TMS_USERNAME;
  const password = process.env.TMS_PASSWORD;
  if (!username || !password) {
    logger.error('TMS_USERNAME / TMS_PASSWORD missing from environment');
    process.exit(1);
  }

  const lock = new ProcessLock(LOCK_PATH);
  await lock.acquire();
  logger.info('process lock acquired', { lockPath: LOCK_PATH });

  const state = new StateStore(settings.storage.statePath);
  await state.load();

  const session = new AuthSession(settings, { username, password }, logger);
  const page = await session.start();

  const engine = new AssignmentEngine(translators, state);
  const scanner = new JobScanner(page, logger);
  const processor = new JobProcessor(page, logger);
  const assigner = new Assigner(page, logger, settings.assignment.dryRun);

  const tick = async (): Promise<void> => {
    logger.info('tick started');
    await session.ensureLoggedIn();
    const candidates = await scanner.scan();
    for (const job of candidates) {
      if (state.isProcessed(job.id)) continue;
      try {
        const detail = await processor.open(job.detailUrl, job.id);
        const assigned: Partial<Record<SupportedLanguage, string>> = {};
        const failed: SupportedLanguage[] = [];
        for (const lang of detail.targetLanguages) {
          if (lang.translator !== null) continue;
          if (lang.status !== 'WAITING_TRANSLATION' && !lang.status.includes('WAITING')) continue;
          try {
            const pick = engine.pick(lang.code, detail.wordCount);
            await assigner.assign(lang.code, pick.translator, lang.rowIndex);
            assigned[lang.code] = pick.translator;
            if (pick.useRoundRobin && pick.rrKey) state.incrementRR(pick.rrKey);
          } catch (err) {
            failed.push(lang.code);
            logger.error('assignment failed', {
              jobId: job.id,
              language: lang.code,
              error: (err as Error).message,
            });
            await captureScreenshot(page, settings.storage.logsDir, `assign-${job.id}-${lang.code}`);
          }
        }
        if (failed.length === 0 && Object.keys(assigned).length > 0) {
          state.markProcessed(job.id, assigned);
        } else if (Object.keys(assigned).length > 0) {
          state.markPartial(job.id, assigned, failed);
        }
        await state.save();
      } catch (err) {
        logger.error('job processing error', { jobId: job.id, error: (err as Error).message });
        await captureScreenshot(page, settings.storage.logsDir, `job-${job.id}`);
      }
    }
    logger.info('tick complete');
  };

  const scheduler = new Scheduler(
    { intervalMinutes: settings.polling.intervalMinutes, jitterSeconds: settings.polling.jitterSeconds },
    tick,
    logger
  );

  const shutdown = async (): Promise<void> => {
    scheduler.stop('shutdown');
    await session.close();
    await state.save();
    await lock.release();
    logger.info('shutdown complete');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  scheduler.start();
}

main().catch((err) => {
  console.error('fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 15.2: Verify compile**

```powershell
npm run build
```

Expected: `dist/` populated, exit 0.

- [ ] **Step 15.3: Commit**

```powershell
git add src/index.ts
git commit -m "feat: add entry point wiring all components"
```

---

## Task 16: Bootstrap Files (settings.yml, translators.yml, .env, dirs)

**Files:**
- Create: `config/settings.yml` (gitignored — copy from example)
- Create: `config/translators.yml` (gitignored — copy from example)
- Create: `.env` (gitignored)
- Create: `data/` directory (gitignored)
- Create: `logs/` directory (gitignored)

- [ ] **Step 16.1: Copy templates and create runtime dirs**

```powershell
Copy-Item config\settings.example.yml config\settings.yml
Copy-Item config\translators.example.yml config\translators.yml
Copy-Item .env.example .env
New-Item -ItemType Directory -Force data, logs | Out-Null
```

- [ ] **Step 16.2: Verify files exist and are gitignored**

```powershell
git status --short
```

Expected: no listing of `config/settings.yml`, `config/translators.yml`, `.env`, `data/`, `logs/` (all gitignored).

- [ ] **Step 16.3: Verify dry-run startup (no real assigns)**

Edit `config/settings.yml` and set `assignment.dryRun: true`, `browser.headless: false` for first run.

```powershell
npm run dev
```

Expected:
- Logs show: `process lock acquired`, `no existing cookies; will login fresh`, `login successful; cookies saved`, `tick started`, `job scan complete`
- Browser window opens, logs in, navigates Job Board
- If no `lo-LA` / `km-KH` jobs present, scan returns 0 candidates
- If candidates exist, logs show `[DRY-RUN] would click Assign ...` per language
- No git changes to commit (all generated files gitignored)

If login selectors fail, proceed to Task 18 (codegen) to adjust.

---

## Task 17: Smoke Test Script

**Files:**
- Create: `scripts/smoke.ts`

- [ ] **Step 17.1: Write smoke script**

```typescript
import 'dotenv/config';
import { chromium } from 'playwright-extra';
// @ts-expect-error
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

async function main(): Promise<void> {
  const username = process.env.TMS_USERNAME;
  const password = process.env.TMS_PASSWORD;
  if (!username || !password) throw new Error('Missing TMS credentials');

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  await page.goto('https://www.translationtms.com/login');
  await page.fill('input[type="email"], input[name="email"]', username);
  await page.fill('input[type="password"]', password);
  await Promise.all([
    page.waitForURL(/job-board|dashboard/i, { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
  console.log('SMOKE OK — logged in, landed at:', page.url());
  await browser.close();
}

main().catch((err) => {
  console.error('SMOKE FAIL:', err);
  process.exit(1);
});
```

- [ ] **Step 17.2: Add npm script**

Edit `package.json` to add inside `scripts`:
```json
"smoke": "tsx scripts/smoke.ts"
```

- [ ] **Step 17.3: Run smoke test**

```powershell
npm run smoke
```

Expected: log `SMOKE OK — logged in, landed at: https://www.translationtms.com/...`.

- [ ] **Step 17.4: Commit**

```powershell
git add scripts/smoke.ts package.json
git commit -m "feat(scripts): add login smoke test"
```

---

## Task 18: Codegen Verification (selector reality check)

This task verifies the placeholder selectors in Tasks 10–13 against the real site. Run codegen and adjust if needed.

- [ ] **Step 18.1: Launch Playwright codegen**

```powershell
npx playwright codegen https://www.translationtms.com/login
```

In the recorder window, perform the full real workflow:
1. Login with credentials
2. Go to Job Board, set filter to `Available to Claim`
3. Click `Open` on a job with `lo-LA` / `km-KH`
4. Click `Assign` on the lo-LA row
5. In modal, click `Assign` next to one translator
6. Close codegen — note the generated selectors

- [ ] **Step 18.2: Compare generated selectors to current code**

For each of these selectors in the codebase, confirm they match what codegen produced; if not, edit the file:

| File | Selector to verify |
|------|--------------------|
| `src/auth/session.ts` | Email/password inputs + submit button |
| `src/scraper/job-scanner.ts` | Job Board table rows + cell indices + language tags |
| `src/scraper/job-processor.ts` | Word Count locator + Waiting tab + language row cells |
| `src/assignment/assigner.ts` | Row Assign button + modal locator + per-translator Assign button |

Make any adjustments inline (use Edit tool).

- [ ] **Step 18.3: Re-run dev to verify**

```powershell
npm run dev
```

Expected: tick completes without selector errors; with `dryRun: true`, see `[DRY-RUN] would click Assign` for any pending lo-LA/km-KH jobs.

- [ ] **Step 18.4: Commit any selector adjustments**

```powershell
git add src/auth/session.ts src/scraper/job-scanner.ts src/scraper/job-processor.ts src/assignment/assigner.ts
git commit -m "fix(selectors): adjust selectors based on codegen verification"
```

(If no changes, skip the commit.)

---

## Task 19: End-to-End Real Run (dry-run → live)

- [ ] **Step 19.1: Confirm `config/settings.yml` `assignment.dryRun: true`, observe a full tick**

```powershell
npm run dev
```

Read logs in `logs/app-YYYY-MM-DD.log` (JSON lines). For each candidate job, confirm:
- `job scan complete` with sensible `candidateIds`
- `job detail parsed` showing correct `wordCount` and `languages`
- `[DRY-RUN] would click Assign` with expected translator email per the YAML mapping

- [ ] **Step 19.2: Flip to live**

Edit `config/settings.yml` → set `assignment.dryRun: false`. Restart.

```powershell
npm run dev
```

Watch one tick:
- Verify a real Assign occurs on a low-stakes test job (or wait for next genuine new job)
- Verify `state.json` updates with `status: "FULL"` and the assigned translator
- Verify the same job is not re-processed on next tick

- [ ] **Step 19.3: Verify behavior on partial failure (manual)**

Temporarily remove one translator email from `config/translators.yml` (e.g., set `km-KH` rules to an email not present in the popup), restart, and confirm:
- One language assigns successfully (e.g., lo-LA)
- Other language logs `TranslatorNotFoundError`, captures screenshot in `logs/screenshots/`
- State file marks job as `PARTIAL`
- On next tick, only the failed language is retried

Restore `translators.yml` after verification.

- [ ] **Step 19.4: No commit needed** (all data files gitignored)

---

## Task 20: Dockerfile + docker-compose

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`

- [ ] **Step 20.1: Write `Dockerfile`**

```dockerfile
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save typescript tsx

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
```

- [ ] **Step 20.2: Write `docker-compose.yml`**

```yaml
services:
  tms-bot:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./config:/app/config:ro
      - ./data:/app/data
      - ./logs:/app/logs
```

- [ ] **Step 20.3: Write `.dockerignore`**

```
node_modules
dist
.env
data
logs
playwright-report
test-results
.git
```

- [ ] **Step 20.4: Test build**

```powershell
docker build -t tms-bot:dev .
```

Expected: image builds without errors.

- [ ] **Step 20.5: Commit**

```powershell
git add Dockerfile docker-compose.yml .dockerignore
git commit -m "chore(deploy): add Dockerfile + docker-compose"
```

---

## Task 21: Windows Service Script

**Files:**
- Create: `scripts/install-windows-service.js`

- [ ] **Step 21.1: Install `node-windows` as devDependency**

```powershell
npm install --save-dev node-windows
```

- [ ] **Step 21.2: Write installer script**

```javascript
const { Service } = require('node-windows');
const path = require('path');

const svc = new Service({
  name: 'BinanceTranslationBot',
  description: 'Auto-assign bot for translationtms.com (lo-LA / km-KH)',
  script: path.resolve(__dirname, '..', 'dist', 'index.js'),
  nodeOptions: ['--enable-source-maps'],
  workingDirectory: path.resolve(__dirname, '..'),
});

svc.on('install', () => {
  console.log('Service installed. Starting...');
  svc.start();
});

svc.on('start', () => console.log('Service started.'));
svc.on('error', (err) => console.error('Service error:', err));

const action = process.argv[2];
if (action === 'install') svc.install();
else if (action === 'uninstall') svc.uninstall();
else {
  console.error('Usage: node scripts/install-windows-service.js [install|uninstall]');
  process.exit(1);
}
```

- [ ] **Step 21.3: Add npm scripts**

Add inside `package.json` `scripts`:
```json
"service:install": "npm run build && node scripts/install-windows-service.js install",
"service:uninstall": "node scripts/install-windows-service.js uninstall"
```

- [ ] **Step 21.4: (Optional) Verify install on the host workstation**

> **Note:** Requires Admin PowerShell.

```powershell
npm run service:install
Get-Service BinanceTranslationBot
```

Expected: service running. Uninstall later with `npm run service:uninstall`.

- [ ] **Step 21.5: Commit**

```powershell
git add scripts/install-windows-service.js package.json package-lock.json
git commit -m "chore(deploy): add Windows service install script"
```

---

## Task 22: README

**Files:**
- Create: `README.md`

- [ ] **Step 22.1: Write README**

```markdown
# Translation TMS Auto-Assign Bot

Auto-assign bot สำหรับ [translationtms.com](https://www.translationtms.com) — polling งานภาษา `lo-LA` / `km-KH` แล้ว assign translator อัตโนมัติตาม word-count mapping

## Setup

```powershell
npm install
npx playwright install chromium
Copy-Item config\settings.example.yml config\settings.yml
Copy-Item config\translators.example.yml config\translators.yml
Copy-Item .env.example .env
# แก้ .env ใส่ credential จริง
# แก้ config/translators.yml ใส่ mapping จริง
```

## Run

```powershell
# Development (visible browser, watch mode)
npm run dev

# Production (build + run)
npm run build
npm start

# Smoke test (login only)
npm run smoke
```

## Configuration

- `config/settings.yml` — runtime settings (polling interval, browser, paths)
- `config/translators.yml` — word-count → translator mapping
- `.env` — `TMS_USERNAME` / `TMS_PASSWORD`

### Dry-Run

Set `assignment.dryRun: true` in `config/settings.yml` to test without actually clicking Assign.

## Deploy

### Windows Service

```powershell
# Admin PowerShell
npm run service:install
Get-Service BinanceTranslationBot
```

Uninstall: `npm run service:uninstall`

### Docker

```powershell
docker-compose up -d
docker-compose logs -f
```

## Logs

- `logs/app-YYYY-MM-DD.log` — structured JSON logs
- `logs/error-YYYY-MM-DD.log` — errors only
- `logs/screenshots/YYYY-MM-DD/` — error screenshots

## Tests

```powershell
npm test                    # unit tests (vitest)
npm run test:integration    # integration tests (Playwright)
```

## Spec & Plan

- Spec: `docs/superpowers/specs/2026-05-20-translation-tms-auto-assign-bot-design.md`
- Plan: `docs/superpowers/plans/2026-05-20-translation-tms-auto-assign-bot.md`
```

- [ ] **Step 22.2: Commit**

```powershell
git add README.md
git commit -m "docs: add README with setup, run, deploy instructions"
```

---

## Final Verification

- [ ] **Step F.1: Full typecheck + tests**

```powershell
npm run typecheck
npm test
npm run build
```

Expected: all green.

- [ ] **Step F.2: Manual end-to-end (24-hour soak)**

Let the bot run continuously for 24 hours with `dryRun: false` on the real account. After 24 hours:
- Check `logs/app-*.log` — no unhandled errors
- Check `data/state.json` — `processedJobs` populated correctly
- Verify in the TMS UI that the bot's assignments appear as expected and were not duplicated

- [ ] **Step F.3: Final commit (if any cleanup)**

```powershell
git status
git log --oneline -25
```

Confirm clean state and complete commit history.

---

## Acceptance Criteria

A successful Phase 1 implementation satisfies all of these:

1. **Login & session** — Bot logs in, persists cookies, and reuses them across restarts
2. **Filter** — Only `lo-LA` / `km-KH` jobs are considered; other languages ignored
3. **Selection** — Translator chosen matches `config/translators.yml` rules + round-robin counter
4. **Assignment** — Real assignments visible in TMS UI after a real (non-dry-run) tick
5. **Idempotent** — Same job not re-assigned (status `FULL`); `PARTIAL` retries only failed languages
6. **Single instance** — Second process fails with `LockHeldError`
7. **Resilient** — Selector failures produce screenshots in `logs/screenshots/` without crashing the scheduler
8. **Configurable** — Changing `translators.yml` + restart updates behavior without code changes
9. **Deployable** — Both `npm start` (Local Windows) and `docker-compose up` (Docker) run the bot
10. **Logs** — JSON-structured logs in `logs/app-*.log` for future dashboard ingestion (Phase 2 readiness)

---

## Deferred (out of scope for this plan)

The spec §8 lists **integration tests with mocked HTML fixtures**. These are intentionally **not** in Phase 1 because:
1. They are brittle (TMS UI markup churns) and would require constant fixture refresh
2. Their failure modes overlap heavily with Task 18 codegen verification + Task 19 dry-run + Step F.2 24-hour soak
3. Effort is better spent on Phase 2 (Dashboard Tracking) where structured logs become the verification surface

If integration tests become valuable later (e.g., during Phase 2 refactor), add them as a new follow-up plan.

---

## Notes for Implementer

- **Frequent commits:** every task includes a commit; do not batch multiple tasks into a single commit
- **Selectors are best-guess** until Task 18 codegen verification; adjust as needed
- **Real credentials** are in `.env` — never commit them
- **Dry-run first:** flip to live only after the dry-run logs look correct
- **24-hour soak (Step F.2)** is part of acceptance — do not skip
- **Phase 2 readiness:** keep logs structured (JSON), keep `StateStore` interface clean (do not couple to filesystem) — eases future swap to DB-backed storage when Dashboard is built
