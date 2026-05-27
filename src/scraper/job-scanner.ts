import type { Page } from 'playwright';
import { type Job, SUPPORTED_LANGUAGES } from '../types/index.js';
import type winston from 'winston';
import { parseCreatedUtc } from './date-utils.js';

const JOB_BOARD_URL = 'https://www.translationtms.com/job-board';

// Selectors verified live against the real board (2026-05-27, cookie session):
//   Status filter:   .ant-select nth(0) — single-select, initial value "My Jobs"
//   Language filter: .ant-select nth(1) — ant-select-multiple + show-search
//   Option format:   "lo-LA - Lao (Laos)", "km-KH - Khmer (Cambodia)"
//   Search button:   button with text "Search" (ant-btn-primary)
//   Clear tag icon:  .ant-select-selection-item-remove
//   Due Date range picker:     .ant-picker-range nth(0) — "Due Date From / Due Date To"
//   Created date range picker: .ant-picker-range nth(1) — "Created From / Created To"
//   Date string format accepted by inputs: "YYYY-MM-DD HH:mm:ss"

/** Config sub-object passed in from settings.scan */
export interface ScanConfig {
  lookbackHours: number;
  maxCandidatesPerTick: number;
}

/** Internal row shape before Job transformation (includes created for client-side filter) */
interface RawRow {
  id: string;
  name: string;
  dueDate: string;
  created: string; // cells[4] — "YYYY-MM-DD HH:mm" format from board
  project: string;
  languageCount: number;
  languagesNeeded: string[];
  wordCount: number;
  detailUrl: string;
}

export class JobScanner {
  constructor(
    private page: Page,
    private logger: winston.Logger,
    private scanConfig: ScanConfig,
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async scan(): Promise<Job[]> {
    // Navigate fresh to the Job Board
    await this.page.goto(JOB_BOARD_URL, { waitUntil: 'networkidle' });
    await this.page.waitForSelector('table, [role="table"]', { timeout: 15_000 });

    // Compute lookback window
    const createdTo = new Date();
    const createdFrom = new Date(Date.now() - this.scanConfig.lookbackHours * 3600_000);
    this.logger.info('scan window', {
      lookbackHours: this.scanConfig.lookbackHours,
      createdFrom: createdFrom.toISOString(),
      createdTo: createdTo.toISOString(),
    });

    // Set the status filter to "Available to Claim" (once — applies to all languages)
    await this.setStatusFilter('Available to Claim');

    // Set the Created date range filter (board-level filter — narrows to recent jobs)
    await this.setDateFilter(createdFrom, createdTo);

    // Iterate each supported language and collect all pages
    const jobMap = new Map<string, Job>();

    for (const lang of SUPPORTED_LANGUAGES) {
      this.logger.info('scanning language', { lang });
      const jobs = await this.scanForLanguage(lang, createdFrom);
      for (const job of jobs) {
        if (!jobMap.has(job.id)) {
          jobMap.set(job.id, job);
        }
      }
      this.logger.info('language scan complete', { lang, found: jobs.length });
    }

    let candidates = [...jobMap.values()];

    // Sort newest first (by job ID descending — higher IDs are more recent)
    candidates.sort((a, b) => Number(b.id) - Number(a.id));

    // Enforce the per-tick safety cap
    if (candidates.length > this.scanConfig.maxCandidatesPerTick) {
      this.logger.warn('candidate count exceeds cap; truncating', {
        found: candidates.length,
        cap: this.scanConfig.maxCandidatesPerTick,
      });
      candidates = candidates.slice(0, this.scanConfig.maxCandidatesPerTick);
    }

    this.logger.info('job scan complete', {
      candidates: candidates.length,
      candidateIds: candidates.map((j) => j.id),
    });
    return candidates;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Set the top-level status filter (the first .ant-select on the page). */
  private async setStatusFilter(value: string): Promise<void> {
    const statusSelect = this.page.locator('.ant-select').nth(0);
    if (!(await statusSelect.isVisible({ timeout: 5_000 }).catch(() => false))) {
      throw new Error('setStatusFilter: .ant-select nth(0) not visible — page structure may have changed');
    }
    await statusSelect.click();
    await this.page.waitForTimeout(400);

    const optionLocator = this.page
      .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
      .filter({ hasText: value });

    const found = await optionLocator.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!found) {
      await this.page.keyboard.press('Escape');
      throw new Error(`setStatusFilter: option "${value}" not found in dropdown — available options may have changed`);
    }
    await optionLocator.first().click();
    await this.page.waitForTimeout(300);
    this.logger.debug('status filter set', { value });
  }

  /**
   * Set the "Created From / Created To" RangePicker (.ant-picker-range nth(1)).
   * Verified live (2026-05-27): inputs accept direct typing in "YYYY-MM-DD HH:mm:ss" format.
   * The RangePicker at index 0 is "Due Date From/To"; index 1 is "Created From/To".
   */
  private async setDateFilter(from: Date, to: Date): Promise<void> {
    const fromStr = this.formatDate(from);
    const toStr = this.formatDate(to);

    // Close any open dropdowns first
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(200);

    const rangePicker = this.page.locator('.ant-picker-range').nth(1); // Created From/To
    if (!(await rangePicker.isVisible({ timeout: 5_000 }).catch(() => false))) {
      this.logger.warn('setDateFilter: Created date range picker not visible — skipping date filter');
      return;
    }

    const rangeInputs = rangePicker.locator('input');

    // Fill "Created From"
    const fromInput = rangeInputs.nth(0);
    await fromInput.click({ timeout: 10_000 });
    await this.page.waitForTimeout(400);

    // Calendar popup should appear; type the date string directly
    const calendarVisible = await this.page
      .locator('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)')
      .isVisible({ timeout: 2_000 })
      .catch(() => false);

    if (calendarVisible) {
      await fromInput.fill('');
      await this.page.keyboard.type(fromStr, { delay: 40 });
      await this.page.waitForTimeout(300);
      await this.page.keyboard.press('Enter');
      await this.page.waitForTimeout(400);

      // Now fill "Created To"
      const toInput = rangeInputs.nth(1);
      await toInput.fill('');
      await this.page.keyboard.type(toStr, { delay: 40 });
      await this.page.waitForTimeout(300);
      await this.page.keyboard.press('Enter');
      await this.page.waitForTimeout(400);

      await this.page.keyboard.press('Escape');
      await this.page.waitForTimeout(200);
    } else {
      // Fallback: try fill directly without calendar interaction
      await fromInput.fill(fromStr);
      await this.page.keyboard.press('Tab');
      await this.page.waitForTimeout(200);
      const toInput = rangeInputs.nth(1);
      await toInput.fill(toStr);
      await this.page.keyboard.press('Tab');
      await this.page.waitForTimeout(200);
    }

    const fromVal = await fromInput.inputValue().catch(() => '?');
    const toVal = await rangeInputs.nth(1).inputValue().catch(() => '?');
    this.logger.debug('date filter set', { fromStr, toStr, fromAccepted: fromVal, toAccepted: toVal });
  }

  /**
   * Format a Date as "YYYY-MM-DD HH:mm:ss" — the format the board's date picker accepts.
   * Verified live on 2026-05-27 via inspect-dates.ts.
   */
  private formatDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
  }

  /**
   * Set the language multi-select filter (.ant-select nth(1)) to the given lang code.
   * Clears any previously selected language tag first.
   */
  private async setLanguageFilter(lang: string): Promise<void> {
    const langSelect = this.page.locator('.ant-select').nth(1);
    if (!(await langSelect.isVisible({ timeout: 5_000 }).catch(() => false))) {
      throw new Error('setLanguageFilter: .ant-select nth(1) not visible — page structure may have changed');
    }

    // Clear any existing tags (there may be one from the previous iteration)
    // The remove icon on each selected tag: .ant-select-selection-item-remove
    const removeButtons = this.page.locator('.ant-select-selection-item-remove');
    const removeCount = await removeButtons.count();
    for (let i = 0; i < removeCount; i++) {
      // Always remove the first one (they shift after each removal)
      const btn = this.page.locator('.ant-select-selection-item-remove').first();
      const visible = await btn.isVisible({ timeout: 1_000 }).catch(() => false);
      if (visible) {
        await btn.click();
        await this.page.waitForTimeout(200);
      }
    }

    // Open the dropdown and search for the language
    await langSelect.click();
    await this.page.waitForTimeout(300);

    // For ant-select-multiple + show-search, typing after clicking opens/filters the dropdown.
    // Use the first few chars of the lang code as search term.
    const searchTerm = lang.split('-')[0]; // "lo" for lo-LA, "km" for km-KH
    await this.page.keyboard.type(searchTerm, { delay: 80 });
    await this.page.waitForTimeout(600);

    const optionLocator = this.page
      .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
      .filter({ hasText: lang });

    const found = await optionLocator.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!found) {
      await this.page.keyboard.press('Escape');
      throw new Error(`setLanguageFilter: option containing "${lang}" not found in dropdown — option text may have changed`);
    }
    await optionLocator.first().click();
    await this.page.waitForTimeout(300);
    this.logger.debug('language filter set', { lang });
  }

  /** Click the Search button and wait for the table to update. */
  private async clickSearch(): Promise<void> {
    const searchBtn = this.page.locator('button').filter({ hasText: /^Search$/ }).first();
    if (!(await searchBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
      throw new Error('clickSearch: Search button not visible — page structure may have changed');
    }
    await searchBtn.click();
    await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {
      // Table may update client-side without network activity — continue
    });
    // Wait for the spinner to disappear (Ant Design shows .ant-spin-spinning while loading)
    await this.page.waitForSelector('.ant-spin-spinning', { state: 'hidden', timeout: 10_000 }).catch(() => {});
    await this.page.waitForTimeout(300);
  }

  /**
   * Set language filter to `lang`, click Search, then paginate through all
   * result pages and return all parsed Job rows (already client-side filtered by cutoff).
   */
  private async scanForLanguage(lang: string, cutoff: Date): Promise<Job[]> {
    // Re-assert status filter defensively — Ant Select may reset on language change
    await this.setStatusFilter('Available to Claim');
    await this.setLanguageFilter(lang);
    await this.clickSearch();

    return this.collectAllPages(lang, cutoff);
  }

  /**
   * Paginate through all result pages for the current filter state and
   * return all Job rows (deduped by id within this run).
   * Also applies a client-side date filter on cells[4] (Created column)
   * as a second layer of safety in case the board filter is imprecise.
   */
  private async collectAllPages(lang: string, cutoff: Date): Promise<Job[]> {
    const allRows: Job[] = [];
    const seenIds = new Set<string>();
    const MAX_PAGES = 50; // safety cap: 50 pages × 10/page = 500 jobs max per language
    let hitCap = false;

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const rows = await this.parseRows();
      for (const r of rows) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          // Client-side date guard: only include rows where Created >= cutoff
          if (this.isCreatedAfterCutoff(r.created, cutoff)) {
            allRows.push(this.toJob(r));
          } else {
            this.logger.debug('row excluded by client-side date filter', {
              id: r.id,
              created: r.created,
              cutoff: cutoff.toISOString(),
            });
          }
        }
      }
      this.logger.debug('page parsed', { lang, pageNum, rowsOnPage: rows.length });

      // Pagination uses plain Ant Buttons (NOT .ant-pagination-next).
      // The "Next" button has text "Next" inside a <span>.
      const nextBtn = this.page.locator('button').filter({ hasText: /^Next$/ }).first();

      const visible = await nextBtn.isVisible({ timeout: 1_000 }).catch(() => false);
      if (!visible) break;
      const disabled = await nextBtn.isDisabled().catch(() => true);
      if (disabled) break;

      // If we're at the last allowed page but Next is still enabled, more pages exist
      if (pageNum === MAX_PAGES) {
        hitCap = true;
        break;
      }

      await nextBtn.click();
      await this.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {
        // Client-side pagination — no network activity expected
      });
      // Wait for spinner to clear after page change
      await this.page.waitForSelector('.ant-spin-spinning', { state: 'hidden', timeout: 5_000 }).catch(() => {});
      await this.page.waitForTimeout(300);
    }

    if (hitCap) {
      this.logger.warn('MAX_PAGES cap reached while more pages exist — some jobs may be missed', {
        maxPages: MAX_PAGES,
      });
    }

    return allRows;
  }

  /**
   * Parse all visible job rows on the current page, returning raw rows that
   * include the Created date string for client-side filtering.
   *
   * Cell index mapping (10 tds per row, index 0 = star/icon col):
   *   cells[1] = Job ID
   *   cells[2] = Job Name
   *   cells[3] = Due Date
   *   cells[4] = Created (UTC) — "YYYY-MM-DD HH:mm" from the board
   *   cells[5] = Project
   *   cells[6] = Language Count
   *   cells[7] = Language Tags (visible, up to 3 + +N overflow)
   *   cells[8] = Word Count
   *   cells[9] = Action (contains <a href="/job/<id>">)
   */
  private async parseRows(): Promise<RawRow[]> {
    return this.page.$$eval('table tbody tr, [role="row"]', (rowEls) => {
      const out: RawRow[] = [];
      for (const row of rowEls as Element[]) {
        const cells = row.querySelectorAll('td, [role="cell"]');
        // Real rows have 10 tds; measure-row (height:0) also has 10 but all empty
        if (cells.length < 10) continue;
        const idText = cells[1]?.textContent?.trim() ?? '';
        if (!/^\d+$/.test(idText)) continue;
        const langTags = Array.from(cells[7].querySelectorAll('[class*="tag"], span, .badge'))
          .map((el) => el.textContent?.trim() ?? '')
          .filter((s) => s.length > 0 && !s.startsWith('+'));
        const openLink = row.querySelector('a[href*="job"]') as HTMLAnchorElement | null;
        out.push({
          id: idText,
          name: cells[2]?.textContent?.trim() ?? '',
          dueDate: cells[3]?.textContent?.trim() ?? '',
          created: cells[4]?.textContent?.trim() ?? '',
          project: cells[5]?.textContent?.trim() ?? '',
          languageCount: Number(cells[6]?.textContent?.trim() ?? 0),
          languagesNeeded: langTags,
          wordCount: Number(cells[8]?.textContent?.trim().replace(/,/g, '') ?? 0),
          detailUrl: openLink?.href ?? `https://www.translationtms.com/job/${idText}`,
        });
      }
      return out;
    });
  }

  /** Convert a RawRow to a Job (parse dueDate to Date). */
  private toJob(r: RawRow): Job {
    return {
      id: r.id,
      name: r.name,
      dueDate: new Date(r.dueDate),
      project: r.project,
      languageCount: r.languageCount,
      languagesNeeded: r.languagesNeeded,
      wordCount: r.wordCount,
      detailUrl: r.detailUrl,
    };
  }

  /**
   * Client-side date guard: return true if the board's Created string
   * represents a time >= cutoff.
   * The board displays Created as "YYYY-MM-DD HH:mm" or "YYYY-MM-DD HH:mm:ss" (UTC).
   * If parsing fails, we conservatively include the row (don't drop it).
   */
  private isCreatedAfterCutoff(createdStr: string, cutoff: Date): boolean {
    const ms = parseCreatedUtc(createdStr);
    if (ms === null) {
      this.logger.warn('could not parse created date; including row conservatively', { createdStr });
      return true;
    }
    return ms >= cutoff.getTime();
  }
}
