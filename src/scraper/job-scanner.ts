import type { Page } from 'playwright';
import { type Job, type SupportedLanguage, SUPPORTED_LANGUAGES } from '../types/index.js';
import type winston from 'winston';

const JOB_BOARD_URL = 'https://www.translationtms.com/job-board';

export class JobScanner {
  constructor(private page: Page, private logger: winston.Logger) {}

  async scan(): Promise<Job[]> {
    // TODO(phase-2): Implement pagination — spec §3.3 requires it for total > 10.
    // Current behavior: only page 1 is parsed; warning logged if rows >= 10.
    await this.page.goto(JOB_BOARD_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForSelector('table, [role="table"]', { timeout: 15_000 });
    const rows = await this.parseRows();
    const filtered = rows.filter((j) =>
      j.languagesNeeded.some((l) => (SUPPORTED_LANGUAGES as readonly string[]).includes(l))
    );
    if (rows.length >= 10) {
      this.logger.warn('Job Board page may have additional pages — pagination not yet implemented', {
        rowsOnPage: rows.length,
        risk: 'jobs beyond page 1 will be missed',
      });
    }
    this.logger.info('job scan complete', {
      total: rows.length,
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
        if (cells.length < 8) continue;
        const idText = cells[0]?.textContent?.trim() ?? '';
        if (!/^\d+$/.test(idText)) continue;
        const langTags = Array.from(cells[6].querySelectorAll('[class*="tag"], span, .badge'))
          .map((el) => el.textContent?.trim() ?? '')
          .filter((s) => s.length > 0 && !s.startsWith('+'));
        const openLink = (row.querySelector('a[href*="job"], button[data-href]') as HTMLAnchorElement | null);
        out.push({
          id: idText,
          name: cells[1]?.textContent?.trim() ?? '',
          dueDate: cells[2]?.textContent?.trim() ?? '',
          project: cells[4]?.textContent?.trim() ?? '',
          languageCount: Number(cells[5]?.textContent?.trim() ?? 0),
          languagesNeeded: langTags,
          wordCount: Number(cells[7]?.textContent?.trim().replace(/,/g, '') ?? 0),
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
