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
  scan: z.object({
    lookbackHours: z.number().positive(),
    maxCandidatesPerTick: z.number().int().positive(),
    detailPageDelayMs: z.number().int().nonnegative(),
    processedJobRetainHours: z.number().positive(),
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
    screenshotRetainDays: z.number().int().positive(),
  }),
  reliability: z.object({
    watchdog: z.object({ tickTimeoutMs: z.number().int().positive() }),
    reauth: z.object({ alertOnExpiry: z.boolean() }),
    monitoring: z.object({
      dailySummaryTime: z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:mm'),
      consecutiveErrorAlert: z.number().int().positive(),
    }),
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
