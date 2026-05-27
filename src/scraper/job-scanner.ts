import type { Page } from 'playwright';
import { type Job, SUPPORTED_LANGUAGES } from '../types/index.js';
import type winston from 'winston';

const JOB_BOARD_URL = 'https://www.translationtms.com/job-board';

// Selectors verified live against the real board (2026-05-27, cookie session):
//   Status filter:   .ant-select nth(0), current value "My Jobs"
//   Language filter: .ant-select nth(1), ant-select-multiple + show-search
//   Option format:   "lo-LA - Lao (Laos)", "km-KH - Khmer (Cambodia)"
//   Search button:   button with text "Search" (ant-btn-primary)
//   Clear tag icon:  .ant-select-selection-item-remove

export class JobScanner {
  constructor(private page: Page, private logger: winston.Logger) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async scan(): Promise<Job[]> {
    // Navigate fresh to the Job Board
    await this.page.goto(JOB_BOARD_URL, { waitUntil: 'networkidle' });
    await this.page.waitForSelector('table, [role="table"]', { timeout: 15_000 });

    // Set the status filter to "Available to Claim" (once — applies to all languages)
    await this.setStatusFilter('Available to Claim');

    // Iterate each supported language and collect all pages
    const jobMap = new Map<string, Job>();

    for (const lang of SUPPORTED_LANGUAGES) {
      this.logger.info('scanning language', { lang });
      const jobs = await this.scanForLanguage(lang);
      for (const job of jobs) {
        if (!jobMap.has(job.id)) {
          jobMap.set(job.id, job);
        }
      }
      this.logger.info('language scan complete', { lang, found: jobs.length });
    }

    const candidates = [...jobMap.values()];
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
   * result pages and return all parsed Job rows.
   */
  private async scanForLanguage(lang: string): Promise<Job[]> {
    await this.setLanguageFilter(lang);
    await this.clickSearch();

    return this.collectAllPages(lang);
  }

  /**
   * Paginate through all result pages for the current filter state and
   * return all Job rows (deduped by id within this run).
   */
  private async collectAllPages(lang: string): Promise<Job[]> {
    const allRows: Job[] = [];
    const seenIds = new Set<string>();
    const MAX_PAGES = 50; // safety cap: 50 pages × 10/page = 500 jobs max per language

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const rows = await this.parseRows();
      for (const r of rows) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          allRows.push(r);
        }
      }
      this.logger.debug('page parsed', { lang, pageNum, rowsOnPage: rows.length });

      // Pagination uses plain Ant Buttons (NOT .ant-pagination-next).
      // The "Next" button has text "Next" inside a <span>.
      // The "Previous" button is disabled on page 1.
      // Use .filter({ hasText }) which handles nested text in <span>.
      const nextBtn = this.page.locator('button').filter({ hasText: /^Next$/ }).first();

      const visible = await nextBtn.isVisible({ timeout: 1_000 }).catch(() => false);
      if (!visible) break;
      const disabled = await nextBtn.isDisabled().catch(() => true);
      if (disabled) break;

      await nextBtn.click();
      await this.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {
        // Client-side pagination — no network activity expected
      });
      // Wait for spinner to clear after page change
      await this.page.waitForSelector('.ant-spin-spinning', { state: 'hidden', timeout: 5_000 }).catch(() => {});
      await this.page.waitForTimeout(300);
    }

    if (allRows.length >= MAX_PAGES * 10) {
      this.logger.warn('MAX_PAGES safety cap hit — additional jobs may exist', { lang, maxPages: MAX_PAGES });
    }

    return allRows;
  }

  // -------------------------------------------------------------------------
  // Row parsing (cell indices verified in Task 18 DOM inspection report)
  // -------------------------------------------------------------------------

  /**
   * Parse all visible job rows on the current page.
   * Cell index mapping (10 tds per row, index 0 = star/icon col):
   *   cells[1] = Job ID
   *   cells[2] = Job Name
   *   cells[3] = Due Date
   *   cells[5] = Project
   *   cells[6] = Language Count
   *   cells[7] = Language Tags (visible, up to 3 + +N overflow)
   *   cells[8] = Word Count
   *   cells[9] = Action (contains <a href="/job/<id>">)
   */
  private async parseRows(): Promise<Job[]> {
    return this.page
      .$$eval('table tbody tr, [role="row"]', (rowEls) => {
        const out: Array<{
          id: string;
          name: string;
          dueDate: string;
          project: string;
          languageCount: number;
          languagesNeeded: string[];
          wordCount: number;
          detailUrl: string;
        }> = [];
        for (const row of rowEls) {
          const cells = row.querySelectorAll('td, [role="cell"]');
          // Real rows have 10 tds; measure-row (height:0) also has 10 but all empty
          if (cells.length < 10) continue;
          const idText = cells[1]?.textContent?.trim() ?? '';
          if (!/^\d+$/.test(idText)) continue;
          const langTags = Array.from(
            cells[7].querySelectorAll('[class*="tag"], span, .badge')
          )
            .map((el) => el.textContent?.trim() ?? '')
            .filter((s) => s.length > 0 && !s.startsWith('+'));
          const openLink = row.querySelector('a[href*="job"]') as HTMLAnchorElement | null;
          out.push({
            id: idText,
            name: cells[2]?.textContent?.trim() ?? '',
            dueDate: cells[3]?.textContent?.trim() ?? '',
            project: cells[5]?.textContent?.trim() ?? '',
            languageCount: Number(cells[6]?.textContent?.trim() ?? 0),
            languagesNeeded: langTags,
            wordCount: Number(cells[8]?.textContent?.trim().replace(/,/g, '') ?? 0),
            detailUrl: openLink?.href ?? `https://www.translationtms.com/job/${idText}`,
          });
        }
        return out;
      })
      .then((raw) =>
        raw.map((r) => ({
          ...r,
          dueDate: new Date(r.dueDate),
        }))
      );
  }
}
