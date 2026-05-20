import { chromium } from 'playwright-extra';
// @ts-ignore — puppeteer-extra plugin types aren't bundled
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';
import type { Settings } from '../types/index.js';
import { LoginFailedError } from '../core/errors.js';
import type winston from 'winston';

chromium.use(StealthPlugin());

const LOGIN_URL = 'https://www.translationtms.com/login';
const JOB_BOARD_URL = 'https://www.translationtms.com/job-board';

export interface Credentials {
  username: string;
  password: string;
}

export class AuthSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  constructor(
    private settings: Settings,
    private creds: Credentials,
    private logger: winston.Logger
  ) {}

  async start(): Promise<Page> {
    this.browser = await chromium.launch({ headless: this.settings.browser.headless });
    const cookiesPath = this.settings.storage.cookiesPath;
    const contextOptions: Parameters<Browser['newContext']>[0] = {
      viewport: this.settings.browser.viewport,
    };
    try {
      await fs.access(cookiesPath);
      contextOptions.storageState = cookiesPath;
      this.logger.info('loaded existing session cookies', { cookiesPath });
    } catch {
      this.logger.info('no existing cookies; will login fresh');
    }
    this.context = await this.browser.newContext(contextOptions);
    this.context.setDefaultNavigationTimeout(this.settings.browser.navigationTimeoutMs);
    this.page = await this.context.newPage();
    await this.ensureLoggedIn();
    return this.page;
  }

  async ensureLoggedIn(): Promise<void> {
    if (!this.page || !this.context) throw new LoginFailedError('Session not started');
    await this.page.goto(JOB_BOARD_URL, { waitUntil: 'domcontentloaded' });
    if (!this.page.url().includes('/login')) {
      this.logger.info('session still valid');
      return;
    }
    this.logger.info('session expired or absent; performing login');
    await this.page.goto(LOGIN_URL);
    await this.page.fill('input[type="email"], input[name="email"], input[name="username"]', this.creds.username);
    await this.page.fill('input[type="password"], input[name="password"]', this.creds.password);
    await Promise.all([
      this.page.waitForURL(/job-board|dashboard/i, { timeout: this.settings.browser.navigationTimeoutMs }),
      this.page.click('button[type="submit"], button:has-text("Login"), button:has-text("Sign in")'),
    ]);
    if (this.page.url().includes('/login')) {
      throw new LoginFailedError('Still on login page after submit');
    }
    await fs.mkdir(path.dirname(this.settings.storage.cookiesPath), { recursive: true });
    await this.context.storageState({ path: this.settings.storage.cookiesPath });
    this.logger.info('login successful; cookies saved');
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
