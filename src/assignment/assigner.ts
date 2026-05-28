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

  /**
   * Select the Waiting TAB (role=tab) and wait for its table to settle. A plain
   * text= locator would match the "WAITING" status badge instead of the tab.
   * `requireRows` waits for at least one row (used before locating a row to
   * assign); skip it when the tab may legitimately be empty (post-assign re-read).
   */
  private async selectWaitingTab(requireRows: boolean): Promise<void> {
    const waitingTab = this.page.getByRole('tab', { name: 'Waiting', exact: true });
    if (await waitingTab.isVisible().catch(() => false)) {
      await waitingTab.click();
      await this.page.waitForSelector('.ant-spin-spinning', { state: 'hidden', timeout: 10_000 }).catch(() => {});
      if (requireRows) {
        await this.page.waitForSelector('table tbody tr', { timeout: 10_000 }).catch(() => {});
      } else {
        await this.page.waitForTimeout(500); // brief settle; the tab may now be empty
      }
    }
  }

  async assign(
    language: SupportedLanguage,
    assignee: string,
    rowIndex: number,
    expectClearedStatus: string = 'WAITING_TRANSLATION',
    role: 'translator' | 'reviewer' = 'translator'
  ): Promise<void> {
    // Re-select the Waiting tab in case a prior assignment switched tabs.
    await this.selectWaitingTab(true);

    // Locate the target row by language text (not by index — index shifts after assignments)
    const row = this.page.locator('table tbody tr').filter({ hasText: language }).first();
    const assignBtn = row.locator('button:has-text("Assign")').first();
    if (!(await assignBtn.isVisible())) {
      throw new AssignmentFailedError('Assign button not visible', { language, rowIndex });
    }

    if (this.dryRun) {
      this.logger.info('[DRY-RUN] would click Assign', { language, role, assignee, rowIndex });
      return;
    }

    await assignBtn.click();
    const modal = this.page.locator('[role="dialog"]').first();
    await modal.waitFor({ state: 'visible', timeout: 10_000 });

    // Wait for the loading spinner to disappear — the modal shows "Loading available users..."
    // with an ant-spin while fetching the list from the API. We must wait until list items appear.
    // Scoped to the modal so other Ant lists on the page can't satisfy this selector prematurely.
    await modal.locator('li.ant-list-item').first().waitFor({ state: 'visible', timeout: 20_000 });

    // Modal renders the eligible users (translators or reviewers) as an Ant
    // Design List (ul.ant-list-items > li.ant-list-item), each item containing
    // the user's email and its own "Assign" button.
    const assigneeBtn = modal
      .locator('li.ant-list-item')
      .filter({ hasText: assignee })
      .locator('button:has-text("Assign")')
      .first();
    if (!(await assigneeBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
      throw new TranslatorNotFoundError(`${role} ${assignee} not in popup`, {
        language,
      });
    }

    await assigneeBtn.click();
    // The Ant success toast selector is unverified against a real assign, so it
    // is only a fast-path hint — never the sole proof of success.
    const sawToast = await this.page
      .locator('.ant-message-success, .ant-notification-notice-success')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    await modal.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
    if (await modal.isVisible().catch(() => false)) {
      // Modal still open ⇒ the assign did not go through (error stayed in the dialog).
      throw new AssignmentFailedError('modal still open after assign', {
        language,
        role,
        assignee,
        rowIndex,
      });
    }

    // Positive verification independent of the unverified toast: on a real
    // assign the row leaves the Waiting tab. Re-read it; if a row for this
    // language is still WAITING_TRANSLATION, the assign did NOT take — fail so
    // the caller retries instead of silently recording a false success.
    await this.selectWaitingTab(false);
    const stillWaitingRow = () =>
      this.page
        .locator('table tbody tr')
        .filter({ hasText: language })
        .filter({ hasText: expectClearedStatus })
        .count()
        .catch(() => 0);
    // Poll briefly: the Waiting list can take a moment to drop the assigned row.
    // Succeed as soon as it clears rather than failing on one slow read (which
    // would cause a needless retry + false failure metric).
    let stillWaiting = await stillWaitingRow();
    const deadline = Date.now() + 3_000;
    while (stillWaiting > 0 && Date.now() < deadline) {
      await this.page.waitForTimeout(300);
      stillWaiting = await stillWaitingRow();
    }
    if (stillWaiting > 0) {
      throw new AssignmentFailedError(`row still ${expectClearedStatus} after assign — not confirmed`, {
        language,
        role,
        assignee,
        rowIndex,
      });
    }

    this.logger.info('assignment submitted', {
      language,
      role,
      assignee,
      confirmedBy: sawToast ? 'toast' : 'row-cleared',
    });
  }
}
