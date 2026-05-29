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
    // Defaulted so a settings.yml written before this field was added still
    // loads (a missing required field would crash startup in a restart loop).
    fullRecheckCooldownMinutes: z.number().int().nonnegative().default(30),
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
    maxPartialRetries: z.number().int().positive(),
  }),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']),
    rotateDays: z.number().positive(),
    screenshotRetainDays: z.number().int().positive(),
    screenshotMaxPerDay: z.number().int().positive(),
  }),
  reliability: z.object({
    watchdog: z.object({ tickTimeoutMs: z.number().int().positive() }),
    reauth: z.object({
      alertOnExpiry: z.boolean(),
      // Auto-renew the TMS access token via the stored refresh_token instead of
      // pausing for a manual capture-cookies. Defaulted so an existing
      // settings.yml still loads (and existing deployments get the feature).
      autoRenew: z.boolean().default(true),
      // Refresh proactively once the access token is within this many minutes of
      // expiry (the access token lives ~12h).
      refreshThresholdMin: z.number().int().positive().default(120),
    }),
    monitoring: z.object({
      dailySummaryTime: z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:mm'),
      consecutiveErrorAlert: z.number().int().positive(),
    }),
    browserRecycleHours: z.number().positive(),
    consecutiveZeroScanAlert: z.number().int().positive(),
  }),
  sheets: z
    .object({
      enabled: z.boolean(),
      spreadsheetId: z.string().min(1),
      credentialsPath: z.string().min(1),
      tabs: z
        .object({
          'lo-LA': z.string().min(1),
          'km-KH': z.string().min(1),
        })
        // The Sheet stores Job ID but not language, so dedup is per-tab; mapping
        // both languages to one tab would silently drop one language's rows.
        .refine((t) => t['lo-LA'] !== t['km-KH'], {
          message: 'sheets.tabs lo-LA and km-KH must be different tabs',
        }),
    })
    .optional(),
  review: z
    .object({
      enabled: z.boolean(),
      // The review scan uses a WIDER Created window than scan.lookbackHours so
      // jobs that reach WAITING_REVIEW days after creation are still found.
      // Defaulted so a settings.yml written before this field still loads.
      scanLookbackHours: z.number().positive().default(168),
      // Separate per-tick cap for review-pass detail opens (kept off the
      // translation cap so review work is never starved by a translation burst).
      maxCandidatesPerTick: z.number().int().positive().default(10),
      reviewers: z
        .object({
          'lo-LA': z.string().email().optional(),
          'km-KH': z.string().email().optional(),
        })
        // .strict() so a typo'd key (e.g. lo_LA) fails fast at load instead of
        // being silently stripped — which would leave that language un-reviewed.
        .strict(),
    })
    .optional(),
})
  .refine(
    (s) => s.scan.processedJobRetainHours >= s.scan.lookbackHours,
    { message: 'scan.processedJobRetainHours must be >= scan.lookbackHours' }
  )
  .refine(
    // The review pass exists to catch jobs that aged OUT of the translation
    // window, so its Created window must be wider — a narrower one would make the
    // pass redundant (or miss the very jobs it targets) silently.
    (s) => !s.review || s.review.scanLookbackHours >= s.scan.lookbackHours,
    { message: 'review.scanLookbackHours must be >= scan.lookbackHours (the review window must be wider than the translation window)' }
  );

const ruleSchema = z.object({
  maxWords: z.number().positive().nullable(),
  translators: z.array(z.string().email()).min(1),
});

const langConfigSchema = z
  .object({ rules: z.array(ruleSchema).min(1) })
  .refine((c) => c.rules[c.rules.length - 1].maxWords === null, {
    message: 'the last rule for a language must have maxWords: null (catch-all)',
  })
  .refine(
    (c) => {
      // pick() is first-match, so non-null maxWords must strictly ascend or a
      // later (smaller) tier becomes unreachable and small jobs match a big tier.
      const bounds = c.rules.filter((r) => r.maxWords !== null).map((r) => r.maxWords as number);
      return bounds.every((v, i) => i === 0 || v > bounds[i - 1]);
    },
    { message: 'rule maxWords must be in strictly ascending order' }
  );

const translatorsSchema = z
  .object({
    'lo-LA': langConfigSchema.optional(),
    'km-KH': langConfigSchema.optional(),
  })
  // .strict() rejects unknown/typo'd keys (e.g. lo_LA) instead of silently
  // ignoring them; the refine guarantees at least one real language is mapped,
  // so a misconfigured file fails fast at load instead of abandoning every job
  // of that language at runtime.
  .strict()
  .refine((c) => Boolean(c['lo-LA'] || c['km-KH']), {
    message: 'translators.yml must define at least one of lo-LA or km-KH',
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
