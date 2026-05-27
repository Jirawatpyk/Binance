import type winston from 'winston';

export type Severity = 'info' | 'warn' | 'error';

/** One assigned job for the per-cycle summary card. */
export interface AssignmentSummaryItem {
  jobId: string;
  name: string;
  wordCount: number;
  assigned: Record<string, string>; // language code -> translator email
}

function emojiFor(severity: Severity): string {
  return severity === 'error' ? '🚨' : severity === 'warn' ? '⚠️' : 'ℹ️';
}

/** Escape the few characters that are special in Google Chat's HTML-subset text. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
 * one card per tick, not one per job/language). Each job shows its id, name,
 * word count, and the language → translator assignments.
 */
export function buildAssignmentSummaryCard(jobs: AssignmentSummaryItem[]): unknown {
  const widgets = jobs.map((j) => {
    const langs = Object.entries(j.assigned)
      .map(([lang, tr]) => `&nbsp;&nbsp;${esc(lang)} → ${esc(tr)}`)
      .join('<br>');
    return {
      textParagraph: {
        text: `<b>Job ${esc(j.jobId)}</b> · ${j.wordCount} words<br>${esc(j.name)}<br>${langs}`,
      },
    };
  });
  return {
    cardsV2: [
      {
        cardId: `assign-${Date.now()}`,
        card: {
          header: { title: `✅ Assigned ${jobs.length} job(s) this cycle`, subtitle: 'TMS Bot' },
          sections: [{ widgets }],
        },
      },
    ],
  };
}

export class GoogleChatNotifier {
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

  private async post(payload: unknown, severity: Severity): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        this.logger.warn('Google Chat notification non-2xx', { status: res.status, severity });
      }
    } catch (err) {
      this.logger.warn('Google Chat notification error', { error: (err as Error).message, severity });
    }
  }
}
