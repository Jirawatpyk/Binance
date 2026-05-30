# Deploy Runbook — Binance Auto-Assign Bot (Oracle Cloud ARM)

Operator runbook for deploying and operating the bot 24/7 on an **Oracle Cloud Always Free Ampere A1 (aarch64) Ubuntu 22.04** instance.

| Convention | Value |
|---|---|
| Host | Oracle Cloud Always Free, Ampere A1 (arm64), Ubuntu 22.04 LTS |
| Install path | `/opt/binance-bot` |
| Service user/group | `binancebot` (non-root, no login shell) |
| systemd unit | `binance-bot.service` |
| Run mode | **Compiled** — `node dist/index.js` (never `npm run dev`) |
| Backups | `/opt/binance-bot-backups` |
| Timezone | `Asia/Bangkok` (set in the unit, see step 5) |

> Operator runs **steps 3 & 4 on Windows 11 (PowerShell)**. All host commands run on the **Ubuntu VPS over SSH**.

---

## 1. Prerequisites

- An **Oracle Cloud Always Free** account with an **Ampere A1 (Arm-based)** compute instance running **Ubuntu 22.04 LTS**. The Always Free tier grants up to 4 Arm OCPUs / 24 GB RAM at no cost; **Arm (Ampere A1) capacity is frequently exhausted in popular regions — if instance creation fails with an out-of-capacity error, retry later or pick another availability domain/region.**
- SSH access to the instance (`ssh ubuntu@HOST` with your key).
- **No inbound application port is required** — the bot only makes **outbound** HTTPS calls (to translationtms.com and the optional Google Chat webhook / Google Sheets). Leave the default ingress closed; just ensure outbound 443 is allowed (it is by default).

Set a shell var for convenience on your Windows machine and on the host:

```powershell
# Windows (PowerShell)
$HOST_IP = "your.vps.ip.address"
```

---

## 2. Provision the VPS

Clone the repo into the install path and run the setup script (it creates the `binancebot` user, installs Node 20 + Chromium deps, builds the bot, and installs the systemd unit).

```bash
# On the VPS (as the default ubuntu sudoer)
sudo git clone https://github.com/Jirawatpyk/Binance.git /opt/binance-bot
cd /opt/binance-bot
sudo bash deploy/setup-vps.sh
```

`deploy/setup-vps.sh` performs (do not duplicate by hand):
- creates the `binancebot` user/group (non-root, no login shell) and the `data/` + `logs/` dirs, `chown`ed to `binancebot`;
- installs **Node v20 LTS** via NodeSource (`deb.nodesource.com/setup_20.x`);
- installs the Chromium runtime in **two parts** (so the browser lands in `binancebot`'s cache, not root's): `npx playwright install-deps chromium` as **root** (apt OS libraries), then `npm ci && npx playwright install chromium && npm run build` as **`binancebot`** (browser download → `binancebot`'s `~/.cache/ms-playwright`, then the compiled build);
- installs `binance-bot.service` (with `WorkingDirectory=/opt/binance-bot`, `Environment=TZ=Asia/Bangkok`, `Restart=always`, `RestartSec=10`) and `daemon-reload`s — but does **not** start it yet (secrets aren't transferred until step 4).

---

## 3. Capture cookies on the OPERATOR's machine (2FA)

The TMS account has Google Authenticator 2FA, so the bot **cannot** password-login. You must capture a logged-in session **on your own Windows machine** (it opens a visible browser):

```powershell
# Windows (PowerShell), in the repo checkout
cd C:\Users\Jirawat.p\Documents\Binance
npm run capture-cookies
```

A Chromium window opens. **Log in to translationtms.com manually, including the 6-digit Google Authenticator code.** When the browser reaches the Job Board, the script saves `data/cookies.json`. This file is gitignored and must be transferred in the next step.

---

## 4. Transfer secrets (Windows → VPS)

These runtime files are **gitignored** and are NOT on the VPS after the clone. Copy them from your Windows checkout to `binancebot`'s install tree. `data/state.json` is optional but transferring it **preserves round-robin counters and processed-job idempotency**.

```powershell
# Windows (PowerShell), from C:\Users\Jirawat.p\Documents\Binance

# config (required)
scp config\settings.yml      ubuntu@${HOST_IP}:/tmp/settings.yml
scp config\translators.yml   ubuntu@${HOST_IP}:/tmp/translators.yml
# env + google creds
scp .env                     ubuntu@${HOST_IP}:/tmp/.env
scp google-credentials.json  ubuntu@${HOST_IP}:/tmp/google-credentials.json
# session cookies (required)
scp data\cookies.json        ubuntu@${HOST_IP}:/tmp/cookies.json
# OPTIONAL — preserves round-robin + idempotency
scp data\state.json          ubuntu@${HOST_IP}:/tmp/state.json
```

> scp lands files in `/tmp` because `binancebot` has no login shell and `/opt/binance-bot` isn't writable by `ubuntu`. Now move them into place and fix ownership **on the VPS**:

```bash
# On the VPS
sudo mv /tmp/settings.yml            /opt/binance-bot/config/settings.yml
sudo mv /tmp/translators.yml         /opt/binance-bot/config/translators.yml
sudo mv /tmp/.env                    /opt/binance-bot/.env
sudo mv /tmp/google-credentials.json /opt/binance-bot/google-credentials.json
sudo mv /tmp/cookies.json            /opt/binance-bot/data/cookies.json
sudo mv /tmp/state.json              /opt/binance-bot/data/state.json   # only if you copied it

# everything the service touches must be owned by binancebot
sudo chown -R binancebot:binancebot /opt/binance-bot/config /opt/binance-bot/.env \
  /opt/binance-bot/google-credentials.json /opt/binance-bot/data
```

(The relative paths in `settings.yml` — `./data/state.json`, `./logs`, `./data/cookies.json` — resolve correctly because the unit sets `WorkingDirectory=/opt/binance-bot`.)

---

## 5. Start and verify

```bash
# On the VPS
sudo systemctl enable --now binance-bot
journalctl -u binance-bot -f
```

A **healthy first tick** in the logs looks like:
- auth: cookie **session valid** / reaches the Job Board (no `PAUSED_AUTH`);
- scan: a **scan window** line (e.g. lookback hours) and the lo-LA / km-KH filter passes plus the review pass;
- **tick complete** with a candidate/assignment count and no unhandled error.

If you see `Restart=always` kicking in (the unit restarts every ~10s) or repeated stack traces, jump to **Troubleshooting**.

If the unit isn't installed for some reason, the systemd unit must contain at minimum:

```ini
[Service]
User=binancebot
Group=binancebot
WorkingDirectory=/opt/binance-bot
Environment=TZ=Asia/Bangkok
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
```

> **`TZ=Asia/Bangkok` is mandatory.** The daily heartbeat uses process **local** time (`now.getHours()` in `health-utils.ts`); on a UTC host the 09:00 summary would fire 7 hours off.

---

## 6. Confirm `dryRun` BEFORE you trust it

Open `config/settings.yml` and check **`assignment.dryRun`**:

```bash
grep -A1 dryRun /opt/binance-bot/config/settings.yml
```

- `dryRun: true` — the bot only logs **"would assign"**. Safe.
- `dryRun: false` — **the bot clicks Assign for real on the LIVE production TMS.** This is a deliberate, dangerous flag. Set it to `false` only when you intend real assignments, and restart the service afterward (`sudo systemctl restart binance-bot`).

Run a few ticks with `dryRun: true` first, confirm the candidates/decisions look right in the logs, then flip.

---

## 7. Auth lifecycle (no 12h re-upload)

After the initial `cookies.json` upload, **the bot self-refreshes the access token** via the stored `refresh_token` (`AuthSession.refreshAccessToken`). You do **not** need to re-capture or re-scp cookies every 12 hours.

**Re-capture only when the `refresh_token` itself expires.** Symptom:
- the bot enters **`PAUSED_AUTH`** (it pauses the work loop instead of crashing; only the daily heartbeat keeps firing) and **alerts via Google Chat**.

Recovery — repeat steps 3 → 4 (cookies only) → restart:

```powershell
# Windows
npm run capture-cookies
scp data\cookies.json ubuntu@${HOST_IP}:/tmp/cookies.json
```
```bash
# VPS
sudo mv /tmp/cookies.json /opt/binance-bot/data/cookies.json
sudo chown binancebot:binancebot /opt/binance-bot/data/cookies.json
sudo systemctl restart binance-bot
```

---

## 8. Backups

`deploy/setup-vps.sh` installs a `cron.d` entry that runs `deploy/backup-data.sh`, tarring `data/` (state.json, health.json, cookies.json) into `/opt/binance-bot-backups/` on a schedule and pruning old archives. Verify it:

```bash
cat /etc/cron.d/binance-bot-backup
ls -lh /opt/binance-bot-backups/
```

**Restore** (stop service, extract into `data/`, fix ownership, start):

```bash
sudo systemctl stop binance-bot
sudo tar -xzf /opt/binance-bot-backups/binance-data-<stamp>.tgz -C /opt/binance-bot
sudo chown -R binancebot:binancebot /opt/binance-bot/data
sudo systemctl start binance-bot
```

---

## 9. Updating the bot

```bash
# On the VPS — run as binancebot so file ownership stays correct
sudo -u binancebot git -C /opt/binance-bot pull origin master
sudo -u binancebot bash -lc 'cd /opt/binance-bot && npm ci && npm run build'
sudo systemctl restart binance-bot
journalctl -u binance-bot -f
```

> If `npm ci` reports new Playwright/Chromium requirements after an upgrade, re-run the install in **two parts** — never the single `--with-deps` form as root, or the browser lands in root's cache and the service (running as `binancebot`) fails with "Executable doesn't exist":
> ```bash
> sudo npx playwright install-deps chromium                                       # apt libs (root)
> sudo -u binancebot --set-home bash -lc 'cd /opt/binance-bot && npx playwright install chromium'  # browser → binancebot cache
> ```

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| **Service won't start / exits immediately** | Missing `cookies.json`, missing `settings.yml`, or wrong cwd | `journalctl -u binance-bot -n 100`. Confirm files exist under `/opt/binance-bot/{config,data}` and are owned by `binancebot`; confirm the unit has `WorkingDirectory=/opt/binance-bot` (relative paths break otherwise). |
| **`PAUSED_AUTH` + Google Chat alert** | `refresh_token` expired | Re-capture cookies and re-scp — see **step 7**. |
| **Scan finds rows but nothing assigns / wrong language rows** | Live Ant Design UI changed; selectors drifted | Re-verify against `docs/superpowers/specs/2026-05-20-task-18-dom-inspection-report.md`; drive the live site with `dryRun: true` and read `logs/screenshots/`. |
| **Service restart loop every ~10s** | Watchdog hard-exit (a tick hung past `reliability.watchdog.tickTimeoutMs`) on each tick, or a fatal config/auth error | This is *intended* recovery if transient; if it loops continuously, check `journalctl` for the repeated error (hung selector, dead browser, bad config) and fix the root cause. `Restart=always`/`RestartSec=10` mirror the Windows-service auto-restart. |
| **Daily heartbeat fires at the wrong hour** | Host is UTC; `TZ` not set | Ensure `Environment=TZ=Asia/Bangkok` is in the unit (`systemctl cat binance-bot`), then `sudo systemctl daemon-reload && sudo systemctl restart binance-bot`. |
| **Permission/`EACCES` writing `data/` or `logs/`** | Files owned by `root`/`ubuntu` after a manual `sudo` operation | `sudo chown -R binancebot:binancebot /opt/binance-bot/data /opt/binance-bot/logs`. |
| **Second instance error / lock held** | `./data/.lock` left by a crashed process | Confirm no `binance-bot` process is running, then remove `/opt/binance-bot/data/.lock` and restart. |

---

**Quick reference**

```bash
sudo systemctl status binance-bot      # state
journalctl -u binance-bot -f           # live logs
sudo systemctl restart binance-bot     # after config/cookie/secret changes
```
