import type { Page } from 'playwright';
import type { SupportedLanguage } from '../types/index.js';
import { AssignmentFailedError, TranslatorNotFoundError } from '../core/errors.js';
import type winston from 'winston';

export class Assigner {
  constructor(
    private page: Page,
    private logger: winston.Logger,
    private dryRun: boolean
  ) {}

  async assign(language: SupportedLanguage, translatorEmail: string, rowIndex: number): Promise<void> {
    const row = this.page.locator('table tbody tr').nth(rowIndex);
    const assignBtn = row.locator('button:has-text("Assign")').first();
    if (!(await assignBtn.isVisible())) {
      throw new AssignmentFailedError('Assign button not visible', { language, rowIndex });
    }

    if (this.dryRun) {
      this.logger.info('[DRY-RUN] would click Assign', { language, translatorEmail, rowIndex });
      return;
    }

    await assignBtn.click();
    const modal = this.page.locator('[role="dialog"], .modal').first();
    await modal.waitFor({ state: 'visible', timeout: 10_000 });
    const userRow = modal.locator(`text=${translatorEmail}`).first();
    if (!(await userRow.isVisible({ timeout: 5_000 }).catch(() => false))) {
      throw new TranslatorNotFoundError(`Translator ${translatorEmail} not in popup`, {
        language,
      });
    }

    const safeEmail = translatorEmail.replace(/"/g, '\\"');
    const rowAssign = modal
      .locator(`xpath=//*[contains(text(),"${safeEmail}")]/ancestor::*[self::div or self::tr][1]//button[contains(text(),"Assign")]`)
      .first();
    await rowAssign.click();
    await modal.waitFor({ state: 'hidden', timeout: 10_000 });
    const updatedTranslator = (await row.locator('td').nth(2).textContent() ?? '').trim();
    if (!updatedTranslator || updatedTranslator === '-') {
      throw new AssignmentFailedError('Row not updated after modal closed', {
        language,
        translatorEmail,
        rowIndex,
      });
    }
    this.logger.info('assignment submitted', { language, translatorEmail });
  }
}
