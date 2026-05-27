import { describe, it, expect } from 'vitest';
import { buildTextCard, buildAssignmentSummaryCard } from '../../src/notifications/google-chat.js';

// Narrow helper to reach into the cardsV2 payload without `any` everywhere.
function card(payload: unknown): {
  cardId: string;
  card: {
    header: { title: string; subtitle: string };
    sections: Array<{ widgets: Array<{ textParagraph?: { text: string } }> }>;
  };
} {
  return (payload as { cardsV2: unknown[] }).cardsV2[0] as never;
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
  it('builds one card with the job count in the header and one widget per job', () => {
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
    expect(c.card.header.title).toBe('✅ Assigned 2 job(s) this cycle');
    expect(c.card.sections[0].widgets).toHaveLength(2);
  });

  it('includes job id, name, word count, and every language → translator', () => {
    const c = card(
      buildAssignmentSummaryCard([
        { jobId: '333', name: 'Finance App', wordCount: 12, assigned: { 'lo-LA': 'lo@eqho.com', 'km-KH': 'kh@eqho.com' } },
      ])
    );
    const text = c.card.sections[0].widgets[0].textParagraph?.text ?? '';
    expect(text).toContain('Job 333');
    expect(text).toContain('Finance App');
    expect(text).toContain('12 words');
    expect(text).toContain('lo-LA → lo@eqho.com');
    expect(text).toContain('km-KH → kh@eqho.com');
  });
});
