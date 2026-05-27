import type { Page } from 'playwright';
import { type Job, type SupportedLanguage, SUPPORTED_LANGUAGES } from '../types/index.js';
import type winston from 'winston';

const JOB_BOARD_URL = 'https://www.translationtms.com/job-board';

export class JobScanner {
  constructor(private page: Page, private logger: winston.Logger) {}

  async scan(): Promise<Job[]> {
    await this.page.goto(JOB_BOARD_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForSelector('table, [role="table"]', { timeout: 15_000 });

    const allRows: Job[] = [];
    const seenIds = new Set<string>();
    const MAX_PAGES = 20; // safety cap to avoid infinite loops if Next never disables

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const rows = await this.parseRows();
      for (const r of rows) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          allRows.push(r);
        }
      }
      this.logger.debug('page parsed', { pageNum, rowsOnPage: rows.length });

      const nextBtn = this.page
        .locator('button[aria-label*="next" i]:not([disabled]), button:has-text("Next"):not([disabled]), .ant-pagination-next:not(.ant-pagination-disabled) > button')
        .first();

      const visible = await nextBtn.isVisible({ timeout: 1_000 }).catch(() => false);
      if (!visible) break;
      const disabled = await nextBtn.isDisabled().catch(() => true);
      if (disabled) break;

      await nextBtn.click();
      await this.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {
        /* if no network activity, table may already be updated client-side */
      });
      await this.page.waitForTimeout(300);
    }

    if (allRows.length === MAX_PAGES * 10) {
      this.logger.warn('MAX_PAGES safety cap hit — additional jobs may exist', { maxPages: MAX_PAGES });
    }

    const filtered = allRows.filter((j) =>
      j.languagesNeeded.some((l) => (SUPPORTED_LANGUAGES as readonly string[]).includes(l))
    );

    this.logger.info('job scan complete', {
      totalAcrossPages: allRows.length,
      candidates: filtered.length,
      candidateIds: filtered.map((j) => j.id),
    });
    return filtered;
  }

  private async parseRows(): Promise<Job[]> {
    return this.page.$$eval('table tbody tr, [role="row"]', (rowEls) => {
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
        if (cells.length < 10) continue;
        const idText = cells[1]?.textContent?.trim() ?? '';
        if (!/^\d+$/.test(idText)) continue;
        const langTags = Array.from(cells[7].querySelectorAll('[class*="tag"], span, .badge'))
          .map((el) => el.textContent?.trim() ?? '')
          .filter((s) => s.length > 0 && !s.startsWith('+'));
        const openLink = (row.querySelector('a[href*="job"]') as HTMLAnchorElement | null);
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
    }).then((raw) =>
      raw.map((r) => ({
        ...r,
        dueDate: new Date(r.dueDate),
      }))
    );
  }
}
