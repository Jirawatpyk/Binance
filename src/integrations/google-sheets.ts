import { JWT } from 'google-auth-library';
import { promises as fs } from 'fs';
import type winston from 'winston';
import type { SupportedLanguage } from '../types/index.js';
import type { AssignmentSummaryItem } from '../notifications/google-chat.js';
import { buildSheetRows, type TabMap } from './sheets-rows.js';

export interface SheetsConfig {
  enabled: boolean;
  spreadsheetId: string;
  credentialsPath: string;
  tabs: TabMap;
}

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const REQUEST_TIMEOUT_MS = 10_000;
const FAILURE_ALERT_THRESHOLD = 3;

/**
 * Best-effort sink that mirrors real assignments into a Google Sheet. NEVER
 * throws out of its public methods — a Sheets outage must not break a tick. On
 * a sustained failure it escalates via `onAlert`; the assignment, state, and
 * Chat card remain the source of truth.
 */
export class SheetsAssignmentLogger {
  private jwt?: JWT;
  private disabled: boolean;
  private consecutiveFailures = 0;

  constructor(
    private config: SheetsConfig | undefined,
    private logger: winston.Logger,
    private onAlert: (msg: string) => void
  ) {
    this.disabled = !config?.enabled;
  }

  /** Load credentials and verify the spreadsheet + both tabs are reachable.
   *  On any failure: log, alert once, and disable (the bot keeps assigning). */
  async init(): Promise<void> {
    if (this.disabled || !this.config) return;
    try {
      const raw = JSON.parse(await fs.readFile(this.config.credentialsPath, 'utf-8')) as {
        client_email: string;
        private_key: string;
      };
      this.jwt = new JWT({ email: raw.client_email, key: raw.private_key, scopes: [SCOPE] });
      const titles = await this.fetchTabTitles();
      const missing = Object.values(this.config.tabs).filter((t) => !titles.includes(t));
      if (missing.length > 0) throw new Error(`spreadsheet is missing tab(s): ${missing.join(', ')}`);
      this.logger.info('Google Sheets logging enabled', { spreadsheetId: this.config.spreadsheetId });
    } catch (err) {
      this.disabled = true;
      this.logger.error('Google Sheets init failed — sheet logging disabled', { error: (err as Error).message });
      this.onAlert(
        `Google Sheets logging disabled: ${(err as Error).message}. Check google-credentials.json, the spreadsheet ID/tab names, and that the sheet is shared with the service account as Editor.`
      );
    }
  }

  /** Append a row per assigned language to the matching tab (deduped by Job ID).
   *  No-op when disabled or there's nothing to write. Never throws. */
  async appendAssignments(items: AssignmentSummaryItem[]): Promise<void> {
    if (this.disabled || !this.config || !this.jwt || items.length === 0) return;
    try {
      const existingIdsByTab: Record<string, Set<string>> = {};
      for (const tab of new Set(Object.values(this.config.tabs))) {
        existingIdsByTab[tab] = await this.fetchJobIds(tab);
      }
      const rowsByTab = buildSheetRows(items, existingIdsByTab, this.config.tabs);
      for (const [tab, rows] of Object.entries(rowsByTab)) {
        if (rows.length === 0) continue;
        await this.appendRows(tab, rows);
        this.logger.info('appended assignment rows to sheet', { tab, count: rows.length });
      }
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      this.logger.error('Google Sheets append failed', {
        error: (err as Error).message,
        consecutiveFailures: this.consecutiveFailures,
      });
      if (this.consecutiveFailures === FAILURE_ALERT_THRESHOLD) {
        this.onAlert(
          `Google Sheets logging has failed ${this.consecutiveFailures}× in a row — assignments are not being mirrored to the sheet (the assignments themselves are unaffected).`
        );
      }
    }
  }

  private async bearer(): Promise<string> {
    const { token } = await this.jwt!.getAccessToken();
    if (!token) throw new Error('failed to obtain a Google access token');
    return token;
  }

  private async fetchTabTitles(): Promise<string[]> {
    const url = `${SHEETS_API}/${this.config!.spreadsheetId}?fields=sheets.properties.title`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await this.bearer()}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`metadata fetch ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { sheets?: { properties?: { title?: string } }[] };
    return (body.sheets ?? []).map((s) => s.properties?.title ?? '');
  }

  private async fetchJobIds(tab: string): Promise<Set<string>> {
    const range = encodeURIComponent(`'${tab}'!C:C`);
    const url = `${SHEETS_API}/${this.config!.spreadsheetId}/values/${range}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await this.bearer()}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`read ${tab} ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { values?: string[][] };
    return new Set((body.values ?? []).map((r) => (r[0] ?? '').trim()).filter(Boolean));
  }

  private async appendRows(tab: string, rows: string[][]): Promise<void> {
    const range = encodeURIComponent(`'${tab}'!C:G`);
    const url = `${SHEETS_API}/${this.config!.spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.bearer()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`append ${tab} ${res.status}: ${await res.text()}`);
  }
}
