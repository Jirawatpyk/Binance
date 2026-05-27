# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Auto-assign bot for **translationtms.com** (BIKAQIU Translation). It polls the Job Board, finds unassigned `lo-LA` (Lao) and `km-KH` (Khmer) language rows on recently-created jobs, and assigns a translator chosen by word-count rules. Built with Playwright + TypeScript. Phase 2 (not yet built) is a tracking dashboard.

- **Spec:** `docs/superpowers/specs/2026-05-20-translation-tms-auto-assign-bot-design.md`
- **Plan:** `docs/superpowers/plans/2026-05-20-translation-tms-auto-assign-bot.md`
- **Live DOM findings** (selectors, cell indices, modal structure): `docs/superpowers/specs/2026-05-20-task-18-dom-inspection-report.md` — read this before touching any scraper/assigner selector.

## Commands

```powershell
npm install
npx playwright install chromium      # one-time browser download

npm run dev                          # run bot (tsx watch) against config/settings.yml
npm start                            # run built bot (needs npm run build first)
npm run build                        # tsc → dist/
npm run typecheck                    # tsc --noEmit

npm test                             # vitest unit tests (run once)
npm run test:watch                   # vitest watch
npx vitest run tests/unit/assignment-engine.test.ts          # single test FILE
npx vitest run -t "round-robin wraps using modulo"           # single test by name

npm run capture-cookies              # MUST run first — manual login (see 2FA below)
npm run smoke                        # login-only sanity check
npm run service:install              # install as Windows service (Admin PowerShell)
```

There is no linter configured; `npm run typecheck` is the static gate. Unit tests cover only the pure-logic layer (`AssignmentEngine`, `StateStore`, config loader) — browser code (`scraper/`, `auth/`, `assignment/assigner.ts`) has no automated tests and is verified by running `npm run dev` with `dryRun: true`.

## Authentication — 2FA requires cookie capture first

The TMS account has Google Authenticator 2FA, so the bot **cannot** log in with a password. Instead:

1. `npm run capture-cookies` opens a visible browser; a human logs in (incl. the 6-digit code). On reaching the Job Board it saves `data/cookies.json`.
2. The bot (`AuthSession`) loads those cookies. If the session is expired it throws and tells you to re-run `capture-cookies` — it never attempts a password login.

`AuthSession` takes `(settings, logger)` — there are no credential parameters.

## Runtime config (not in git)

- `config/settings.yml` — runtime knobs. **`assignment.dryRun` controls whether real assignments happen.** `dryRun: true` only logs "would assign"; `dryRun: false` clicks Assign for real. The example file ships `dryRun: true` deliberately — flipping to `false` assigns on the live production system, so do it only intentionally.
- `config/translators.yml` — word-count → translator mapping (tiered rules + round-robin). Translator values must be valid emails (zod-validated). Real translators: lo-LA = `LO_T1/LO_T3/LO_T4@eqho.com`; km-KH = `kh_t1/kh_t2/kh_t3/kh_e2/kh_e3@eqho.com`.
- `.env` — `GOOGLE_CHAT_WEBHOOK_URL` (optional notifications). TMS credentials are no longer used (cookie-based).

`*.yml` working copies, `.env`, `data/`, and `logs/` are gitignored; only the `*.example.yml` files are committed. Bootstrap with `Copy-Item config\settings.example.yml config\settings.yml` etc.

## Architecture

One pass of work is a **tick**, orchestrated in `src/index.ts`. The `Scheduler` fires the first tick immediately, then repeats every `polling.intervalMinutes` (with jitter), skipping a tick if the previous one is still running. Each tick:

1. `AuthSession.ensureLoggedIn()` — verify the cookie session still reaches the Job Board.
2. `JobScanner.scan()` — set the board filters server-side (status "Available to Claim", then iterate the language filter for `lo-LA` and `km-KH`, plus a "Created" date filter from `scan.lookbackHours`), paginate, dedupe by job id, cap at `scan.maxCandidatesPerTick`. **Filtering happens via the board's own filter UI, not by reading a row's language tags** — the board only renders ~3 visible tags + a `+N` overflow, so lo-LA/km-KH are usually hidden and cannot be detected from the row.
3. For each candidate, `JobProcessor.open()` reads the detail page's Waiting tab and returns the `lo-LA`/`km-KH` rows with their status + current translator.
4. For each row still `WAITING_TRANSLATION` with no translator: `AssignmentEngine.pick(lang, wordCount)` chooses the translator (pure logic), `Assigner.assign()` clicks through the modal, and `StateStore` records the result. A successful real assignment also posts to Google Chat.

**Idempotency via `StateStore` (`data/state.json`):** a job is marked `FULL` (skipped forever) only when every language assigned; `PARTIAL` jobs are re-attempted next tick (only the still-unassigned languages, re-checked live). Round-robin counters live here too and are not advanced in dry-run.

**Layer boundary that matters:** `AssignmentEngine` is pure (no Playwright) and fully unit-tested; it takes an `RRReader` so `StateStore` plugs in without coupling. Keep selection logic there and browser interaction in `scraper/` + `assigner.ts`. Cross-cutting helpers live in `src/core/` (`scheduler`, `logger`, `retry`, `lock`, `screenshot`, `errors`).

## Working with the live site (important gotchas)

- **The UI is Ant Design.** Selectors depend on Ant classes (`.ant-select`, `li.ant-list-item`, `.ant-modal`, `.ant-spin-spinning`). After clicking a filter/search, wait for `.ant-spin-spinning` to be hidden before reading the table.
- **Job Board rows have a leading star-icon column**, so data cells are 1-indexed: id=`cells[1]`, name=`cells[2]`, created=`cells[4]`, project=`cells[5]`, langCount=`cells[6]`, langTags=`cells[7]`, wordCount=`cells[8]`. Detail URL pattern is `/job/<id>`.
- **The Assign modal lists translators as `ul.ant-list-items > li.ant-list-item`** (not a table) and loads them async behind a spinner — `assigner.ts` waits for `li.ant-list-item` first, then locates a translator's button via `li.ant-list-item` filtered by email. Success is confirmed by the Ant success toast / modal close, not by re-reading the row (the row moves to the In Progress tab on success).
- **Verifying a selector change requires the live site.** Don't guess against the real DOM — drive it with cookies in `dryRun: true` and read the logs/screenshots (`logs/screenshots/`). Errors during a tick capture a screenshot and continue rather than crash the scheduler.

## Conventions

- ESM TypeScript (`"type": "module"`, `NodeNext`); import local modules with the `.js` extension. Node 20+ (uses global `fetch`).
- Structured JSON logs via winston (`logs/app-*.log`, `logs/error-*.log`) — kept JSON-structured intentionally so the Phase 2 dashboard can ingest them.
- Commit style: Conventional Commits (`feat(scope):`, `fix(scope):`, `docs(scope):`); small, single-purpose commits.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
<!-- SPECKIT END -->
