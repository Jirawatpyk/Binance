import 'dotenv/config';
import { buildAssignmentSummaryCard, buildDailySummaryCard } from '../src/notifications/google-chat.js';

// Sends sample cards to Google Chat so the card designs can be eyeballed in the
// real client. Requires GOOGLE_CHAT_TEST_WEBHOOK_URL (a throwaway space) — there
// is deliberately NO fallback to the production webhook, so previews can never
// hit the production space. Run: npx tsx scripts/preview-card.ts
const url = process.env.GOOGLE_CHAT_TEST_WEBHOOK_URL;
if (!url) {
  console.error('Set GOOGLE_CHAT_TEST_WEBHOOK_URL in .env (a non-production Chat space) to preview cards.');
  process.exit(1);
}

async function send(label: string, payload: unknown): Promise<void> {
  const res = await fetch(url as string, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(payload),
  });
  console.log(label, 'HTTP', res.status, res.ok ? 'OK' : await res.text());
}

await send(
  'assignment-card',
  buildAssignmentSummaryCard([
    { jobId: '62464', name: 'Binance Finance App — Q2 Localization', wordCount: 340, assigned: { 'lo-LA': 'LO_T1@eqho.com' }, dueDate: new Date('2026-05-30T14:00:00Z') },
    { jobId: '62466', name: 'Compliance Notice Update', wordCount: 128, assigned: { 'km-KH': 'kh_e3@eqho.com' }, dueDate: new Date('2026-05-28T09:30:00Z') },
    { jobId: '62470', name: 'Wallet Onboarding Flow', wordCount: 1520, assigned: { 'lo-LA': 'LO_T3@eqho.com', 'km-KH': 'kh_e3@eqho.com' } },
  ])
);

await send(
  'daily-summary-card',
  buildDailySummaryCard({
    date: '2026-05-27',
    assigned: 7,
    jobsAssigned: 5,
    byLang: { 'lo-LA': 4, 'km-KH': 3 },
    failed: 1,
    authEpisodes: 0,
    ticks: 240,
    uptimeHours: 12.3,
    lastAssignmentAt: '2026-05-27T11:42:00Z',
    lastSuccessAt: '2026-05-27T13:09:00Z',
    consecutiveErrors: 0,
  })
);

console.log('Done — check the test Google Chat space.');
