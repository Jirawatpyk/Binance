# Auto-Assign Bot สำหรับ TranslationTMS — Design Spec

- **วันที่:** 2026-05-20
- **เจ้าของ:** Jirawat (binance@eqho.com)
- **เป้าหมาย:** Bot อัตโนมัติเข้าระบบ [translationtms.com](https://www.translationtms.com/login) ตรวจหางานใหม่ภาษา `lo-LA` / `km-KH` แล้ว assign นักแปลตาม word count

---

## 1. Goals / Non-Goals

### Goals
- ลดงาน manual assign นักแปลที่ต้องทำซ้ำๆ ทุกครั้งที่มีงานใหม่
- Assign อัตโนมัติเฉพาะภาษา `lo-LA` (Lao) และ `km-KH` (Khmer)
- เลือกนักแปลตาม mapping word count + round-robin (config ได้)
- ไม่ assign ซ้ำ — จำงานที่ process แล้ว
- รันได้ทั้ง Local Windows และ Docker/VPS
- Error handling ครบ + log + screenshot debug

### Non-Goals (Phase 1)
- ไม่ทำหน้าที่ตรวจสอบคุณภาพการแปล (เป็นงาน reviewer ในระบบเอง)
- ไม่ assign ภาษาอื่นนอกจาก `lo-LA` / `km-KH`
- ไม่จัดการ Reviewer assignment (workflow ขั้นถัดไป — ขอบเขตของ phase อื่น)
- ไม่ทำ UI สำหรับจัดการ bot (config ผ่าน YAML file)

### Future Scope (Phase 2 — Dashboard Tracking)
หลัง backend Phase 1 stable แล้ว มีแผนต่อ **Dashboard Tracking** สำหรับติดตามผลงาน bot:
- หน้า dashboard แสดง: งานที่ assign สำเร็จ/ล้มเหลว/รอ retry, สถิติแบ่งตามภาษา/translator/ช่วงเวลา
- Health check: bot online/offline, polling interval ล่าสุด, error rate
- API/Database layer สำหรับ frontend (ปัจจุบัน state.json อาจ migrate ไป SQLite/PostgreSQL)

**ผลกระทบต่อ Phase 1 design:**
- §3.7 `StateStore` ควรออกแบบ interface เผื่อ swap implementation (JSON → DB) ได้ — abstract storage layer
- §3.8 `Logger` ใช้ structured JSON logs (winston JSON format) → ง่ายต่อการ ingest เข้า dashboard
- เก็บ event log ครบ: jobId, timestamp, language, translator, wordCount, status, error → เป็น source of truth สำหรับ dashboard ภายหลัง

---

## 2. Architecture Overview

**Pattern:** Modular layered Node.js service

```
┌───────────────────────────────────────────────┐
│              Scheduler (loop)                 │
└───────────────────┬───────────────────────────┘
                    │ trigger ทุก N นาที
                    ▼
┌───────────────────────────────────────────────┐
│      AuthSession (Playwright + cookies)       │
└───────────────────┬───────────────────────────┘
                    ▼
┌───────────────────────────────────────────────┐
│   JobScanner  (Job Board → filter lo/km)      │
└───────────────────┬───────────────────────────┘
                    ▼  (Job ที่ยังไม่ process)
┌───────────────────────────────────────────────┐
│   JobProcessor  (Open job → อ่าน metadata)    │
└───────────────────┬───────────────────────────┘
                    ▼
┌───────────────────────────────────────────────┐
│   AssignmentEngine  (config + state → pick)   │
└───────────────────┬───────────────────────────┘
                    ▼
┌───────────────────────────────────────────────┐
│   Assigner  (click Assign + confirm)          │
└───────────────────┬───────────────────────────┘
                    ▼
┌───────────────────────────────────────────────┐
│   StateStore  (mark processed + RR counter)   │
└───────────────────────────────────────────────┘

Cross-cutting:
  • Logger (winston) — daily file + console
  • ErrorHandler — retry + screenshot
  • ConfigLoader — YAML watch + reload
```

### หลักการออกแบบ
- **Single Responsibility** — แต่ละ module ทำหน้าที่เดียว
- **Pure logic แยกจาก Browser** — `AssignmentEngine` ทดสอบได้โดยไม่ต้องเปิด browser
- **Idempotent** — รัน N ครั้งเหมือนรันครั้งเดียว (จะไม่ assign ซ้ำ)
- **Config-driven** — เปลี่ยน translator mapping ไม่ต้องแก้ code

---

## 3. Components

### 3.1 `Scheduler` (`src/core/scheduler.ts`)
- รัน loop ตาม interval ใน `settings.yml`
- จัดการ graceful shutdown (SIGINT/SIGTERM)
- กันรัน overlap (ถ้า loop ก่อนยังไม่จบ ข้าม tick นี้)
- ใช้ `setTimeout` recursive (ไม่ใช่ `setInterval` — กัน drift)

### 3.2 `AuthSession` (`src/auth/session.ts`)
- เปิด Playwright browser (headless ตาม config)
- โหลด cookie จาก disk ถ้ามี → ลอง open Job Board
- ถ้า redirect ไป `/login` → ทำ login flow + บันทึก cookie
- Singleton ต่อ process — ใช้ browser context เดียวตลอด lifecycle
- เพิ่ม **stealth plugin** (`playwright-extra-plugin-stealth`)
- Credentials โหลดจาก `.env` (ไม่อยู่ใน YAML)

### 3.3 `JobScanner` (`src/scraper/job-scanner.ts`)
- Navigate ไป Job Board (filter `Available to Claim`)
- Parse table → return `Job[]`:
  ```ts
  interface Job {
    id: string;          // เช่น "61514"
    name: string;
    dueDate: Date;
    project: string;
    languageCount: number;
    languagesNeeded: string[];  // ['ar', 'lo-LA', 'km-KH', ...]
    wordCount: number;
    detailUrl: string;
  }
  ```
- **Filter:** เก็บเฉพาะงานที่ `languagesNeeded` มี `lo-LA` หรือ `km-KH`
- **ข้าม** งานที่ `StateStore.isProcessed(job.id)` เป็น true
- รองรับ pagination (ถ้า total > 10)

### 3.4 `JobProcessor` (`src/scraper/job-processor.ts`)
- เปิดหน้า Job Detail (`detailUrl`)
- Parse target languages + Waiting tab → return `JobDetail`:
  ```ts
  interface JobDetail {
    jobId: string;
    wordCount: number;
    targetLanguages: TargetLanguage[];
  }
  interface TargetLanguage {
    code: 'lo-LA' | 'km-KH';
    status: string;                 // 'WAITING_TRANSLATION' | อื่น
    translator: string | null;      // null = ยังไม่ assign
    assignButton: Locator;          // Playwright locator
  }
  ```
- **Filter เฉพาะ:** `code` ∈ {`lo-LA`, `km-KH`} **AND** `status === 'WAITING_TRANSLATION'` **AND** `translator === null`

### 3.5 `AssignmentEngine` (`src/assignment/engine.ts`) — **Pure logic, ไม่มี Playwright**
- รับ `{ language, wordCount }` → return `translator_email`
- อ่าน `translators.yml`:
  ```yaml
  lo-LA:
    rules:
      - max_words: 500
        translators: [LO_T1@eqho.com]            # ช่วงเดียว 1 คน
      - max_words: 2000
        translators: [LO_T3@eqho.com]            # ช่วงกลาง 1 คน
      - max_words: null                          # > 2000 (no upper)
        translators: [LO_T3@eqho.com, LO_T4@eqho.com]  # round-robin
  km-KH:
    rules:
      - max_words: 500
        translators: [KM_T1@eqho.com]
      - max_words: null
        translators: [KM_T1@eqho.com, KM_T2@eqho.com]
  ```
- ถ้า `translators.length === 1` → return ตัวเดียว
- ถ้า `translators.length > 1` → ใช้ round-robin counter จาก `StateStore`
- Unit test ได้ 100% โดยไม่ต้องใช้ browser

### 3.6 `Assigner` (`src/assignment/assigner.ts`)
- รับ `TargetLanguage` + `translator_email`
- คลิกปุ่ม Assign บนแถวภาษานั้น → popup `Assign Strings - lo-LA`
- หา row ที่มี email ตรง → คลิก `Assign` บน row นั้น
- รอ popup ปิด + verify row ใน Waiting table อัพเดต (มี translator ขึ้นชื่อแล้ว)
- ถ้า popup ไม่มี email ที่ต้องการ → throw `TranslatorNotFoundError` + log + screenshot

### 3.7 `StateStore` (`src/storage/state.ts`)
- เก็บใน `data/state.json`:
  ```json
  {
    "processedJobs": {
      "61514": {
        "processedAt": "2026-05-20T10:30:00Z",
        "status": "FULL",
        "assigned": { "lo-LA": "LO_T3@eqho.com", "km-KH": "KM_T2@eqho.com" }
      },
      "61515": {
        "processedAt": "2026-05-20T10:35:00Z",
        "status": "PARTIAL",
        "assigned": { "lo-LA": "LO_T1@eqho.com" },
        "failed": ["km-KH"]
      }
    },
    "roundRobinCounters": {
      "lo-LA:rule2": 3,
      "km-KH:rule2": 1
    }
  }
  ```
- API: `isProcessed(jobId)`, `getProcessStatus(jobId)`, `markProcessed(jobId, FULL, assigned)`, `markPartial(jobId, assigned, failed)`, `getRRIndex(key)`, `incrementRR(key)`
- **Filter ใน JobScanner:** ข้ามเฉพาะ job ที่ `status === 'FULL'` — `PARTIAL` ยังกลับมา retry ได้
- เขียนแบบ atomic (write to `state.json.tmp` → rename)
- กัน race ด้วย in-process mutex (single-instance ก็พอ)

### 3.8 `Logger` (`src/core/logger.ts`)
- `winston` + daily rotate
- 3 streams: console (colorful), `logs/app-YYYY-MM-DD.log`, `logs/error-YYYY-MM-DD.log`
- รูปแบบ log:
  ```
  2026-05-20 17:00:00 [INFO] [JobScanner] found 2 candidate jobs (61514, 61515)
  2026-05-20 17:00:05 [INFO] [Assigner] job=61514 lang=lo-LA assigned=LO_T3@eqho.com (wc=746)
  ```

### 3.9 `ConfigLoader` (`src/storage/config.ts`)
- โหลด `settings.yml` + `translators.yml` ตอน startup
- Validate ด้วย `zod` schema → ถ้า config ผิดให้ throw ทันที (fail-fast)
- ไม่ hot-reload (restart ง่ายกว่า + ปลอดภัยกว่า)

---

## 4. Data Flow (Sequence)

```
1. Scheduler tick (every 5 min)
2. AuthSession → ensure logged in
3. JobScanner → ดึง Job list (Available to Claim)
4. Filter: มี lo-LA หรือ km-KH AND ไม่อยู่ใน StateStore
5. For each candidate job:
   6. JobProcessor → open job → ดึง waiting languages
   7. For each waiting language (lo-LA/km-KH ที่ translator=null):
      8. AssignmentEngine.pick(lang, wordCount) → translator email
      9. Assigner.assign(language, email) → success | error
      10. Log success/failure
   11. **Mark processed strategy:**
       - ถ้า **ทุกภาษา** assign สำเร็จ → `StateStore.markProcessed(jobId, FULL)`
       - ถ้า **บางภาษา** สำเร็จ บางภาษา error → `StateStore.markPartial(jobId, succeeded[])` → tick ถัดไปจะ retry เฉพาะภาษาที่ยัง pending (ตรวจจาก translator=null อีกครั้ง)
       - ถ้า **ไม่มีภาษาใด** สำเร็จ → ไม่ mark → retry รอบหน้า (มี backoff)
12. Back to job list, next candidate
13. Wait for next tick
```

---

## 5. Configuration

### `config/settings.yml`
```yaml
polling:
  intervalMinutes: 5
  jitterSeconds: 30          # random jitter 0-30s กัน pattern

browser:
  headless: true             # false = ดูได้ตอน debug
  viewport: { width: 1920, height: 1080 }
  navigationTimeoutMs: 30000

storage:
  statePath: ./data/state.json
  logsDir: ./logs
  cookiesPath: ./data/cookies.json

assignment:
  dryRun: false              # true = ไม่กด assign จริง
  maxRetries: 3
  retryDelayMs: 5000

logging:
  level: info                # debug | info | warn | error
  rotateDays: 14
```

### `config/translators.yml`
ตามตัวอย่างใน §3.5 — user แก้เองได้ทันที, restart bot ค่อยมีผล

### `.env` (ไม่ commit)
```
TMS_USERNAME=<your-tms-email>
TMS_PASSWORD=<redacted — set in .env only, never in committed docs>
```

---

## 6. Error Handling

| สถานการณ์ | กลยุทธ์ |
|----------|---------|
| Login ล้มเหลว | Retry 3 ครั้ง (delay 30s) → ถ้ายังล้มเหลว log error → ข้าม tick |
| Selector ไม่เจอ (UI เปลี่ยน) | Screenshot + log → ข้ามงานนั้น (ไม่ mark processed) → notify (อนาคต) |
| Translator ไม่อยู่ใน popup | Log error + screenshot + ข้ามภาษานั้น (อาจ assign บางภาษาสำเร็จ) |
| Network timeout | Retry ตาม `maxRetries` + exponential backoff |
| Cookie expired | Clear cookies → ทำ full login ใหม่ |
| Browser crash | Restart browser context (Scheduler ตรวจจับ) |
| Concurrent process รัน 2 instance | Lock file `data/.lock` → instance ที่สองออก |

**ทุก screenshot บันทึก** `logs/screenshots/YYYY-MM-DD/error-<timestamp>-<context>.png`

---

## 7. Anti-Detection

- ใช้ `playwright-extra` + `puppeteer-extra-plugin-stealth` (Playwright-extra รองรับ plugin ของ puppeteer-extra)
- Random delay 500-1500ms ระหว่าง action สำคัญ
- Jitter polling interval (กัน pattern เป๊ะ)
- User-Agent จริงจาก Chromium (Playwright default)
- `headless` config-driven — แนะนำ `false` ระหว่าง development (ดู browser ได้), `true` ตอน production

---

## 8. Testing Strategy

| Level | Tooling | Coverage |
|-------|---------|----------|
| **Unit** | Vitest | `AssignmentEngine`, `ConfigLoader`, `StateStore` — 100% logic |
| **Integration** | Playwright Test | Mock TMS pages (HTML fixtures) → ทดสอบ `JobScanner`, `JobProcessor`, `Assigner` |
| **E2E (manual)** | Real TMS | `npm run start -- --dry-run` กับงานจริง — ตรวจสอบ Log ก่อน enable production |
| **Smoke** | Cron + Playwright | รายวัน — login + เปิด Job Board → fail = alert |

---

## 9. Deployment

### Local Windows (Primary)
```powershell
# Setup
npm install
npx playwright install chromium
copy .env.example .env  # แล้วใส่ credential
copy config/translators.example.yml config/translators.yml

# Run
npm run start

# Background (Windows Service via node-windows)
npm run install-service
```

### Docker (Secondary)
```yaml
# docker-compose.yml
services:
  tms-bot:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./config:/app/config:ro
      - ./data:/app/data
      - ./logs:/app/logs
```

`Dockerfile` ใช้ `mcr.microsoft.com/playwright:v1.49.0-jammy` (official, ครบ deps)

---

## 10. Project Structure

```
binance-translation-bot/
├── src/
│   ├── core/
│   │   ├── scheduler.ts
│   │   ├── logger.ts
│   │   └── errors.ts
│   ├── auth/
│   │   └── session.ts
│   ├── scraper/
│   │   ├── job-scanner.ts
│   │   └── job-processor.ts
│   ├── assignment/
│   │   ├── engine.ts            ← pure logic
│   │   └── assigner.ts          ← Playwright action
│   ├── storage/
│   │   ├── state.ts
│   │   └── config.ts
│   ├── types/
│   │   └── index.ts
│   └── index.ts                  ← entry point
├── config/
│   ├── settings.yml
│   ├── settings.example.yml
│   ├── translators.yml
│   └── translators.example.yml
├── data/                         ← gitignored
│   ├── state.json
│   └── cookies.json
├── logs/                         ← gitignored
├── tests/
│   ├── unit/
│   │   ├── assignment-engine.test.ts
│   │   ├── state-store.test.ts
│   │   └── config-loader.test.ts
│   └── integration/
│       ├── fixtures/             ← HTML mock pages
│       ├── job-scanner.test.ts
│       └── assigner.test.ts
├── .env.example
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── playwright.config.ts
├── vitest.config.ts
└── README.md
```

---

## 11. Security Considerations

- **Credentials:** เก็บใน `.env` เท่านั้น (gitignore + docker secret support)
- **State file:** ไม่มีข้อมูล sensitive (มีแค่ Job ID + email translator)
- **Logs:** ไม่ log password / cookie value
- **Screenshots:** อาจมีข้อมูลงาน → folder gitignore
- **Stealth:** ใช้ legitimate session (login จริง), ไม่ bypass authentication

---

## 12. Open Questions (ขอ User ยืนยันใน Review)

1. **Polling interval default 5 นาที** OK หรือเปลี่ยน?
2. **Translator mapping ตัวอย่างใน §3.5** OK ไหม (เป็น placeholder, แก้ใน YAML ทีหลังได้)?
3. **เริ่ม headless = `true`** หรือ `false` (ตอน dev อยากเห็น browser)?
4. **Notification เมื่อ assign สำเร็จ/ล้มเหลว** — ตอนนี้ log file อย่างเดียว, ต้องการ LINE Notify / Discord / Email ในอนาคตไหม?
5. **State file ใช้ JSON** OK หรือต้องการ SQLite (รองรับ scale ในอนาคต)?

---

## 13. Phase / Milestone (สำหรับขั้น planning)

| Phase | Scope | Deliverable |
|-------|-------|-------------|
| **M1** | Foundation | Project scaffold + config + logger + Playwright login |
| **M2** | Read path | JobScanner + JobProcessor + dry-run log "would assign X" |
| **M3** | Write path | AssignmentEngine + Assigner + StateStore |
| **M4** | Reliability | Error handling + retry + screenshot + lock file |
| **M5** | Deploy | Dockerfile + windows-service script + README |
| **M6** | Polish | Tests (unit + integration) + smoke test |

(planning ขั้นถัดไปจะ break down เป็น tasks ด้วย `superpowers:writing-plans`)
