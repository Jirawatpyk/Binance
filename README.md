# Translation TMS Auto-Assign Bot

Auto-assign bot สำหรับ [translationtms.com](https://www.translationtms.com) — polling งานภาษา `lo-LA` / `km-KH` แล้ว assign translator อัตโนมัติตาม word-count mapping

## Setup

```powershell
npm install
npx playwright install chromium
Copy-Item config\settings.example.yml config\settings.yml
Copy-Item config\translators.example.yml config\translators.yml
Copy-Item .env.example .env
# แก้ .env ใส่ credential จริง
# แก้ config/translators.yml ใส่ mapping จริง
```

## Run

```powershell
# Development (visible browser, watch mode)
npm run dev

# Production (build + run)
npm run build
npm start

# Smoke test (login only)
npm run smoke
```

## Configuration

- `config/settings.yml` — runtime settings (polling interval, browser, paths)
- `config/translators.yml` — word-count → translator mapping
- `.env` — `TMS_USERNAME` / `TMS_PASSWORD`

### Dry-Run

Set `assignment.dryRun: true` in `config/settings.yml` to test without actually clicking Assign.

## Deploy

### Windows Service

```powershell
# Admin PowerShell
npm run service:install
Get-Service BinanceTranslationBot
```

Uninstall: `npm run service:uninstall`

### Docker

```powershell
docker-compose up -d
docker-compose logs -f
```

## Logs

- `logs/app-YYYY-MM-DD.log` — structured JSON logs
- `logs/error-YYYY-MM-DD.log` — errors only
- `logs/screenshots/YYYY-MM-DD/` — error screenshots

## Tests

```powershell
npm test                    # unit tests (vitest)
npm run test:integration    # integration tests (Playwright)
```

## Spec & Plan

- Spec: `docs/superpowers/specs/2026-05-20-translation-tms-auto-assign-bot-design.md`
- Plan: `docs/superpowers/plans/2026-05-20-translation-tms-auto-assign-bot.md`
