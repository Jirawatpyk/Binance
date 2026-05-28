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
  scan: { lookbackHours: number; maxCandidatesPerTick: number; detailPageDelayMs: number; processedJobRetainHours: number; fullRecheckCooldownMinutes: number };
  browser: { headless: boolean; viewport: { width: number; height: number }; navigationTimeoutMs: number };
  storage: { statePath: string; logsDir: string; cookiesPath: string };
  assignment: { dryRun: boolean; maxRetries: number; retryDelayMs: number; maxPartialRetries: number };
  logging: { level: 'debug' | 'info' | 'warn' | 'error'; rotateDays: number; screenshotRetainDays: number; screenshotMaxPerDay: number };
  reliability: {
    watchdog: { tickTimeoutMs: number };
    reauth: { alertOnExpiry: boolean };
    monitoring: { dailySummaryTime: string; consecutiveErrorAlert: number };
    browserRecycleHours: number;
    consecutiveZeroScanAlert: number;
  };
  sheets?: {
    enabled: boolean;
    spreadsheetId: string;
    credentialsPath: string;
    tabs: Record<SupportedLanguage, string>;
  };
}

export type ProcessStatus = 'FULL' | 'PARTIAL' | 'ABANDONED';

export interface ProcessedJobEntry {
  processedAt: string;
  status: ProcessStatus;
  assigned: Partial<Record<SupportedLanguage, string>>;
  failed?: SupportedLanguage[];
  retryCount?: number;
  // FULL jobs that re-opened to nothing assignable (e.g. all rows in
  // WAITING_REVIEW) are skipped until this time, to avoid re-opening a
  // board-listed-but-not-claimable job every tick.
  recheckAfter?: string;
}

export interface State {
  processedJobs: Record<string, ProcessedJobEntry>;
  roundRobinCounters: Record<string, number>;
}

/** Structured daily-heartbeat figures, used to render the summary card. */
export interface DailySummaryStats {
  date: string;
  assigned: number; // language-level assignments today
  jobsAssigned: number; // jobs that received at least one assignment today
  byLang: Record<SupportedLanguage, number>; // assignments split per language today
  failed: number;
  authEpisodes: number;
  ticks: number; // polling cycles run today
  uptimeHours: number;
  lastAssignmentAt: string | null; // ISO; last successful assignment (any day)
  lastSuccessAt: string | null; // ISO; last successful tick
  consecutiveErrors: number; // current consecutive-error streak (0 = healthy)
}

export interface AssignmentResult {
  language: SupportedLanguage;
  success: boolean;
  translator?: string;
  error?: string;
}

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ['lo-LA', 'km-KH'] as const;
