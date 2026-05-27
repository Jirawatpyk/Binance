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
  scan: { lookbackHours: number; maxCandidatesPerTick: number; detailPageDelayMs: number; processedJobRetainHours: number };
  browser: { headless: boolean; viewport: { width: number; height: number }; navigationTimeoutMs: number };
  storage: { statePath: string; logsDir: string; cookiesPath: string };
  assignment: { dryRun: boolean; maxRetries: number; retryDelayMs: number };
  logging: { level: 'debug' | 'info' | 'warn' | 'error'; rotateDays: number; screenshotRetainDays: number };
  reliability: {
    watchdog: { tickTimeoutMs: number };
    reauth: { alertOnExpiry: boolean };
    monitoring: { dailySummaryTime: string; consecutiveErrorAlert: number };
  };
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

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ['lo-LA', 'km-KH'] as const;
