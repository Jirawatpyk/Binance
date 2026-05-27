import 'dotenv/config';
import { buildAssignmentSummaryCard } from '../src/notifications/google-chat.js';

// Sends a sample assignment-summary card to Google Chat so the new card design
// can be eyeballed in the real client. Run: npx tsx scripts/preview-card.ts
const url = process.env.GOOGLE_CHAT_WEBHOOK_URL;
if (!url) {
  console.error('GOOGLE_CHAT_WEBHOOK_URL not set in .env');
  process.exit(1);
}

const payload = buildAssignmentSummaryCard([
  { jobId: '62464', name: 'Binance Finance App — Q2 Localization', wordCount: 340, assigned: { 'lo-LA': 'LO_T1@eqho.com' } },
  { jobId: '62466', name: 'Compliance Notice Update', wordCount: 128, assigned: { 'km-KH': 'kh_e3@eqho.com' } },
  { jobId: '62470', name: 'Wallet Onboarding Flow', wordCount: 1520, assigned: { 'lo-LA': 'LO_T3@eqho.com', 'km-KH': 'kh_e3@eqho.com' } },
]);

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=UTF-8' },
  body: JSON.stringify(payload),
});
console.log('HTTP', res.status, res.ok ? 'OK — check Google Chat' : await res.text());
