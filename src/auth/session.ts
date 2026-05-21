import { chromium } from 'playwright-extra';
// @ts-ignore — puppeteer-extra plugin types
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import { promises as fs } from 'fs';
import type { Settings } from '../types/index.js';
import { LoginFailedError } from '../core/errors.js';
import type winston from 'winston';

chromium.use(StealthPlugin());

const JOB_BOARD_URL = 'https://www.translationtms.com/job-board';
const LOGIN_PAGE_INDICATOR = '/login';

export class AuthSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  constructor(
    private settings: Settings,
    private logger: winston.Logger
  ) {}

  async start(): Promise<Page> {
    const cookiesPath = this.settings.storage.cookiesPath;
    try {
      await fs.access(cookiesPath);
    } catch {
      throw new LoginFailedError(
        `Cookies file not found at ${cookiesPath}. Run 'npm run capture-cookies' to log in manually first.`
      );
    }

    this.browser = await chromium.launch({ headless: this.settings.browser.headless });
    this.context = await this.browser.newContext({
      viewport: this.settings.browser.viewport,
      storageState: cookiesPath,
    });
    this.context.setDefaultNavigationTimeout(this.settings.browser.navigationTimeoutMs);
    this.page = await this.context.newPage();
    await this.ensureLoggedIn();
    return this.page;
  }

  async ensureLoggedIn(): Promise<void> {
    if (!this.page) throw new LoginFailedError('Session not started');
    await this.page.goto(JOB_BOARD_URL, { waitUntil: 'domcontentloaded' });
    if (this.page.url().includes(LOGIN_PAGE_INDICATOR)) {
      throw new LoginFailedError(
        `Session expired. Run 'npm run capture-cookies' to log in again.`
      );
    }
    this.logger.info('session valid (cookie-based)');
  }

  getPage(): Page {
    if (!this.page) throw new LoginFailedError('Session not started');
    return this.page;
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
  }
}
