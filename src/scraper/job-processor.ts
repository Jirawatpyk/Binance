import type { Page } from 'playwright';
import type { JobDetail, SupportedLanguage, TargetLanguage } from '../types/index.js';
import type winston from 'winston';

export class JobProcessor {
  constructor(private page: Page, private logger: winston.Logger) {}

  async open(detailUrl: string, jobId: string): Promise<JobDetail> {
    await this.page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
    await this.page.waitForSelector('text=Word Count', { timeout: 15_000 });
    const wordCount = await this.readWordCount();
    // Select the "Waiting" TAB specifically (role=tab). A plain text= locator
    // matches the "WAITING" status badge first, not the tab.
    const waitingTab = this.page.getByRole('tab', { name: 'Waiting', exact: true });
    if (await waitingTab.isVisible().catch(() => false)) await waitingTab.click();
    // Ant spinner must settle before reading the table — otherwise we may read
    // stale rows from the previously selected tab while the new tab loads.
    await this.page.waitForSelector('.ant-spin-spinning', { state: 'hidden', timeout: 10_000 }).catch(() => {});
    // Wait for the Waiting-tab LANGUAGE rows specifically. A bare
    // `table tbody tr` can resolve against an unrelated/earlier table before the
    // language table populates (a race seen on brand-new jobs), yielding an
    // empty parse. Poll until a lo-LA/km-KH row is actually present; if the job
    // genuinely has none, this times out and parseLanguageRows() returns [] —
    // which the caller treats as "retry later", not "done".
    await this.page
      .waitForFunction(
        () =>
          Array.from(document.querySelectorAll('table tbody tr td:first-child')).some((c) =>
            /lo-LA|km-KH|Lao|Khmer/i.test(c.textContent ?? '')
          ),
        { timeout: 8_000 }
      )
      .catch(() => {});
    const languages = await this.parseLanguageRows();
    if ((!Number.isFinite(wordCount) || wordCount <= 0) && languages.length > 0) {
      // Word count drives translator-tier selection; a silent 0/NaN on a job
      // that has assignable rows means the selector likely missed the value.
      this.logger.warn('word count parsed as 0/NaN despite assignable rows — check selector', { jobId, wordCount });
    }
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
      const cells = row.locator('td');
      // The language table puts the code in td[0], translator in td[2],
      // reviewer in td[3], status in td[5]. A row with fewer cells belongs to a
      // different/empty table on the page — skip it instead of reading garbage
      // indices, which would mis-flag a row as already-assigned or non-WAITING.
      if ((await cells.count()) < 6) continue;
      const langText = (await cells.nth(0).textContent() ?? '').trim();
      const code = this.detectCode(langText);
      if (!code) continue;
      const translatorText = (await cells.nth(2).textContent() ?? '').trim();
      const reviewerText = (await cells.nth(3).textContent() ?? '').trim();
      const statusText = (await cells.nth(5).textContent() ?? '').trim();
      out.push({
        code,
        status: statusText || 'UNKNOWN',
        translator: translatorText === '-' || translatorText === '' ? null : translatorText,
        // An assigned reviewer/translator is always an email; treat the cell as
        // "set" only when it contains '@', so an empty-state placeholder
        // ('-', em-dash, NBSP, etc.) reliably reads as null rather than
        // silently blocking a reviewer assignment.
        reviewer: reviewerText.includes('@') ? reviewerText : null,
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
