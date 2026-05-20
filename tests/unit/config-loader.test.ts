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
