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
    // Re-select the Waiting tab in case a prior assignment switched tabs
    const waitingTab = this.page.locator('text=Waiting').first();
    if (await waitingTab.isVisible().catch(() => false)) {
      await waitingTab.click();
      // Wait for the Ant spinner to settle before the table read below, so we
      // don't act on stale rows still being replaced after the tab switch.
      await this.page.waitForSelector('.ant-spin-spinning', { state: 'hidden', timeout: 10_000 }).catch(() => {});
      await this.page.waitForSelector('table tbody tr', { timeout: 10_000 }).catch(() => {});
    }

    // Locate the target row by language text (not by index — index shifts after assignments)
    const row = this.page.locator('table tbody tr').filter({ hasText: language }).first();
    const assignBtn = row.locator('button:has-text("Assign")').first();
    if (!(await assignBtn.isVisible())) {
      throw new AssignmentFailedError('Assign button not visible', { language, rowIndex });
    }

    if (this.dryRun) {
      this.logger.info('[DRY-RUN] would click Assign', { language, translatorEmail, rowIndex });
      return;
    }

    await assignBtn.click();
    const modal = this.page.locator('[role="dialog"]').first();
    await modal.waitFor({ state: 'visible', timeout: 10_000 });

    // Wait for the loading spinner to disappear — the modal shows "Loading available users..."
    // with an ant-spin while fetching the list from the API. We must wait until list items appear.
    // Scoped to the modal so other Ant lists on the page can't satisfy this selector prematurely.
    await modal.locator('li.ant-list-item').first().waitFor({ state: 'visible', timeout: 20_000 });

    // Modal renders the eligible translators as an Ant Design List
    // (ul.ant-list-items > li.ant-list-item), each item containing the
    // translator email and its own "Assign" button.
    const translatorAssignBtn = modal
      .locator('li.ant-list-item')
      .filter({ hasText: translatorEmail })
      .locator('button:has-text("Assign")')
      .first();
    if (!(await translatorAssignBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
      throw new TranslatorNotFoundError(`Translator ${translatorEmail} not in popup`, {
        language,
      });
    }

    await translatorAssignBtn.click();
    // Verify success without re-reading the row (it moves out of the Waiting tab
    // on success). An Ant Design success toast ("Assigned successfully") appears
    // and the modal closes. A failure keeps the modal open with an error message.
    const successToast = this.page
      .locator('.ant-message-success, .ant-notification-notice-success')
      .first();
    const sawToast = await successToast
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    await modal.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
    const modalStillOpen = await modal.isVisible().catch(() => false);

    if (!sawToast && modalStillOpen) {
      throw new AssignmentFailedError('No success confirmation; modal still open after assign', {
        language,
        translatorEmail,
        rowIndex,
      });
    }
    this.logger.info('assignment submitted', {
      language,
      translatorEmail,
      confirmedBy: sawToast ? 'toast' : 'modal-closed',
    });
  }
}
