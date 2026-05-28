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
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
`);
    const s = loadSettings(p);
    expect(s.polling.intervalMinutes).toBe(5);
    expect(s.scan.lookbackHours).toBe(48);
    expect(s.scan.maxCandidatesPerTick).toBe(25);
    expect(s.logging.level).toBe('info');
    expect(s.reliability.watchdog.tickTimeoutMs).toBe(600000);
    expect(s.reliability.monitoring.dailySummaryTime).toBe('09:00');
    expect(s.scan.detailPageDelayMs).toBe(1500);
    expect(s.scan.processedJobRetainHours).toBe(96);
    expect(s.logging.screenshotRetainDays).toBe(7);
    expect(s.assignment.maxPartialRetries).toBe(5);
    expect(s.reliability.browserRecycleHours).toBe(24);
  });

  it('throws on invalid level', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: x, logsDir: y, cookiesPath: z }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: WRONG, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
`);
    expect(() => loadSettings(p)).toThrow();
  });

  it('rejects when processedJobRetainHours < lookbackHours', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 24, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
`);
    expect(() => loadSettings(p)).toThrow();
  });

  it('parses an optional sheets block', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
sheets: { enabled: true, spreadsheetId: "SID", credentialsPath: ./google-credentials.json, tabs: { lo-LA: "Lao Assign", km-KH: "Khmer Assign" } }
`);
    const s = loadSettings(p);
    expect(s.sheets?.enabled).toBe(true);
    expect(s.sheets?.spreadsheetId).toBe('SID');
    expect(s.sheets?.tabs['km-KH']).toBe('Khmer Assign');
  });

  it('loads fine when the sheets block is omitted', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
`);
    const s = loadSettings(p);
    expect(s.sheets).toBeUndefined();
  });

  it('rejects a sheets block that is present but missing required fields', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
sheets: { enabled: true, spreadsheetId: "SID", credentialsPath: ./google-credentials.json }
`);
    expect(() => loadSettings(p)).toThrow(); // tabs missing
  });

  it('rejects a sheets block whose two languages map to the same tab', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
sheets: { enabled: true, spreadsheetId: "SID", credentialsPath: ./google-credentials.json, tabs: { lo-LA: "Same Tab", km-KH: "Same Tab" } }
`);
    expect(() => loadSettings(p)).toThrow();
  });

  it('parses an optional review block', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
review: { enabled: true, reviewers: { lo-LA: "LO_T2@eqho.com" } }
`);
    const s = loadSettings(p);
    expect(s.review?.enabled).toBe(true);
    expect(s.review?.reviewers['lo-LA']).toBe('LO_T2@eqho.com');
  });

  it('loads fine when the review block is omitted', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
`);
    expect(loadSettings(p).review).toBeUndefined();
  });

  it('rejects a review reviewer that is not a valid email', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
review: { enabled: true, reviewers: { lo-LA: "not-an-email" } }
`);
    expect(() => loadSettings(p)).toThrow();
  });

  it('rejects a typo\'d reviewer language key (strict)', () => {
    const p = makeTmp('s.yml', `
polling: { intervalMinutes: 5, jitterSeconds: 30 }
scan: { lookbackHours: 48, maxCandidatesPerTick: 25, detailPageDelayMs: 1500, processedJobRetainHours: 96, fullRecheckCooldownMinutes: 30 }
browser: { headless: true, viewport: { width: 1920, height: 1080 }, navigationTimeoutMs: 30000 }
storage: { statePath: ./d/s.json, logsDir: ./l, cookiesPath: ./d/c.json }
assignment: { dryRun: false, maxRetries: 3, retryDelayMs: 5000, maxPartialRetries: 5 }
logging: { level: info, rotateDays: 14, screenshotRetainDays: 7, screenshotMaxPerDay: 200 }
reliability: { watchdog: { tickTimeoutMs: 600000 }, reauth: { alertOnExpiry: true }, monitoring: { dailySummaryTime: "09:00", consecutiveErrorAlert: 3 }, browserRecycleHours: 24, consecutiveZeroScanAlert: 5 }
review: { enabled: true, reviewers: { lo_LA: "LO_T2@eqho.com" } }
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

  it('rejects a language whose last rule is not the null catch-all', () => {
    const p = makeTmp('t.yml', `
lo-LA:
  rules:
    - maxWords: 500
      translators: [a@eqho.com]
`);
    expect(() => loadTranslators(p)).toThrow();
  });

  it('rejects an empty translators config (no language mapped)', () => {
    const p = makeTmp('t.yml', `{}`);
    expect(() => loadTranslators(p)).toThrow();
  });

  it('rejects an unknown/typo\'d language key', () => {
    const p = makeTmp('t.yml', `
lo_LA:
  rules:
    - maxWords: null
      translators: [a@eqho.com]
`);
    expect(() => loadTranslators(p)).toThrow();
  });

  it('rejects rules whose maxWords are not strictly ascending', () => {
    const p = makeTmp('t.yml', `
lo-LA:
  rules:
    - maxWords: 5000
      translators: [a@eqho.com]
    - maxWords: 1000
      translators: [b@eqho.com]
    - maxWords: null
      translators: [c@eqho.com]
`);
    expect(() => loadTranslators(p)).toThrow();
  });

  it('accepts a single-language config with ascending tiers', () => {
    const p = makeTmp('t.yml', `
km-KH:
  rules:
    - maxWords: 1000
      translators: [a@eqho.com]
    - maxWords: 5000
      translators: [b@eqho.com]
    - maxWords: null
      translators: [c@eqho.com]
`);
    const t = loadTranslators(p);
    expect(t['km-KH']?.rules.length).toBe(3);
    expect(t['lo-LA']).toBeUndefined();
  });
});
