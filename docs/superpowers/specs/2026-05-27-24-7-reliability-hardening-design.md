# 24/7 Reliability Hardening — Design Spec

- **วันที่:** 2026-05-27
- **เจ้าของ:** Jirawat (binance@eqho.com)
- **เป้าหมาย:** อัพเกรด Translation TMS Auto-Assign Bot ให้รัน 24/7 แบบ set-and-forget — กำจัด manual touchpoint ทุกจุดเท่าที่ข้อจำกัด 2FA อนุญาต
- **ต่อยอดจาก:** Phase 1 backend (`docs/superpowers/specs/2026-05-20-translation-tms-auto-assign-bot-design.md`)

---

## 1. Goals / Non-Goals

### Goals
- Bot รันต่อเนื่องโดยไม่ต้องมีคนแตะ ยกเว้นกรณีเดียว: re-capture cookie เมื่อ 2FA session หมดอายุ (ข้อจำกัดที่หลีกเลี่ยงไม่ได้)
- กู้คืนอัตโนมัติจากทุกโหมดที่ทำให้ระบบหยุด: process crash, process hang, browser crash, network error, session expiry
- เจ้าของรู้สถานะระบบโดยไม่ต้องเข้าไปดูเอง: alert ตอนมีปัญหา + สรุปรายวัน
- ทำงานบน Local Windows PC (always-on) ผ่าน Windows Service

### Non-Goals
- ไม่ทำ TOTP auto-login (ไม่มี/ไม่ใช้ 2FA secret) — login ยังต้องมีคนทำตอน session หมด
- ไม่ทำ web dashboard (เป็น Phase 2 แยก)
- ไม่ย้ายไป cloud/VPS (host = Local Windows ตามที่ตัดสินใจ)
- ไม่ทำ external watchdog process (ใช้ Windows Service + in-process watchdog แทน)

### Success Criteria
- เมื่อ process ถูก kill → Windows Service ปลุกกลับภายใน restart delay
- เมื่อ tick ค้างเกิน `tickTimeoutMs` → bot self-exit → service ปลุกกลับ
- เมื่อ session หมด → bot ส่ง alert 1 ครั้ง, ไม่ crash, และ auto-resume เมื่อ cookie ใหม่พร้อม โดยไม่ต้อง restart
- ได้ daily summary เข้า Google Chat ทุกวันตามเวลาที่ตั้ง

---

## 2. Architecture Overview (Approach C — Hybrid)

ป้องกัน 5 ชั้น แต่ละชั้นรับผิดชอบ failure mode คนละแบบ:

```
┌───────────────────────────────────────────────────────────┐
│ Windows Service (node-windows)                            │
│   • start on boot • auto-restart on process crash         │
└───────────────────────┬───────────────────────────────────┘
                        │ runs
                        ▼
┌───────────────────────────────────────────────────────────┐
│ Bot process (src/index.ts)                                │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Watchdog — หุ้มแต่ละ tick; tick ค้าง → process.exit │  │
│  └─────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ ReAuthManager — session หมด → PAUSED_AUTH + alert + │  │
│  │   auto-resume (ไม่ crash, ไม่ restart)               │  │
│  └─────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Self-recovery — browser/page closed → relaunch       │  │
│  └─────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ HealthMonitor — metrics + error-rate alert + daily   │  │
│  │   summary (data/health.json)                          │  │
│  └─────────────────────────────────────────────────────┘  │
│  Scheduler · AuthSession · JobScanner · ... (Phase 1)     │
└───────────────────────────────────────────────────────────┘
                        │ alerts/summaries
                        ▼
                  GoogleChatNotifier
```

### หลักการ
- ต่อยอดจากของเดิม ไม่รื้อ: Scheduler, AuthSession, GoogleChatNotifier, ProcessLock ยังอยู่
- Logic ที่ทดสอบได้แยกเป็น pure functions (scheduling, thresholds, dedup) — browser/process logic แยกออก
- Fail-safe by default: ทุก failure mode มีทางกลับมาเอง ยกเว้น 2FA ที่ต้องคน (แต่ก็ alert + auto-resume)

---

## 3. Components

### 3.1 `ReAuthManager` (`src/auth/reauth-manager.ts`)
จัดการสถานะ authentication ของ session ระหว่างรัน — แทนการ throw แล้ว crash

**State:** `AUTHED | PAUSED_AUTH`

**API:**
```typescript
interface AuthCheckResult { authed: boolean }

class ReAuthManager {
  constructor(session: AuthSession, notifier: GoogleChatNotifier, logger: Logger);
  // เรียกตอนต้น tick. คืน true ถ้าพร้อมทำงาน, false ถ้า PAUSED (ข้าม tick)
  async ensureReady(): Promise<boolean>;
}
```

**พฤติกรรม:**
- เรียก `session.ensureLoggedIn()` ใน try/catch
- ถ้าสำเร็จ:
  - ถ้าเดิมอยู่ `PAUSED_AUTH` → เปลี่ยนเป็น `AUTHED`, ส่ง alert `✅ Session restored, resuming`, return true
  - ถ้าเดิม `AUTHED` → return true (เงียบ)
- ถ้า `ensureLoggedIn` throw `LoginFailedError` (session หมด):
  - ถ้าเดิม `AUTHED` → เปลี่ยนเป็น `PAUSED_AUTH`, ส่ง alert `🔐 Session expired — run capture-cookies on host to resume` (**ครั้งเดียว**)
  - ถ้าเดิม `PAUSED_AUTH` → เงียบ (ไม่ alert ซ้ำ)
  - return false (tick ข้ามงาน รอ tick ถัดไปเช็คใหม่)
- การที่ scheduler ยังเรียก tick ทุก interval ทำให้ระบบ poll cookie ใหม่เรื่อยๆ → พอ human capture เสร็จ tick ถัดไปจะ `AUTHED` เอง

### 3.2 `Watchdog` (`src/core/watchdog.ts`)
จับกรณี tick "ค้าง" (hang) ที่ Windows Service มองไม่เห็น (process ยังมีชีวิต)

**API:**
```typescript
// รัน fn ภายใน timeout; ถ้าเกิน → onTimeout() ถูกเรียก
async function runWithWatchdog<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T>;
```

**พฤติกรรม:** ใช้ `Promise.race` ระหว่าง `fn()` กับ timer. ถ้า timer ชนะ → เรียก `onTimeout` (log fatal + alert + `process.exit(1)`). ใน `index.ts` หุ้มการเรียก `tick()` ด้วย watchdog นี้ — Windows Service จะ restart process ให้

### 3.3 `HealthMonitor` (`src/core/health-monitor.ts`)
ติดตาม metric + ตัดสินใจ alert/summary

**Persist:** `data/health.json`
```json
{
  "startedAt": "2026-05-27T02:00:00Z",
  "lastTickAt": "2026-05-27T09:00:00Z",
  "lastSuccessAt": "2026-05-27T09:00:00Z",
  "consecutiveErrors": 0,
  "today": { "date": "2026-05-27", "assigned": 12, "failed": 1, "authEpisodes": 0 },
  "lastDailySummaryDate": "2026-05-27"
}
```

**API:**
```typescript
class HealthMonitor {
  async load(): Promise<void>;
  recordTickStart(): void;
  recordTickSuccess(): void;            // reset consecutiveErrors, set lastSuccessAt
  recordTickError(): void;              // ++consecutiveErrors
  recordAssignment(lang, ok): void;     // ++today.assigned / today.failed
  recordAuthEpisode(): void;            // ++today.authEpisodes
  shouldAlertErrorRate(threshold): boolean;   // consecutiveErrors === threshold (alert ครั้งเดียวตอนแตะ)
  buildDailySummary(): string;          // ข้อความสรุป
  async save(): Promise<void>;
}
```

**Pure helpers (แยกไป `src/core/health-utils.ts` เพื่อ unit test):**
```typescript
// ถึงเวลาส่ง daily summary หรือยัง (เทียบ now กับ "HH:mm" และ lastSentDate)
function isDailySummaryDue(now: Date, summaryTime: string, lastSentDate: string | null): boolean;
// ตัดสิน rollover วันใหม่ → reset today counters
function isNewDay(now: Date, todayDate: string): boolean;
```

### 3.4 Self-recovery (แก้ `AuthSession` + `index.ts`)
- `AuthSession` เพิ่ม `isAlive(): boolean` (เช็ค page/context ยังไม่ปิด) และทำให้ `start()`/re-init เรียกซ้ำได้
- ใน tick: ถ้าจับ error ที่บ่งว่า browser ตาย (`Target closed`, `Browser has been closed`) → เรียก `session.recover()` (ปิดของเก่าถ้ามี + `start()` ใหม่) แล้วปล่อยให้ tick ถัดไปทำงาน

### 3.5 Supervision hardening (`scripts/install-windows-service.js` + docs)
- ตั้ง service ให้ start-on-boot (node-windows default = automatic)
- ตั้ง restart-on-crash + restart delay (node-windows `wait`/`grow`/`maxRestarts` options)
- เอกสาร setup เครื่อง: ปิด sleep (`powercfg /change standby-timeout-ac 0`), รัน service ใต้ account ที่เหมาะสม

### 3.6 Wiring (`src/index.ts`)
ลำดับใน tick (ปรับจากเดิม):
```
1. health.recordTickStart()
2. if (!await reauth.ensureReady()) { health.save(); return; }   // PAUSED_AUTH → ข้าม
3. try {
     scan → process → assign (เดิม) ; health.recordAssignment(...) ต่อภาษา
     health.recordTickSuccess()
   } catch (browser-dead) { await session.recover() }
     catch (other) { health.recordTickError(); if (shouldAlertErrorRate) notify(...) }
4. if (isDailySummaryDue(now, cfg.dailySummaryTime, health.lastDailySummaryDate))
     notify(health.buildDailySummary()); mark sent
5. health.save()
```
tick ทั้งหมดถูกหุ้มด้วย `runWithWatchdog(tick, tickTimeoutMs, onHang)` ใน scheduler/entry.

---

## 4. Configuration (`settings.yml` เพิ่ม section)

```yaml
reliability:
  watchdog:
    tickTimeoutMs: 480000        # 8 นาที (interval 5 นาที + เผื่อ) — tick เกินนี้ = hang
  reauth:
    alertOnExpiry: true          # ส่ง alert เมื่อ session หมด
  monitoring:
    dailySummaryTime: "09:00"    # เวลา local ส่งสรุปรายวัน
    consecutiveErrorAlert: 3     # fail ติดกันกี่ tick ถึง alert
```

zod schema + `Settings` type + example yml อัพเดตตาม (รวมถึง config-loader test fixture)

---

## 5. Error Handling Matrix

| Failure mode | ใครจับ | การกู้คืน |
|--------------|--------|-----------|
| Process crash (exception หลุด) | Windows Service | restart process |
| เครื่อง reboot | Windows Service (boot start) | start process |
| Tick hang (ค้างไม่ crash) | Watchdog | `process.exit(1)` → service restart |
| Session/cookie หมด | ReAuthManager | PAUSED_AUTH + alert ครั้งเดียว + auto-resume |
| Browser/page crash | Self-recovery in tick | relaunch context |
| Network/transient | retry (Phase 1) | exponential backoff |
| Error ติดกันหลาย tick | HealthMonitor | alert เมื่อแตะ threshold |
| Notification fail | GoogleChatNotifier | 5s timeout + swallow (Phase 1) |

---

## 6. Testing Strategy

| Level | Target | วิธี |
|-------|--------|------|
| Unit (vitest) | `isDailySummaryDue`, `isNewDay`, error-rate threshold, auth-episode dedup logic | table-driven, fake `now` |
| Unit (vitest) | `runWithWatchdog` | fake timers — ยืนยัน timeout เรียก onTimeout, สำเร็จไม่เรียก |
| Unit (vitest) | `HealthMonitor` counters + rollover + persist/reload | temp file |
| Manual/live | ReAuthManager (expire cookie จริง), browser-crash recovery, watchdog exit→service restart | รันบน host + สังเกต Google Chat |

ทุก pure logic ต้องมี unit test (ตามแนว Phase 1 ที่ test เฉพาะ pure layer)

---

## 7. Project Structure (เพิ่ม/แก้)

```
src/
├── auth/
│   ├── session.ts          (แก้: isAlive, recover)
│   └── reauth-manager.ts   (ใหม่)
├── core/
│   ├── watchdog.ts         (ใหม่)
│   ├── health-monitor.ts   (ใหม่)
│   ├── health-utils.ts     (ใหม่ — pure)
│   └── scheduler.ts        (แก้: หุ้ม watchdog)
├── index.ts                (แก้: wiring ลำดับใหม่)
├── storage/config.ts       (แก้: reliability schema)
└── types/index.ts          (แก้: Settings.reliability, health types)
scripts/install-windows-service.js  (แก้: restart/boot options)
config/settings.example.yml         (แก้: reliability block)
tests/unit/health-utils.test.ts     (ใหม่)
tests/unit/watchdog.test.ts         (ใหม่)
tests/unit/health-monitor.test.ts   (ใหม่)
data/health.json                    (runtime, gitignored)
```

---

## 8. Phase 2 readiness
- `data/health.json` + structured logs = แหล่งข้อมูลพร้อมสำหรับ Dashboard (Phase 2) — dashboard อ่าน health.json/logs ได้เลย
- HealthMonitor API ออกแบบให้ future dashboard เรียกใช้ metric เดียวกันได้

---

## 9. Open Questions (ยืนยันใน review)
1. `tickTimeoutMs` 8 นาที เหมาะไหม (interval 5 นาที)?
2. `dailySummaryTime` 09:00 local — เวลาที่ต้องการ?
3. `consecutiveErrorAlert` 3 ticks — ไวไป/ช้าไป?
4. Daily summary ส่งแม้วันที่ไม่มีงาน assign ด้วยไหม (default: ส่ง — เป็น heartbeat ยืนยัน bot ยังมีชีวิต)?
