import { JWT } from 'google-auth-library';
import { promises as fs } from 'fs';
import type winston from 'winston';
import type { Settings } from '../types/index.js';
import type { AssignmentSummaryItem } from '../notifications/google-chat.js';
import { buildSheetRows } from './sheets-rows.js';

/** The `sheets` config block from settings — single source of truth for the shape. */
export type SheetsConfig = NonNullable<Settings['sheets']>;

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const REQUEST_TIMEOUT_MS = 10_000;
const FAILURE_ALERT_THRESHOLD = 3;
// Statuses that won't fix themselves by retrying (wrong/again-shared sheet,
// renamed/removed tab, revoked Editor access). Treat like an init failure:
// disable + alert once, instead of log-spamming every tick forever.
const PERMANENT_STATUSES = new Set([401, 403, 404]);

/** Carries the HTTP status so the caller can tell a permanent failure (auth /
 *  permission / not-found) from a transient one (timeout, 5xx). */
class SheetsHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

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

  /**
   * Write a row per assigned language to its matching tab (deduped by Job ID).
   * No-op when disabled or there's nothing to write. Never throws. Each tab is
   * read and written in ISOLATION, so one tab's failure never drops another
   * tab's rows; a permanent failure (auth/tab) disables the sink rather than
   * retrying every tick.
   */
  async appendAssignments(items: AssignmentSummaryItem[]): Promise<void> {
    if (this.disabled || !this.config || !this.jwt || items.length === 0) return;

    // Phase 1 — read each tab's used rows in isolation. The A:G row count gives
    // the true next empty row (existing rows may fill only B/D/F with column C
    // blank, so counting column C alone undercounts and would overwrite real
    // rows). Column C (index 2) within those rows is the dedup key. A tab whose
    // read fails is left out of startRowByTab and skipped in phase 3.
    const startRowByTab: Record<string, number> = {};
    const existingIdsByTab: Record<string, Set<string>> = {};
    let anyFailure = false;
    for (const tab of new Set(Object.values(this.config.tabs))) {
      try {
        const used = await this.fetchUsedRows(tab);
        startRowByTab[tab] = used.length + 1;
        existingIdsByTab[tab] = new Set(used.map((r) => (r[2] ?? '').trim()).filter(Boolean));
      } catch (err) {
        anyFailure = true;
        if (this.disableIfPermanent('read', tab, err)) return;
      }
    }

    // Phase 2 — build the rows (pure, cannot fail). Tabs whose read failed get
    // an empty dedup set here but are filtered out in phase 3 (no startRow), so
    // they are never written without a valid dedup read.
    const rowsByTab = buildSheetRows(items, existingIdsByTab, this.config.tabs);

    // Phase 3 — write each successfully-read tab in isolation. An explicit
    // `C{n}:G{n}` update guarantees the C..G columns (values:append keys off the
    // detected table's first column and would land in A:E here).
    for (const [tab, rows] of Object.entries(rowsByTab)) {
      const startRow = startRowByTab[tab];
      if (rows.length === 0 || startRow === undefined) continue;
      try {
        await this.writeRows(tab, startRow, rows);
        this.logger.info('wrote assignment rows to sheet', { tab, count: rows.length, startRow });
      } catch (err) {
        anyFailure = true;
        if (this.disableIfPermanent('write', tab, err)) return;
      }
    }

    if (anyFailure) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures === FAILURE_ALERT_THRESHOLD) {
        this.onAlert(
          `Google Sheets logging has failed ${this.consecutiveFailures} tick(s) in a row — recent assignments are not being mirrored to the sheet (the assignments themselves are unaffected).`
        );
      }
    } else {
      this.consecutiveFailures = 0;
    }
  }

  /** Log a failed tab operation (with phase + tab + status). If the status is
   *  permanent, disable the sink and alert once, returning true so the caller
   *  stops processing further tabs. Transient failures return false. */
  private disableIfPermanent(phase: 'read' | 'write', tab: string, err: unknown): boolean {
    const status = err instanceof SheetsHttpError ? err.status : undefined;
    this.logger.error('Google Sheets operation failed', { phase, tab, status, error: (err as Error).message });
    if (status !== undefined && PERMANENT_STATUSES.has(status)) {
      this.disabled = true;
      this.onAlert(
        `Google Sheets logging disabled (HTTP ${status} on ${phase} "${tab}") — the sheet may no longer be shared with the service account as Editor, or the tab was renamed/removed. Fix it and restart the bot to re-enable.`
      );
      return true;
    }
    return false;
  }

  private async bearer(): Promise<string> {
    const { token } = await this.jwt!.getAccessToken();
    if (!token) throw new Error('failed to obtain a Google access token');
    return token;
  }

  /** Authed Sheets request with a timeout and a uniform error (carrying the HTTP
   *  status). Throws on non-OK — every caller runs inside a try/catch, so the
   *  never-throw contract of the public methods is preserved. */
  private async request(url: string, errLabel: string, init?: { method?: string; jsonBody?: unknown }): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.bearer()}` };
    if (init?.jsonBody !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method: init?.method,
      headers,
      body: init?.jsonBody !== undefined ? JSON.stringify(init.jsonBody) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new SheetsHttpError(res.status, `${errLabel} ${res.status}: ${await res.text()}`);
    return res;
  }

  private async fetchTabTitles(): Promise<string[]> {
    const url = `${SHEETS_API}/${this.config!.spreadsheetId}?fields=sheets.properties.title`;
    const res = await this.request(url, 'metadata fetch');
    const body = (await res.json()) as { sheets?: { properties?: { title?: string } }[] };
    return (body.sheets ?? []).map((s) => s.properties?.title ?? '');
  }

  /** All rows with data in columns A:G. The API omits trailing empty rows, so
   *  `length` is the last used row across the whole table (→ next empty row);
   *  each row's column C (index 2) is the dedup key. */
  private async fetchUsedRows(tab: string): Promise<string[][]> {
    const range = encodeURIComponent(`'${tab}'!A:G`);
    const res = await this.request(`${SHEETS_API}/${this.config!.spreadsheetId}/values/${range}`, `read ${tab}`);
    const body = (await res.json()) as { values?: string[][] };
    return body.values ?? [];
  }

  /** Write rows into an explicit `C{startRow}:G{...}` range so the columns are
   *  guaranteed (unlike append, which keys off the detected table's first column). */
  private async writeRows(tab: string, startRow: number, rows: string[][]): Promise<void> {
    const endRow = startRow + rows.length - 1;
    const range = encodeURIComponent(`'${tab}'!C${startRow}:G${endRow}`);
    const url = `${SHEETS_API}/${this.config!.spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`;
    await this.request(url, `write ${tab}`, { method: 'PUT', jsonBody: { values: rows } });
  }
}
