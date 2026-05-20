# Task 18: DOM Inspection Report

Date: 2026-05-20 (inspection run)
Logged-in user: (TMS_USERNAME from .env — redacted)
Test job ID inspected: none found (blocked at 2FA step)
Landing URL after credentials: https://www.translationtms.com/login (2FA page, not job-board)

---

## CRITICAL BLOCKER: Two-Factor Authentication

After filling email + password and clicking Submit, the site **does not redirect to job-board**.
Instead it shows a **Two-Factor Authentication** screen:

> "BIKAQIU Translation Platform — Two-Factor Authentication
> Please enter the 6-digit code from your Google Authenticator app
> [6-digit code input] [Verify] [Back to Login]"

Screenshot saved: `logs/screenshots/task-18/01-login.png`

**The bot's current `session.ts` `ensureLoggedIn()` has no TOTP/2FA handling.**
Until the TOTP secret is available (or the account has 2FA disabled), the bot **cannot log in programmatically**.

---

## Selector Verification

### 1. Login Page Selectors (CONFIRMED FROM LIVE DOM)

The login form DOM was fully captured before the 2FA screen appeared.

| Component | Current selector | Found in DOM? | Recommended |
|-----------|-----------------|---------------|-------------|
| Email input | `input[type="email"], input[name="email"], input[name="username"]` | ❌ ALL FAIL | `input#email` or `input[placeholder="Email address"]` |
| Password input | `input[type="password"], input[name="password"]` | ✅ Partial | `input[type="password"]` works; `input[name="password"]` fails |
| Submit button | `button[type="submit"], button:has-text("Login"), button:has-text("Sign in")` | ✅ Partial | `button[type="submit"]` works; text is "Sign In" not "Login" |
| Job board URL pattern | `/job-board\|dashboard/i` | ❌ | 2FA intercepts; URL stays `/login` until TOTP entry |

### Login Form Actual DOM Structure

```html
<!-- Email input -->
<input
  type="text"               <!-- NOT type="email" -->
  name=""                   <!-- NO name attribute -->
  id="email"                <!-- id="email" is the reliable selector -->
  placeholder="Email address"
  class="ant-input ant-input-lg css-1tp18n3"
/>

<!-- Password input -->
<input
  type="password"           <!-- type="password" WORKS -->
  name=""                   <!-- NO name attribute -->
  id="password"
  placeholder="Enter your password"
  class="ant-input ant-input-lg css-1tp18n3"
/>

<!-- Submit button -->
<button
  type="submit"             <!-- type="submit" WORKS -->
  class="ant-btn css-1tp18n3 ant-btn-primary ant-btn-color-primary ant-btn-variant-solid ant-btn-lg w-full"
>Sign In</button>           <!-- Text is "Sign In" (capital I) — "Sign in" also matches Playwright has-text -->
```

### 2FA Step DOM (Newly Discovered)

```html
<!-- After credentials submit, user lands on 2FA page (still /login URL) -->
<input placeholder="6-digit code" />  <!-- TOTP code input -->
<button>Verify</button>               <!-- 2FA submit button -->
<a>Back to Login</a>
```

### 2-8. Job Board and Later Selectors (NOT INSPECTED)

Could not reach job-board due to 2FA block. All downstream selectors are unverified:

| Component | Current selector | Found in DOM? | Recommended |
|-----------|-----------------|---------------|-------------|
| Job table | `table, [role="table"]` | not inspected | not inspected |
| Row cells | `td, [role="cell"]` — cells[0..7] | not inspected | not inspected |
| Language tags (cells[6]) | `[class*="tag"], span, .badge` | not inspected | not inspected |
| Open job link | `a[href*="job"], button[data-href]` | not inspected | not inspected |
| Next page button | `.ant-pagination-next:not(.ant-pagination-disabled) > button` | not inspected | not inspected |
| Word Count label | `text=Word Count` | not inspected | not inspected |
| Waiting tab | `text=Waiting` | not inspected | not inspected |
| Waiting lang row — lang | `td.nth(0)` | not inspected | not inspected |
| Waiting lang row — translator | `td.nth(2)` | not inspected | not inspected |
| Status cell | `[class*="status"], td:has-text("WAITING")` | not inspected | not inspected |
| Per-row Assign button | `button:has-text("Assign")` | not inspected | not inspected |
| Modal | `[role="dialog"], .modal` | not inspected | not inspected |
| Per-translator Assign (modal) | `xpath=.../ancestor::*[self::div or self::tr][1]//button[...]` | not inspected | not inspected |

---

## Diff to Apply

### CONFIRMED FIXES (from live DOM inspection)

**File:** `src/auth/session.ts:61`
**From:** `'input[type="email"], input[name="email"], input[name="username"]'`
**To:** `'#email, input[placeholder="Email address"], input[name="email"], input[type="email"]'`
**Reason:** The email input has `type="text"` (NOT `type="email"`) and has no `name` attribute. Only `#email` (by id) or `input[placeholder="Email address"]` reliably select it.

---

**File:** `src/auth/session.ts:62`
**From:** `'input[type="password"], input[name="password"]'`
**To:** `'input[type="password"], #password'`
**Reason:** `input[type="password"]` works. `input[name="password"]` fails (no name attribute). Add `#password` as fallback.

---

**File:** `src/auth/session.ts:65`
**From:** `'button[type="submit"], button:has-text("Login"), button:has-text("Sign in")'`
**To:** `'button[type="submit"], button:has-text("Sign In"), button:has-text("Sign in")'`
**Reason:** Button text is "Sign In" (capital I). Both `"Sign in"` and `"Sign In"` work with Playwright has-text in practice, but updating for clarity. The `button[type="submit"]` catches it first anyway.

---

**File:** `src/auth/session.ts` — NEW: Add 2FA handling between credentials submit and waitForURL

```typescript
// After clicking submit, check if we landed on 2FA page
await this.page.waitForTimeout(2000);
if (this.page.url().includes('/login')) {
  const totpInput = await this.page.$('input[placeholder*="6-digit" i], input[placeholder*="code" i]');
  if (totpInput) {
    if (!this.creds.totpSecret) {
      throw new LoginFailedError('2FA required but no TOTP secret configured');
    }
    // Use otpauth or speakeasy to generate current TOTP from secret
    const totp = generateTOTP(this.creds.totpSecret);
    await this.page.fill('input[placeholder*="6-digit" i], input[placeholder*="code" i]', totp);
    await Promise.all([
      this.page.waitForURL(/job-board|dashboard/i, { timeout: this.settings.browser.navigationTimeoutMs }),
      this.page.click('button:has-text("Verify"), button[type="submit"]'),
    ]);
  }
}
```

---

**File:** `src/auth/session.ts` — Move `waitForURL` to after 2FA step
**Reason:** With 2FA, clicking Submit keeps the URL at `/login` (showing the TOTP form). The current `waitForURL` races the click and times out because the URL does not change during the 2FA intermediate screen.

---

## Notes / Observations

### 2FA is the Primary Blocker

The account has Google Authenticator 2FA enabled. The `session.ts` bot code has no TOTP handling. Options to unblock:

1. **Add TOTP support** — Store the Google Authenticator TOTP secret key (not the rotating code) in `.env` as `TMS_TOTP_SECRET`. Use `otpauth` npm package (`npm install otpauth`) to compute current TOTP code. The 2FA form selector is `input[placeholder="6-digit code"]` and the submit button is `button:has-text("Verify")`.

2. **Disable 2FA on the account** — If the account owner controls this, the simplest fix.

3. **Use pre-saved session cookies** — The bot's cookie-restore path (`data/cookies.json`) will bypass login entirely if a valid session exists. An operator can manually log in via browser, export the session state, and populate that file. However sessions expire.

### Login Form Is Ant Design
Inputs are wrapped in `<span class="ant-input-affix-wrapper">` with icon prefixes. Playwright's `.fill()` correctly targets the inner `<input>` regardless, so the wrapping does not affect automation.

### "Sign in" vs "Sign In" — Playwright behavior
Playwright's `:has-text()` is NOT case-sensitive for substring matching (unlike CSS), so `button:has-text("Sign in")` DOES match a button containing "Sign In". The risk is low, but `button[type="submit"]` is the only reliable fallback here and it works.

### Screenshots
- `logs/screenshots/task-18/00-login-failed.png` — 2FA screen (first capture)
- `logs/screenshots/task-18/01-login.png` — 2FA screen post-submit (same page)
- `logs/screenshots/task-18/02-job-board.png` — Still shows login/2FA (redirect to job-board failed)

### lo-LA/km-KH job availability
Cannot determine — the job board was never reached.

### Assign modal safety
No Assign buttons were clicked at any stage. No job state was mutated.

---

## Summary of Required Code Changes

| Priority | File | Change | Reason |
|----------|------|--------|--------|
| CRITICAL | `src/auth/session.ts` | Add 2FA / TOTP handling | Bot cannot log in without it |
| HIGH | `src/auth/session.ts:61` | Fix email selector to `#email, input[placeholder="Email address"]` | `input[type="email"]` and `input[name="email"]` both fail — input type is "text", no name attr |
| MEDIUM | `src/auth/session.ts:62` | Add `#password` fallback | `input[name="password"]` fails (no name attr) |
| LOW | `src/auth/session.ts:65` | Change `"Sign in"` to `"Sign In"` | Cosmetic — `button[type="submit"]` catches it first anyway |
| LOW | `src/auth/session.ts:64` | Move `waitForURL` to after 2FA step | Prevents timeout during 2FA intermediate screen |
| DEFER | All downstream selectors | Unverifiable until 2FA is resolved | Need working session to inspect job-board DOM |
