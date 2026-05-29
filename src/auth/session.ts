import { chromium } from 'playwright-extra';
// @ts-ignore — puppeteer-extra plugin types
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import { promises as fs } from 'fs';
import type { Settings } from '../types/index.js';
import { LoginFailedError } from '../core/errors.js';
import { jwtExpiryMs } from './jwt.js';
import { classifyAuthState } from './auth-state.js';
import type winston from 'winston';

chromium.use(StealthPlugin());

const JOB_BOARD_URL = 'https://www.translationtms.com/job-board';
const LOGIN_PAGE_INDICATOR = '/login';
// A dead cookie session renders the board briefly, then redirects to /login
// CLIENT-SIDE (after hydration, ~1-2s). So we can't decide auth from the first
// frame — we wait this long for the login form to appear; if it never does, the
// session is valid. Healthy ticks pay this latency once per tick (every few
// minutes), which is acceptable for correct re-auth detection.
const LOGIN_REDIRECT_PROBE_MS = 6_000;
// TMS intermittently bounces to /login during transient auth-endpoint hiccups
// while the session is still live. Re-probe a few times before trusting a
// /login redirect, so a momentary blip doesn't pause the bot (which then needs a
// manual restart). A genuinely dead session keeps reading EXPIRED across probes.
const AUTH_PROBE_ATTEMPTS = 3;
const AUTH_PROBE_RETRY_MS = 3_000;

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
    for (let attempt = 1; attempt <= AUTH_PROBE_ATTEMPTS; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, AUTH_PROBE_RETRY_MS));
      await this.page.goto(JOB_BOARD_URL, { waitUntil: 'domcontentloaded' });

      // This is an Ant Design SPA: when the cookie session is dead it renders the
      // board for a moment, then redirects to /login CLIENT-SIDE after hydration.
      // Checking the URL right after domcontentloaded races that redirect and
      // reports a false "valid" — so wait briefly for the login form to surface.
      const loginFormAppeared = await this.page
        .waitForSelector('input[type="password"]', { timeout: LOGIN_REDIRECT_PROBE_MS })
        .then(() => true)
        .catch(() => false);
      const loginDetected = loginFormAppeared || this.page.url().includes(LOGIN_PAGE_INDICATOR);
      const authExpMs = await this.getAuthExpiryMs();
      const classification = classifyAuthState({ loginDetected, authExpMs, now: Date.now() });

      if (classification === 'VALID') {
        this.logger.info('session valid (cookie-based)');
        return;
      }

      this.logger.warn('auth probe not valid', { attempt, classification, authExpMs });
      if (attempt < AUTH_PROBE_ATTEMPTS) continue; // reload and re-probe

      if (classification === 'EXPIRED') {
        throw new LoginFailedError(`Session expired. Run 'npm run capture-cookies' to log in again.`);
      }
      // RETRY on the final attempt: /login persists but the access token is still
      // live. Pausing would demand a manual restart for a session that isn't dead,
      // so don't pause — let this tick's scan proceed/fail and retry next tick.
      // Logged at error level (lands in error-*.log) so a sustained occurrence —
      // TMS auth endpoint degraded while the token is still valid — is visible,
      // since this path deliberately does not surface as PAUSED_AUTH.
      this.logger.error('login redirect persists across probes but access token still valid — TMS auth may be degraded; treating as transient, not pausing');
      return;
    }
  }

  getPage(): Page {
    if (!this.page) throw new LoginFailedError('Session not started');
    return this.page;
  }

  /**
   * Persist the CURRENT browser session (cookies + localStorage, incl. any JWT
   * the TMS app refreshed client-side this tick) back to cookies.json — so a
   * restart reloads the latest token instead of the stale captured snapshot.
   * We bump lastCookieMtime so this self-write doesn't trip the "cookies changed
   * on disk → rebuild context" check in ensureLoggedIn. Best-effort.
   */
  async saveSession(): Promise<void> {
    if (!this.context) return;
    const cookiesPath = this.settings.storage.cookiesPath;
    await this.context.storageState({ path: cookiesPath });
    const st = await fs.stat(cookiesPath).catch(() => null);
    if (st) this.lastCookieMtime = st.mtimeMs;
  }

  /**
   * Renew the access token by calling the TMS refresh endpoint with the stored
   * refresh_token, FROM THE PAGE CONTEXT (same origin, so localStorage + the
   * relative /cms/... fetch both work, whether the page is on the board or
   * /login). On success the new access token (stored under the `auth_token`
   * localStorage key — the one getAuthExpiryMs reads) and the rotated
   * refresh_token are written to localStorage AND persisted to cookies.json
   * immediately — so an on-expiry recovery (ReAuthManager.tryRefresh, which runs
   * at the START of a tick) never leaves the rotated refresh_token unsaved if a
   * later step in that tick throws before the end-of-tick save (a restart would
   * then load the now-rotated-away token and pause). Doing the writes in-page
   * means saveSession can only snapshot the NEW tokens (no stale overwrite). The
   * persist is best-effort: a failure is logged at error (the tick's counted save
   * is the backstop), never thrown. Returns true only when a new access token was
   * stored. Never throws.
   */
  async refreshAccessToken(): Promise<boolean> {
    if (!this.page) return false;
    // The in-page fetch carries an AbortSignal.timeout so a stalled/black-holed
    // refresh endpoint can't hang forever; the outer Promise.race is a backstop
    // in case page.evaluate itself wedges (page.evaluate has no built-in
    // timeout). Either way a hung refresh resolves false within ~15s instead of
    // blocking the whole tick until the watchdog hard-exits the process — this
    // runs in two hot paths (proactive renew + ReAuthManager.tryRefresh before
    // pausing), both inside the watchdog window.
    const evaluatePromise = this.page
      .evaluate(async () => {
        try {
          const rt = window.localStorage.getItem('refresh_token');
          if (!rt) return false;
          const res = await fetch('/cms/i18n/tsc/admin/be/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: rt }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) return false;
          const data = await res.json();
          if (!data || !data.access_token) return false;
          window.localStorage.setItem('auth_token', data.access_token);
          if (data.refresh_token) window.localStorage.setItem('refresh_token', data.refresh_token);
          return true;
        } catch {
          return false;
        }
      })
      .catch(() => false);
    const ok = await Promise.race([
      evaluatePromise,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000)),
    ]);
    if (ok) {
      // Persist the rotated tokens NOW (best-effort) so an on-expiry refresh isn't
      // lost if a later step in this tick throws. Failure is logged at error (not
      // swallowed) — the tick's counted/alerted saveSession is the backstop.
      try {
        await this.saveSession();
      } catch (e) {
        this.logger.error(
          'refreshed the access token but persisting it to cookies.json failed — a restart before the next successful save would load a stale token',
          { error: (e as Error).message }
        );
      }
      this.logger.info('access token refreshed via refresh_token');
    } else {
      this.logger.warn('access token refresh failed (refresh_token invalid/expired or endpoint error)');
    }
    return ok;
  }

  /** Expiry (epoch ms) of the live auth_token in the page's localStorage, or null. */
  async getAuthExpiryMs(): Promise<number | null> {
    if (!this.page) return null;
    const token = await this.page
      .evaluate(() => window.localStorage.getItem('auth_token'))
      .catch(() => null);
    return jwtExpiryMs(token);
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
    await this.context
      ?.close()
      .catch((e) => this.logger.debug('context close failed during teardown', { error: (e as Error).message }));
    await this.browser
      ?.close()
      .catch((e) => this.logger.debug('browser close failed during teardown', { error: (e as Error).message }));
  }
}
