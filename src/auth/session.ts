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
  private lastCookieMtime = 0;

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
    const st = await fs.stat(cookiesPath).catch(() => null);
    this.lastCookieMtime = st?.mtimeMs ?? 0;
    await this.ensureLoggedIn();
    return this.page;
  }

  private async rebuildContext(): Promise<void> {
    const cookiesPath = this.settings.storage.cookiesPath;
    await this.context?.close().catch(() => {});
    this.context = await this.browser!.newContext({
      viewport: this.settings.browser.viewport,
      storageState: cookiesPath,
    });
    this.context.setDefaultNavigationTimeout(this.settings.browser.navigationTimeoutMs);
    this.page = await this.context.newPage();
    const st = await fs.stat(cookiesPath).catch(() => null);
    this.lastCookieMtime = st?.mtimeMs ?? this.lastCookieMtime;
  }

  async ensureLoggedIn(): Promise<void> {
    if (!this.page || !this.browser) throw new LoginFailedError('Session not started');
    const cookiesPath = this.settings.storage.cookiesPath;
    const st = await fs.stat(cookiesPath).catch(() => null);
    if (st && st.mtimeMs > this.lastCookieMtime) {
      this.logger.info('cookies.json changed on disk — rebuilding browser context to pick up new session');
      await this.rebuildContext();
    }
    await this.page.goto(JOB_BOARD_URL, { waitUntil: 'domcontentloaded' });
    if (this.page.url().includes(LOGIN_PAGE_INDICATOR)) {
      throw new LoginFailedError(`Session expired. Run 'npm run capture-cookies' to log in again.`);
    }
    this.logger.info('session valid (cookie-based)');
  }

  getPage(): Page {
    if (!this.page) throw new LoginFailedError('Session not started');
    return this.page;
  }

  isAlive(): boolean {
    return !!this.page && !this.page.isClosed();
  }

  /** Tear down a dead browser and start a fresh one (reuses cookie storageState). */
  async recover(): Promise<Page> {
    this.logger.warn('recovering browser session');
    try {
      await this.close();
    } catch {
      /* ignore close errors on an already-dead browser */
    }
    return this.start();
  }

  async close(): Promise<void> {
    // Teardown is best-effort: on Ctrl+C / shutdown the browser may already be
    // disconnecting, so close() can reject with a protocol error ("Failed to
    // find context"). Swallow it — there's nothing left to clean up and an
    // unhandled rejection here would make shutdown noisy / non-zero exit.
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}
