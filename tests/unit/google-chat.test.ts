import { describe, it, expect } from 'vitest';
import { buildTextCard, buildAssignmentSummaryCard, buildDailySummaryCard } from '../../src/notifications/google-chat.js';

// Narrow helper to reach into the cardsV2 payload without `any` everywhere.
function card(payload: unknown): {
  cardId: string;
  card: {
    header: { title: string; subtitle: string };
    sections: Array<{
      widgets: Array<{
        textParagraph?: { text: string };
        decoratedText?: { topLabel?: string; bottomLabel?: string; text: string };
        divider?: object;
      }>;
    }>;
  };
} {
  return (payload as { cardsV2: unknown[] }).cardsV2[0] as never;
}

/** Concatenate all renderable text from a summary card's widgets. */
function allText(c: ReturnType<typeof card>): string {
  return c.card.sections[0].widgets
    .map((w) => `${w.decoratedText?.topLabel ?? ''} ${w.decoratedText?.text ?? ''} ${w.textParagraph?.text ?? ''}`)
    .join('\n');
}

describe('buildTextCard', () => {
  it('wraps text in a cardsV2 card with severity header', () => {
    const c = card(buildTextCard('hello world', 'info'));
    expect(c.card.header.title).toContain('TMS Bot');
    expect(c.card.header.subtitle).toBe('INFO');
    expect(c.card.sections[0].widgets[0].textParagraph?.text).toBe('hello world');
  });

  it('uses the error emoji and uppercases severity', () => {
    const c = card(buildTextCard('boom', 'error'));
    expect(c.card.header.title).toContain('🚨');
    expect(c.card.header.subtitle).toBe('ERROR');
  });

  it('escapes HTML-special characters', () => {
    const c = card(buildTextCard('a < b & c > d', 'warn'));
    expect(c.card.sections[0].widgets[0].textParagraph?.text).toBe('a &lt; b &amp; c &gt; d');
  });
});

describe('buildAssignmentSummaryCard', () => {
  it('summarises job count, assignment count, and total words in the header', () => {
    const c = card(
      buildAssignmentSummaryCard([
        { jobId: '111', name: 'Job One', wordCount: 34, assigned: { 'lo-LA': 'a@eqho.com' } },
        {
          jobId: '222',
          name: 'Job Two',
          wordCount: 7,
          assigned: { 'lo-LA': 'a@eqho.com', 'km-KH': 'b@eqho.com' },
        },
      ])
    );
    expect(c.card.header.title).toBe('✅ Assigned 2 jobs');
    // 1 + 2 language assignments; 34 + 7 words
    expect(c.card.header.subtitle).toBe('3 assignments  ·  41 words');
  });

  it('renders one decoratedText widget per job, separated by dividers', () => {
    const c = card(
      buildAssignmentSummaryCard([
        { jobId: '111', name: 'Job One', wordCount: 34, assigned: { 'lo-LA': 'a@eqho.com' } },
        { jobId: '222', name: 'Job Two', wordCount: 7, assigned: { 'km-KH': 'b@eqho.com' } },
      ])
    );
    const widgets = c.card.sections[0].widgets;
    const jobWidgets = widgets.filter((w) => w.decoratedText);
    const dividers = widgets.filter((w) => w.divider);
    expect(jobWidgets).toHaveLength(2);
    expect(dividers).toHaveLength(1); // divider only between jobs, not before the first
  });

  it('renders the due date as a UTC bottomLabel, and omits it when unknown', () => {
    const c = card(
      buildAssignmentSummaryCard([
        { jobId: '1', name: 'With due', wordCount: 10, assigned: { 'lo-LA': 'a@eqho.com' }, dueDate: new Date('2026-05-30T14:05:00Z') },
        { jobId: '2', name: 'No due', wordCount: 10, assigned: { 'km-KH': 'b@eqho.com' } },
      ])
    );
    const jobWidgets = c.card.sections[0].widgets.filter((w) => w.decoratedText);
    expect(jobWidgets[0].decoratedText?.bottomLabel).toBe('Due 2026-05-30 14:05 UTC');
    expect(jobWidgets[1].decoratedText?.bottomLabel).toBeUndefined();
  });

  it('singular header wording for a single job/assignment', () => {
    const c = card(
      buildAssignmentSummaryCard([
        { jobId: '999', name: 'Solo', wordCount: 1000, assigned: { 'lo-LA': 'a@eqho.com' } },
      ])
    );
    expect(c.card.header.title).toBe('✅ Assigned 1 job');
    expect(c.card.header.subtitle).toBe('1 assignment  ·  1,000 words');
  });

  it('includes job id, name, word count, flag, short handle, and full translator email', () => {
    const c = card(
      buildAssignmentSummaryCard([
        { jobId: '333', name: 'Finance App', wordCount: 12, assigned: { 'lo-LA': 'lo@eqho.com', 'km-KH': 'kh@eqho.com' } },
      ])
    );
    const text = allText(c);
    expect(text).toContain('Job 333');
    expect(text).toContain('Finance App');
    expect(text).toContain('12 words');
    // • <b>code</b> → handle (full email)
    expect(text).toContain('<b>lo-LA</b> → lo ');
    expect(text).toContain('(lo@eqho.com)');
    expect(text).toContain('<b>km-KH</b> → kh ');
    expect(text).toContain('(kh@eqho.com)');
  });

  it('escapes HTML-special characters in job id, name, and translator while keeping intentional markup', () => {
    const c = card(
      buildAssignmentSummaryCard([
        { jobId: 'J<1>', name: 'Finance & Loans <Test>', wordCount: 5, assigned: { 'lo-LA': 'user&hack@eqho.com' } },
      ])
    );
    const text = allText(c);
    expect(text).toContain('Job J&lt;1&gt;');
    expect(text).toContain('Finance &amp; Loans &lt;Test&gt;');
    expect(text).toContain('user&amp;hack@eqho.com');
    // intentional markup must survive (not escaped)
    expect(text).toContain('<b>');
    expect(text).toContain('<br>');
  });
});

describe('buildDailySummaryCard', () => {
  const stats = { date: '2026-05-27', assigned: 5, jobsAssigned: 3, failed: 0, authEpisodes: 1, uptimeHours: 12.3 };

  it('has the heartbeat header with date subtitle and three metric rows', () => {
    const c = card(buildDailySummaryCard(stats));
    expect(c.card.header.title).toBe('💓 Daily Summary');
    expect(c.card.header.subtitle).toBe('2026-05-27');
    expect(c.card.sections[0].widgets.filter((w) => w.decoratedText)).toHaveLength(3);
  });

  it('renders counts and uptime', () => {
    const text = allText(card(buildDailySummaryCard(stats)));
    expect(text).toContain('<b>5</b> language(s) across <b>3</b> job(s)');
    expect(text).toContain('<b>1</b> auth episode(s)');
    expect(text).toContain('<b>12.3h</b>');
  });

  it('keeps failures black at zero and red when non-zero', () => {
    expect(allText(card(buildDailySummaryCard(stats)))).toContain('<b>0</b> failed');
    const withFailures = allText(card(buildDailySummaryCard({ ...stats, failed: 4 })));
    expect(withFailures).toContain('#d93025');
    expect(withFailures).toContain('<b>4</b> failed');
  });
});
