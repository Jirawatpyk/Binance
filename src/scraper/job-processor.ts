import type { Page } from 'playwright';
import type { JobDetail, SupportedLanguage, TargetLanguage } from '../types/index.js';
import type winston from 'winston';

export class JobProcessor {
  constructor(private page: Page, private logger: winston.Logger) {}

  async open(detailUrl: string, jobId: string): Promise<JobDetail> {
    await this.page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
    await this.page.waitForSelector('text=Word Count', { timeout: 15_000 });
    const wordCount = await this.readWordCount();
    const waitingTab = this.page.locator('text=Waiting').first();
    if (await waitingTab.isVisible()) await waitingTab.click();
    await this.page.waitForSelector('table tbody tr', { timeout: 10_000 });
    const languages = await this.parseLanguageRows();
    this.logger.info('job detail parsed', { jobId, wordCount, languages: languages.map((l) => l.code) });
    return { jobId, wordCount, targetLanguages: languages };
  }

  private async readWordCount(): Promise<number> {
    const txt = await this.page
      .locator('xpath=//*[contains(text(),"Word Count")]/following-sibling::*[1]')
      .first()
      .textContent();
    return Number((txt ?? '0').replace(/,/g, '').trim());
  }

  private async parseLanguageRows(): Promise<TargetLanguage[]> {
    const rows = this.page.locator('table tbody tr');
    const count = await rows.count();
    const out: TargetLanguage[] = [];
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const langText = (await row.locator('td').nth(0).textContent() ?? '').trim();
      const code = this.detectCode(langText);
      if (!code) continue;
      const translatorText = (await row.locator('td').nth(2).textContent() ?? '').trim();
      const statusText = (await row.locator('[class*="status"], td:has-text("WAITING"), td:has-text("IN_PROGRESS")').first().textContent() ?? '').trim();
      out.push({
        code,
        status: statusText || 'UNKNOWN',
        translator: translatorText === '-' || translatorText === '' ? null : translatorText,
        rowIndex: i,
      });
    }
    return out;
  }

  private detectCode(text: string): SupportedLanguage | null {
    if (text.includes('lo-LA') || text.toLowerCase().includes('lao')) return 'lo-LA';
    if (text.includes('km-KH') || text.toLowerCase().includes('khmer')) return 'km-KH';
    return null;
  }
}
