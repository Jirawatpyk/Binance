import { describe, it, expect } from 'vitest';
import { buildTextCard, buildAssignmentSummaryCard, buildDailySummaryCard, buildReviewSummaryCard, dueColor } from '../../src/notifications/google-chat.js';

// Narrow helper to reach into the cardsV2 payload without `any` everywhere.
function card(payload: unknown): {
  cardId: string;
  card: {
    header: { title: string; subtitle: string };
    sections: Array<{
      header?: string;
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

/** Concatenate all renderable text across every section's widgets. */
function allText(c: ReturnType<typeof card>): string {
  return c.card.sections
    .flatMap((s) => s.widgets)
    .map(
      (w) =>
        `${w.decoratedText?.topLabel ?? ''} ${w.decoratedText?.bottomLabel ?? ''} ${w.decoratedText?.text ?? ''} ${w.textParagraph?.text ?? ''}`
    )
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

  it('renders the due date (UTC, colored) under the job, and omits it when unknown', () => {
    const c = card(
      buildAssignmentSummaryCard([
        { jobId: '1', name: 'With due', wordCount: 10, assigned: { 'lo-LA': 'a@eqho.com' }, dueDate: new Date('2026-05-30T14:05:00Z') },
        { jobId: '2', name: 'No due', wordCount: 10, assigned: { 'km-KH': 'b@eqho.com' } },
      ])
    );
    const jobWidgets = c.card.sections[0].widgets.filter((w) => w.decoratedText);
    const t0 = jobWidgets[0].decoratedText?.text ?? '';
    expect(t0).toContain('⏰ Due 2026-05-30 14:05 UTC');
    expect(t0).toMatch(/<font color="#[0-9a-f]{6}">⏰ Due/); // coloured by urgency (see dueColor tests)
    // order: job name → due → language lines
    expect(t0.indexOf('With due')).toBeLessThan(t0.indexOf('Due '));
    expect(t0.indexOf('Due ')).toBeLessThan(t0.indexOf('lo-LA'));
    expect(jobWidgets[1].decoratedText?.text).not.toContain('Due ');
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

describe('dueColor', () => {
  const now = new Date('2026-05-27T12:00:00Z');
  it('red when overdue or due within 24h', () => {
    expect(dueColor(new Date('2026-05-27T08:00:00Z'), now)).toBe('#d93025'); // overdue
    expect(dueColor(new Date('2026-05-28T10:00:00Z'), now)).toBe('#d93025'); // 22h
  });
  it('amber when due within 3 days', () => {
    expect(dueColor(new Date('2026-05-29T12:00:00Z'), now)).toBe('#e8710a'); // 48h
  });
  it('grey when far off or unknown', () => {
    expect(dueColor(new Date('2026-06-05T12:00:00Z'), now)).toBe('#888888'); // >3 days
    expect(dueColor(null, now)).toBe('#888888');
    expect(dueColor(new Date('invalid'), now)).toBe('#888888');
  });
});

describe('buildReviewSummaryCard', () => {
  it('summarises reviewer assignments per job', () => {
    const c = card(
      buildReviewSummaryCard([
        { jobId: '62403', name: 'alicloud-ios', reviewed: { 'lo-LA': 'LO_T2@eqho.com' } },
      ])
    );
    expect(c.card.header.title).toBe('🔍 Reviewer assigned — 1 job');
    const text = allText(c);
    expect(text).toContain('Job 62403');
    expect(text).toContain('alicloud-ios');
    expect(text).toContain('<b>lo-LA</b> → LO_T2@eqho.com');
  });

  it('pluralises and separates multiple jobs with a divider', () => {
    const c = card(
      buildReviewSummaryCard([
        { jobId: '1', name: 'A', reviewed: { 'lo-LA': 'LO_T2@eqho.com' } },
        { jobId: '2', name: 'B', reviewed: { 'lo-LA': 'LO_T2@eqho.com' } },
      ])
    );
    expect(c.card.header.title).toBe('🔍 Reviewer assigned — 2 jobs');
    const widgets = c.card.sections[0].widgets;
    expect(widgets.filter((w) => w.decoratedText)).toHaveLength(2);
    expect(widgets.filter((w) => w.divider)).toHaveLength(1);
  });

  it('escapes HTML-special characters in name and reviewer', () => {
    const text = allText(
      card(buildReviewSummaryCard([{ jobId: 'J<1>', name: 'A & B', reviewed: { 'lo-LA': 'r&x@eqho.com' } }]))
    );
    expect(text).toContain('Job J&lt;1&gt;');
    expect(text).toContain('A &amp; B');
    expect(text).toContain('r&amp;x@eqho.com');
  });
});

describe('buildDailySummaryCard', () => {
  const stats = {
    date: '2026-05-27',
    assigned: 5,
    jobsAssigned: 3,
    reviewed: 2,
    byLang: { 'lo-LA': 2, 'km-KH': 3 } as Record<'lo-LA' | 'km-KH', number>,
    failed: 0,
    authEpisodes: 1,
    ticks: 240,
    uptimeHours: 12.3,
    lastAssignmentAt: '2026-05-27T11:42:00Z',
    lastSuccessAt: '2026-05-27T13:09:00Z',
    consecutiveErrors: 0,
  };

  it('has the Daily Summary header with date + uptime subtitle and Assignments/Health sections', () => {
    const c = card(buildDailySummaryCard(stats));
    expect(c.card.header.title).toBe('📊 Daily Summary');
    expect(c.card.header.subtitle).toBe('2026-05-27  ·  uptime 12.3h');
    expect(c.card.sections.map((s) => s.header)).toEqual(['Assignments', 'Health']);
  });

  it('renders totals, per-language breakdown, polls, and last activity (UTC)', () => {
    const text = allText(card(buildDailySummaryCard(stats)));
    expect(text).toContain('<b>5</b> language(s) across <b>3</b> job(s)');
    expect(text).toContain('lo-LA <b>2</b>');
    expect(text).toContain('km-KH <b>3</b>');
    expect(text).toContain('<b>2</b> reviewer assignment(s)');
    expect(text).toContain('<b>240</b> polls');
    expect(text).toContain('<b>12.3h</b>');
    expect(text).toContain('2026-05-27 11:42 UTC'); // last assignment
    expect(text).toContain('2026-05-27 13:09 UTC'); // last successful poll
  });

  it('shows "No assignments yet today" when idle', () => {
    const text = allText(card(buildDailySummaryCard({ ...stats, assigned: 0, jobsAssigned: 0 })));
    expect(text).toContain('No assignments yet today');
  });

  it('keeps failures black at zero and red when non-zero, and surfaces error streak', () => {
    expect(allText(card(buildDailySummaryCard(stats)))).toContain('<b>0</b> failed');
    const bad = allText(card(buildDailySummaryCard({ ...stats, failed: 4, consecutiveErrors: 3 })));
    expect(bad).toContain('#d93025');
    expect(bad).toContain('<b>4</b> failed');
    expect(bad).toContain('<b>3</b> err streak');
  });
});
