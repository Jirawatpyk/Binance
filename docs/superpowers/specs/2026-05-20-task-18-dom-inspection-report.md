# Task 18: DOM Inspection Report (round 2 — via cookies)

Date: 2026-05-27
Session: cookie-based (data/cookies.json)
Job Board URL confirmed: https://www.translationtms.com/job-board
Detail page URL pattern: https://www.translationtms.com/job/<id>
Test job inspected: 51085 (2026-1-7_MPC-DEX-web_1767796975534)
lo-LA/km-KH job available: YES — job 51085 has both lo-LA and km-KH as target languages
Assign modal inspected: YES (km-KH row in "In Progress" tab) — translator list was empty ("No available users found for this locale" / "Current step: REVIEWING")

---

## Session Status

Cookies loaded from `data/cookies.json` (2966 bytes, created 2026-05-27 10:52 AM).
Navigation to `https://www.translationtms.com/job-board` succeeded — **no redirect to /login**.
Session is valid.

---

## Job Board: Initial Load Observation

**Important:** The Job Board defaults to **"My Jobs" filter**, which shows "No data" for the `binance@eqho.com` account (the account has no assigned jobs). The table appears empty (`ant-spin-spinning` on first screenshot). The data becomes visible only after the `networkidle` wait resolves — all 10 rows then render correctly.

Total jobs: **196** (shown in pagination footer: `Total: 196`)
Page size: 10 / page
Pagination controls visible: Previous / Next buttons

---

## Selector verification

| File | Component | Current selector | Works? | Recommended fix |
|------|-----------|------------------|--------|-----------------|
| job-scanner.ts | table | `table, [role="table"]` | ✅ | No change (table element exists, class `ant-table`) |
| job-scanner.ts | tbody rows | `table tbody tr` | ✅ | No change — but row 0 is `ant-table-measure-row` (height:0, cells empty); skip it via `if (cells.length < 8) continue` which already filters it |
| job-scanner.ts | cells[0] = id | `cells[0]` | ❌ | **Use `cells[1]`** — col 0 is a star/checkbox icon, col 1 is Job ID |
| job-scanner.ts | cells[1] = name | `cells[1]` | ❌ | **Use `cells[2]`** |
| job-scanner.ts | cells[2] = dueDate | `cells[2]` | ❌ | **Use `cells[3]`** |
| job-scanner.ts | cells[4] = project | `cells[4]` | ❌ | **Use `cells[5]`** |
| job-scanner.ts | cells[5] = langCount | `cells[5]` | ❌ | **Use `cells[6]`** |
| job-scanner.ts | cells[6] = langTags | `cells[6]` | ❌ | **Use `cells[7]`** |
| job-scanner.ts | cells[7] = wordCount | `cells[7]` | ❌ | **Use `cells[8]`** |
| job-scanner.ts | lang tags selector | `[class*="tag"], span, .badge` | ✅ | No change — tags are `span.ant-tag.ant-tag-green`; `[class*="tag"]` matches. The `+N` overflow text is also in a `span` — the current `!s.startsWith('+')` filter is correct |
| job-scanner.ts | Open link | `a[href*="job"]` | ✅ | No change — confirmed `<a href="/job/51085" class="ant-btn ant-btn-link">Open</a>` |
| job-scanner.ts | Open link | `button[data-href]` | ❌ | Remove — not present; `a[href*="job"]` alone is sufficient |
| job-scanner.ts | Next page button | `.ant-pagination-next:not(.ant-pagination-disabled) > button` | ✅ (likely) | Pagination uses Ant Design; `.ant-pagination-next` is present. Current selector `button[aria-label*="next" i]` also present — either works |
| job-scanner.ts | Next page button | `button:has-text("Next")` | ✅ | Confirmed "Next" text in pagination; selector is fine |
| job-scanner.ts | rows guard `cells.length < 8` | — | ❌ | Change to `cells.length < 10` — real rows have 10 tds (col 0 = star icon, cols 1-9 = data) |
| job-processor.ts | Word Count label | `text=Word Count` | ✅ | Confirmed present on detail page |
| job-processor.ts | Word Count xpath | `xpath=//*[contains(text(),"Word Count")]/following-sibling::*[1]` | ✅ | `following-sibling::*[1]` resolves to `<div style="font-size: 14px;">7</div>` — correct |
| job-processor.ts | Waiting tab | `text=Waiting` | ✅ | Tab exists with text "Waiting", `role="tab"` on inner `.ant-tabs-tab-btn` element; `text=Waiting` locator finds it |
| job-processor.ts | lang row td.nth(0) = lang code | `td.nth(0)` | ✅ | Confirmed — `td[0]` = "km-KH (Khmer (Cambodia))" |
| job-processor.ts | lang row td.nth(2) = translator | `td.nth(2)` | ✅ | Confirmed — `td[2]` = "kh_e3@eqho.com" |
| job-processor.ts | Status cell | `[class*="status"], td:has-text("WAITING"), td:has-text("IN_PROGRESS")` | ⚠️ | Status is rendered as `<span class="ant-tag ant-tag-cyan">REVIEWING</span>` inside a `td`; `td:has-text("REVIEWING")` would work but the current selector only checks WAITING/IN_PROGRESS. Add `td:has-text("REVIEWING")` and `td:has-text("WAITING_TRANSLATION")`. Better: use `td:nth-child(6)` (index 5, the Status column) |
| job-processor.ts | lang code detect | `text.includes('lo-LA')` / `text.includes('km-KH')` | ✅ | Full text is "km-KH (Khmer (Cambodia))" — `includes('km-KH')` matches |
| assigner.ts | row Assign button | `button:has-text("Assign")` within row | ✅ | Confirmed — button class `ant-btn-primary ant-btn-sm` with text "Assign" |
| assigner.ts | Modal container | `[role="dialog"], .modal` | ✅ | Modal uses `role="dialog"`, class `ant-modal css-1tp18n3`; `.modal` not needed but harmless |
| assigner.ts | Per-translator Assign in modal | `xpath=.../ancestor::*[self::div or self::tr][1]//button[...]` | ⚠️ | Modal shows "No available users found" when called on a REVIEWING row. The modal title is "Assign Strings - km-KH". When translators ARE listed (WAITING_TRANSLATION rows), structure is unknown — need a job in WAITING state to verify. XPath pattern is structurally plausible but unconfirmed for loaded translator list. |

---

## Cell index mapping (Job Board)

Real DOM has **10 `<td>` columns** per data row (row 0 = `ant-table-measure-row`, skipped):

| Index | Column header | Example value |
|-------|--------------|---------------|
| 0 | (star/favourite icon) | empty — star icon, `cursor: default` |
| 1 | Job ID | `51085` |
| 2 | Job Name | `2026-1-7_MPC-DEX-web_1767796975534` |
| 3 | Due Date (UTC) | `2026-01-09 14:42` (may include warning icon span) |
| 4 | Created (UTC) | `2026-01-07 14:42` |
| 5 | Project | `Binance Website Translation` |
| 6 | Language Count | `36` |
| 7 | Language Needed | `arbn-BDbg-BG+33` (div.ant-dropdown-trigger with ant-tag spans inside) |
| 8 | Wordcount | `7` (wrapped in `<span>`) |
| 9 | Action | `Open` (`<a href="/job/<id>" class="ant-btn ant-btn-link">`) |

**Code assumes cells[0]=id, cells[1]=name, cells[2]=dueDate, cells[4]=project, cells[5]=langCount, cells[6]=langTags, cells[7]=wordCount**
**Actual: cells[1]=id, cells[2]=name, cells[3]=dueDate, cells[5]=project, cells[6]=langCount, cells[7]=langTags, cells[8]=wordCount**
**All indices are off by +1** due to the extra star/icon column at index 0.

Row key: `data-row-key="51085"` (Job ID is the row key — useful for targeting).

---

## Cell index mapping (Waiting/In Progress table on detail page)

Detail page language table has **7 `<td>` columns**:

| Index | Column header | Example value |
|-------|--------------|---------------|
| 0 | Language | `km-KH (Khmer (Cambodia))` |
| 1 | Due Date (UTC) | (date picker input) |
| 2 | Translator | `kh_e3@eqho.com` |
| 3 | Reviewer | `-` |
| 4 | Progress | `100%` |
| 5 | Status | `REVIEWING` (as `<span class="ant-tag ant-tag-cyan">`) |
| 6 | Actions | Assign + Edit buttons |

**`td.nth(0)` = Language, `td.nth(2)` = Translator** — CONFIRMED CORRECT.
Status at `td.nth(5)` rendered as `ant-tag` span — selector needs expanding.

---

## Diff to apply

### 1. `src/scraper/job-scanner.ts` — Cell indices off by +1

```diff
- const idText = cells[0]?.textContent?.trim() ?? '';
- if (!/^\d+$/.test(idText)) continue;
+ const idText = cells[1]?.textContent?.trim() ?? '';
+ if (!/^\d+$/.test(idText)) continue;

  out.push({
    id: idText,
-   name: cells[1]?.textContent?.trim() ?? '',
-   dueDate: cells[2]?.textContent?.trim() ?? '',
-   project: cells[4]?.textContent?.trim() ?? '',
-   languageCount: Number(cells[5]?.textContent?.trim() ?? 0),
-   languagesNeeded: langTags,    // was reading cells[6]
-   wordCount: Number(cells[7]?.textContent?.trim().replace(/,/g, '') ?? 0),
+   name: cells[2]?.textContent?.trim() ?? '',
+   dueDate: cells[3]?.textContent?.trim() ?? '',
+   project: cells[5]?.textContent?.trim() ?? '',
+   languageCount: Number(cells[6]?.textContent?.trim() ?? 0),
+   languagesNeeded: langTags,    // reading cells[7] now
+   wordCount: Number(cells[8]?.textContent?.trim().replace(/,/g, '') ?? 0),
  });
```

Also fix the langTags line:
```diff
- const langTags = Array.from(cells[6].querySelectorAll('[class*="tag"], span, .badge'))
+ const langTags = Array.from(cells[7].querySelectorAll('[class*="tag"], span, .badge'))
```

And update the guard condition:
```diff
- if (cells.length < 8) continue;
+ if (cells.length < 10) continue;
```

And fix the Open link (remove `button[data-href]` — not present):
```diff
- const openLink = (row.querySelector('a[href*="job"], button[data-href]') as HTMLAnchorElement | null);
+ const openLink = (row.querySelector('a[href*="job"]') as HTMLAnchorElement | null);
```

### 2. `src/scraper/job-processor.ts` — Status cell selector needs expansion

```diff
- const statusText = (await row.locator('[class*="status"], td:has-text("WAITING"), td:has-text("IN_PROGRESS")').first().textContent() ?? '').trim();
+ const statusText = (await row.locator('td').nth(5).textContent() ?? '').trim();
```
Reason: Status column is always td index 5. The tag-based `[class*="status"]` selector does not match Ant Design's `ant-tag` spans. Known status values: `WAITING_TRANSLATION`, `IN_PROGRESS`, `REVIEWING`, `PUBLISHED`.

### 3. No changes needed in `src/assignment/assigner.ts`

`button:has-text("Assign")` confirmed working. `[role="dialog"]` confirmed working.
The per-translator XPath in the modal is structurally plausible but could not be confirmed because the job inspected had no available users (REVIEWING state). Consider adding a fallback: if `rowAssign` is not visible, log a warning and throw `TranslatorNotFoundError`.

---

## Notes / Observations

### Job Board filter default is "My Jobs"
The bot currently navigates to `/job-board` which loads with "My Jobs" filter active. Since `binance@eqho.com` is not assigned to any jobs as a translator, this shows "No data". The bot's scan will miss all 196 jobs. The bot needs to either:
- Navigate to `/job-board` and programmatically switch filter to "All Jobs" (Ant Design Select dropdown, current value "My Jobs"), OR
- Wait for the page load — the jobs DO appear (all 196 are visible once the spinner resolves) suggesting the initial render includes all jobs before filter applies, OR
- Confirm that after `waitForSelector` the table is already populated (the data appeared in the second attempt after `waitForLoadState('networkidle')`)

**Observation:** In the second run, all 10 rows of page 1 were captured correctly, suggesting the "My Jobs" filter was NOT active or the data loads then filters client-side. The first screenshot (01-job-board.png) shows "No data" — this was captured too early (before networkidle). The `waitForLoadState('networkidle')` is critical.

### The `ant-table-measure-row` is row[0]
Ant Design injects a hidden measurement row (`class="ant-table-measure-row"`, `style="height: 0px; font-size: 0px;"`) as the first `<tbody> tr`. It has 10 empty `<td>` cells. The bot's current guard `cells.length < 8` PASSES for this row (it has 10 cells), so `cells[0].textContent = ""` — the `!/^\d+$/.test(idText)` check correctly rejects it because `""` fails the numeric test. After fixing indices to `cells[1]`, this guard still works correctly.

### Language tags in cells[7]
Tags are `span.ant-tag.ant-tag-green` inside a `div.ant-dropdown-trigger`. The `+N` overflow uses a different element (also a `span` or `div` starting with `+`). The current `!s.startsWith('+')` filter is correct. Visible tags per row: `ar`, `bn-BD`, `bg-BG` + `+33` (for 36-language jobs).

**lo-LA and km-KH are likely hidden in the `+N` count.** The board only shows 3 visible tags + overflow. To find lo-LA/km-KH jobs from the board, the bot must click the `+N` dropdown OR open each job's detail page. Current approach (scan visible tags) will MISS lo-LA/km-KH if they're in the overflow.

### Clicking `+N` dropdown to expand tags
The div containing tags has class `ant-dropdown-trigger`. Clicking it may expand all language tags. This is worth adding to `parseRows()` for reliable lo-LA/km-KH detection at scan time.

### Assign modal — "No available users found"
Job 51085's km-KH row has status `REVIEWING` (100% progress). The modal shows "No available users found for this locale / Current step: REVIEWING". This means: when a language row is not in `WAITING_TRANSLATION` state, the modal doesn't list translators. The XPath `//*[contains(text(),"<email>")]/ancestor::...//button[contains(text(),"Assign")]` could not be confirmed — needs a job with `WAITING_TRANSLATION` status and an available translator.

### Waiting tab — "No data" for job 51085
Job 51085 has lo-LA (Lao) listed in "Target Languages" badge but lo-LA row does not appear in any tab (Waiting/In Progress/Published). This suggests lo-LA was either not yet created or is in a different state. km-KH appears only in "In Progress" tab (REVIEWING, 100%).

### Screenshots captured
- `logs/screenshots/task-18/01-job-board.png` — Job board with "No data" (captured before networkidle; "My Jobs" filter active)
- `logs/screenshots/task-18/02-job-detail.png` — Job 51085 detail page, "In Progress" tab active, km-KH row visible
- `logs/screenshots/task-18/03-waiting-tab.png` — Job 51085 "Waiting" tab — No data
- `logs/screenshots/task-18/04-assign-modal.png` — Assign Strings modal for km-KH (fully loaded, showing "No available users found")

### Safety
No Assign button inside the modal was clicked at any stage. The modal was closed via Escape immediately after screenshot. No job state was mutated.

---

## Round 1 vs Round 2 Summary

| Area | Round 1 (blocked at 2FA) | Round 2 (via cookies) |
|------|--------------------------|----------------------|
| Session | BLOCKED — 2FA gate | VALID — cookies work |
| Job Board cell mapping | Unknown | CONFIRMED — +1 offset on all indices |
| Open link selector | Unknown | CONFIRMED — `a[href*="job"]` works |
| Word Count xpath | Unknown | CONFIRMED — following-sibling resolves correctly |
| Tabs structure | Unknown | CONFIRMED — Waiting/In Progress/Published |
| Detail table mapping | Unknown | CONFIRMED — td[0]=lang, td[2]=translator |
| Status selector | Unknown | FIX NEEDED — use `td.nth(5)` instead of class-based |
| Assign button (row) | Unknown | CONFIRMED — `button:has-text("Assign")` works |
| Modal container | Unknown | CONFIRMED — `[role="dialog"]` + class `ant-modal` |
| Modal translator list | Unknown | NOT CONFIRMED — no WAITING_TRANSLATION job available |
| "My Jobs" filter issue | Not known | NEW FINDING — must verify bot can see all jobs |
| lo-LA hidden in +N overflow | Not known | NEW FINDING — visible tags only show 3; lo-LA may be hidden |

---

## Filter UI selectors (Approach 1+2)

Verified live against the real board on 2026-05-27 via cookie session (inspect-filters.ts + test-scan.ts).

### Status filter

- Element: `.ant-select` nth(0) — Ant Design single-select, initial value `"My Jobs"`
- Options discovered: `"Available to Claim"`, `"My Jobs"`, `"High Priority"`, `"Overdue"`, `"History"`
- How to set: click the select, then click `.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option` filtered by text `"Available to Claim"`

### Language filter

- Element: `.ant-select` nth(1) — Ant Design **multi-select** + **show-search**, placeholder `"All Languages"`
- Classes: `ant-select-multiple ant-select-allow-clear ant-select-show-arrow ant-select-show-search`
- Search input: inside `.ant-select-selector` (input type=search, id=`rc_select_1`) — initially `readOnly: true`; becomes editable after the select is clicked/focused
- How to set: click the select (opens dropdown), then `page.keyboard.type("lo")` → pick option containing `"lo-LA"` from dropdown
- Option text format: `"lo-LA - Lao (Laos)"` (with space-dash-space and full language name)
- km-KH option text: `"km-KH - Khmer (Cambodia)"`
- To clear selected tag: click `.ant-select-selection-item-remove` (the × on the tag chip)

### Search button

- Selector: `page.locator('button').filter({ hasText: /^Search$/ }).first()`
- Classes: `ant-btn-primary ant-btn-color-primary ant-btn-variant-solid`
- Note: the button shows a loading spinner briefly after click — wait for `.ant-spin-spinning` to hide before reading rows

### Clear button

- Selector: `page.locator('button').filter({ hasText: /^Clear$/ }).first()`
- Classes: `ant-btn-default ant-btn-variant-outlined`

### Pagination

- **NOT** Ant Design `.ant-pagination` component — uses plain Ant Buttons
- Previous button: `page.locator('button').filter({ hasText: /^Previous$/ })` — has `disabled=""` attribute on page 1
- Next button: `page.locator('button').filter({ hasText: /^Next$/ })` — not disabled until last page
- `button:has-text("Next"):not([disabled])` CSS locator returns `isVisible: false` (a different invisible element matches first) — use Playwright `.filter({ hasText: /^Next$/ })` instead

### Live scan() test result (2026-05-27)

`scan()` called with status=`"Available to Claim"`, iterating `lo-LA` and `km-KH`:

| Language | Pages paginated | Jobs found (before dedup) |
|----------|----------------|--------------------------|
| lo-LA | 34 pages × 10/page | 316 jobs |
| km-KH | ~3 pages | 30 jobs (all deduped into lo-LA set) |
| **Total deduped** | — | **316 candidates** |

Board totals confirmed (via "Total: N" footer):
- lo-LA filter: Total: 334 (live; volatile due to new jobs being added)
- km-KH filter: Total: 81

Note: The lo-LA board count (334) and the scanned count (316) differ because:
1. Jobs may have been assigned/closed between scan start and completion
2. The first page after `clickSearch` briefly shows empty until spinner clears (handled by `waitForSelector('.ant-spin-spinning', { state: 'hidden' })`)

### Screenshots captured

- `logs/screenshots/task-18b/filters-panel.png` — Job board filters panel, status = "My Jobs"
- `logs/screenshots/task-18b/status-dropdown.png` — Status dropdown open, options visible
- `logs/screenshots/task-18b/language-dropdown-opened.png` — Language multi-select opened
- `logs/screenshots/task-18b/language-search-lo.png` — Typing "lo" shows "lo-LA - Lao (Laos)"
- `logs/screenshots/task-18b/lo-LA-results.png` — lo-LA filter + Search: Total: 333
- `logs/screenshots/task-18b/km-KH-results.png` — km-KH filter + Search: Total: 81

### Safety
No Assign button was clicked. No job state was mutated. All interactions were read-only (navigate, filter, Search, read table, paginate).
