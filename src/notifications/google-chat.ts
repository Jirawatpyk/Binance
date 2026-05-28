import type winston from 'winston';
import type { DailySummaryStats } from '../types/index.js';
import { formatUtcMinute as fmtUtc } from '../core/time.js';

export type Severity = 'info' | 'warn' | 'error';

/** One assigned job for the per-cycle summary card. */
export interface AssignmentSummaryItem {
  jobId: string;
  name: string;
  wordCount: number;
  assigned: Record<string, string>; // language code -> translator email
  dueDate?: Date | null; // job due date (rendered in UTC); omitted when unknown
}

/** One job's reviewer assignments for the per-cycle review summary card. */
export interface ReviewSummaryItem {
  jobId: string;
  name: string;
  reviewed: Record<string, string>; // language code -> reviewer email
}

function emojiFor(severity: Severity): string {
  return severity === 'error' ? '🚨' : severity === 'warn' ? '⚠️' : 'ℹ️';
}

/** Escape the characters that are special in Google Chat's HTML-subset text.
 *  Quotes are escaped too so a value stays safe if ever placed in an attribute. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "user@eqho.com" → "user" — the short translator handle shown beside the email. */
function translatorHandle(email: string): string {
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

/**
 * Pick a font colour for a due date by urgency: red when overdue or due within
 * 24h, amber within 3 days, grey when there's plenty of time (or unknown).
 */
export function dueColor(d?: Date | null, now: Date = new Date()): string {
  if (!d || Number.isNaN(d.getTime())) return '#888888';
  const hoursLeft = (d.getTime() - now.getTime()) / 3_600_000;
  if (hoursLeft <= 24) return '#d93025'; // overdue or < 1 day — urgent
  if (hoursLeft <= 72) return '#e8710a'; // < 3 days — soon
  return '#888888'; // plenty of time
}

/** Format a due date as "Due YYYY-MM-DD HH:mm UTC" (prefixed "OVERDUE — " when
 *  the deadline has already passed), or null when unknown/invalid. */
function formatDueUtc(d?: Date | null, now: Date = new Date()): string | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  const overdue = d.getTime() < now.getTime();
  return `${overdue ? 'OVERDUE — ' : ''}Due ${fmtUtc(d)}`;
}

/** A simple one-paragraph card for lifecycle/alert messages. */
export function buildTextCard(text: string, severity: Severity): unknown {
  return {
    cardsV2: [
      {
        cardId: `tms-${Date.now()}`,
        card: {
          header: { title: `${emojiFor(severity)} TMS Bot`, subtitle: severity.toUpperCase() },
          sections: [{ widgets: [{ textParagraph: { text: esc(text) } }] }],
        },
      },
    ],
  };
}

/**
 * A single card summarising every job assigned in one polling cycle (anti-spam:
 * one card per tick, not one per job/language). Each job renders as a
 * `decoratedText` row — a document icon, a grey meta line (id + word count),
 * the job name in bold, and one flag-prefixed language → translator line each —
 * with a divider between jobs so the list stays scannable.
 */
export function buildAssignmentSummaryCard(jobs: AssignmentSummaryItem[]): unknown {
  const totalAssignments = jobs.reduce((n, j) => n + Object.keys(j.assigned).length, 0);
  const totalWords = jobs.reduce((n, j) => n + j.wordCount, 0);

  const widgets: unknown[] = [];
  jobs.forEach((j, i) => {
    if (i > 0) widgets.push({ divider: {} });
    const langs = Object.entries(j.assigned)
      .map(
        ([lang, tr]) =>
          `• <b>${esc(lang)}</b> → ${esc(translatorHandle(tr))} <font color="#888888">(${esc(tr)})</font>`
      )
      .join('<br>');
    const due = formatDueUtc(j.dueDate);
    // Order: job name, then the deadline (coloured by urgency), then the
    // language → translator lines — "what it is, when it's due, who's on it".
    const dueLine = due ? `<font color="${dueColor(j.dueDate)}">⏰ ${due}</font><br>` : '';
    widgets.push({
      decoratedText: {
        startIcon: { knownIcon: 'DESCRIPTION' },
        topLabel: `Job ${esc(j.jobId)}  ·  ${j.wordCount.toLocaleString('en-US')} words`,
        text: `<b>${esc(j.name)}</b><br>${dueLine}${langs}`,
        wrapText: true,
      },
    });
  });

  const plural = jobs.length === 1 ? '' : 's';
  return {
    cardsV2: [
      {
        cardId: `assign-${Date.now()}`,
        card: {
          header: {
            title: `✅ Assigned ${jobs.length} job${plural}`,
            subtitle: `${totalAssignments} assignment${totalAssignments === 1 ? '' : 's'}  ·  ${totalWords.toLocaleString('en-US')} words`,
          },
          sections: [{ widgets }],
        },
      },
    ],
  };
}

/**
 * A single card summarising every reviewer assigned in one polling cycle — one
 * `decoratedText` row per job (job id + name, then `lang → reviewer` lines),
 * dividers between jobs. Mirrors buildAssignmentSummaryCard but for reviewers.
 */
export function buildReviewSummaryCard(items: ReviewSummaryItem[]): unknown {
  const widgets: unknown[] = [];
  items.forEach((j, i) => {
    if (i > 0) widgets.push({ divider: {} });
    const langs = Object.entries(j.reviewed)
      .map(([lang, reviewer]) => `• <b>${esc(lang)}</b> → ${esc(reviewer)}`)
      .join('<br>');
    widgets.push({
      decoratedText: {
        startIcon: { knownIcon: 'PERSON' },
        topLabel: `Job ${esc(j.jobId)}`,
        text: `<b>${esc(j.name)}</b><br>${langs}`,
        wrapText: true,
      },
    });
  });
  const plural = items.length === 1 ? '' : 's';
  return {
    cardsV2: [
      {
        cardId: `review-${Date.now()}`,
        card: {
          header: { title: `🔍 Reviewer assigned — ${items.length} job${plural}` },
          sections: [{ widgets }],
        },
      },
    ],
  };
}

/** Format an ISO timestamp as "YYYY-MM-DD HH:mm UTC", or "—" when null/invalid. */
function utcStamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : fmtUtc(d);
}

/**
 * The daily heartbeat as a full, grouped card: a `📊 Daily Summary` header
 * (date + uptime), an "Assignments" section (totals + per-language breakdown)
 * and a "Health" section (uptime/polls, issues, last activity). Failure and
 * error-streak counts turn red when non-zero so problems stand out at a glance.
 */
export function buildDailySummaryCard(s: DailySummaryStats): unknown {
  const lo = s.byLang['lo-LA'] ?? 0;
  const km = s.byLang['km-KH'] ?? 0;

  const issues = [
    s.failed > 0 ? `<font color="#d93025"><b>${s.failed}</b> failed</font>` : '<b>0</b> failed',
    `<b>${s.authEpisodes}</b> auth`,
    s.consecutiveErrors > 0
      ? `<font color="#d93025"><b>${s.consecutiveErrors}</b> err streak</font>`
      : null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  const assignmentsWidgets = [
    {
      decoratedText: {
        startIcon: { knownIcon: 'MULTIPLE_PEOPLE' },
        topLabel: 'Assigned today',
        text:
          s.assigned === 0
            ? '<b>No assignments yet today</b>'
            : `<b>${s.assigned}</b> language(s) across <b>${s.jobsAssigned}</b> job(s)`,
        wrapText: true,
      },
    },
    {
      decoratedText: {
        startIcon: { knownIcon: 'BOOKMARK' },
        topLabel: 'By language',
        text: `lo-LA <b>${lo}</b>   ·   km-KH <b>${km}</b>`,
        wrapText: true,
      },
    },
    {
      decoratedText: {
        startIcon: { knownIcon: 'PERSON' },
        topLabel: 'Reviews assigned',
        text:
          s.reviewed === 0
            ? '<b>No reviewers assigned today</b>'
            : `<b>${s.reviewed}</b> reviewer assignment(s)`,
        wrapText: true,
      },
    },
  ];

  const healthWidgets = [
    {
      decoratedText: {
        startIcon: { knownIcon: 'CLOCK' },
        topLabel: 'Uptime · polls',
        text: `<b>${s.uptimeHours}h</b>   ·   <b>${s.ticks}</b> polls`,
        wrapText: true,
      },
    },
    {
      decoratedText: {
        startIcon: { knownIcon: 'DESCRIPTION' },
        topLabel: 'Issues',
        text: issues,
        wrapText: true,
      },
    },
    {
      decoratedText: {
        startIcon: { knownIcon: 'STAR' },
        topLabel: 'Last assignment',
        text: utcStamp(s.lastAssignmentAt),
        bottomLabel: `Last successful poll: ${utcStamp(s.lastSuccessAt)}`,
        wrapText: true,
      },
    },
  ];

  return {
    cardsV2: [
      {
        cardId: `summary-${Date.now()}`,
        card: {
          header: { title: '📊 Daily Summary', subtitle: `${esc(s.date)}  ·  uptime ${s.uptimeHours}h` },
          sections: [
            { header: 'Assignments', widgets: assignmentsWidgets },
            { header: 'Health', widgets: healthWidgets },
          ],
        },
      },
    ],
  };
}

// Escalate to an error-level log once delivery has failed this many times in a
// row. The chat channel itself may be the thing that's down, so the error log
// (a separate sink) is the signal that "alerting is broken" — otherwise every
// alert, including critical ones, would fail silently behind a warn.
const NOTIFY_FAILURE_ALERT_THRESHOLD = 3;

export class GoogleChatNotifier {
  private consecutiveFailures = 0;

  constructor(
    private webhookUrl: string | undefined,
    private logger: winston.Logger
  ) {}

  /** Fire-and-forget lifecycle/alert message as a Google Chat card. Never throws. */
  async notify(text: string, severity: Severity = 'info'): Promise<void> {
    await this.post(buildTextCard(text, severity), severity);
  }

  /** Fire-and-forget per-cycle assignment summary card. No-op when the list is empty. */
  async notifyAssignments(jobs: AssignmentSummaryItem[]): Promise<void> {
    if (jobs.length === 0) return;
    await this.post(buildAssignmentSummaryCard(jobs), 'info');
  }

  /** Fire-and-forget per-cycle reviewer-assignment summary. No-op when empty. */
  async notifyReviews(items: ReviewSummaryItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.post(buildReviewSummaryCard(items), 'info');
  }

  /** Fire-and-forget daily heartbeat summary card. Never throws. */
  async notifyDailySummary(stats: DailySummaryStats): Promise<void> {
    await this.post(buildDailySummaryCard(stats), 'info');
  }

  private async post(payload: unknown, severity: Severity): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        this.consecutiveFailures = 0;
        return;
      }
      this.recordFailure(severity, `non-2xx ${res.status}`);
    } catch (err) {
      this.recordFailure(severity, (err as Error).message);
    }
  }

  /** Track delivery failures and escalate a sustained outage to error level —
   *  a broken webhook otherwise hides every alert behind a warn line. */
  private recordFailure(severity: Severity, reason: string): void {
    this.consecutiveFailures += 1;
    const meta = { reason, severity, consecutiveFailures: this.consecutiveFailures };
    if (this.consecutiveFailures >= NOTIFY_FAILURE_ALERT_THRESHOLD) {
      this.logger.error('Google Chat delivery failing repeatedly — alerts may not be reaching anyone', meta);
    } else {
      this.logger.warn('Google Chat notification failed', meta);
    }
  }
}
