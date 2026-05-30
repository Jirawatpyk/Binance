#!/usr/bin/env bash
#
# setup-vps.sh — Provision a fresh Oracle Cloud Always Free (Ampere ARM, aarch64)
# Ubuntu 22.04 LTS host to run the Binance auto-assign bot.
#
# Run with sudo:   sudo bash deploy/setup-vps.sh
#
# What it does (idempotent where reasonable):
#   - installs prerequisites + Node 20 LTS (NodeSource)
#   - creates the non-login system user 'binancebot'
#   - clones/updates the repo into /opt/binance-bot
#   - installs deps, the Playwright Chromium browser, and builds (npm run build)
#   - lays out data/ logs/ and the off-tree backup dir
#   - installs + enables (but does NOT start) the binance-bot.service systemd unit
#
# It deliberately does NOT start the service: the gitignored secrets/cookies
# (config/settings.yml, config/translators.yml, .env, data/cookies.json,
# google-credentials.json) must be scp'd from the operator's Windows machine first.
#
set -euo pipefail

# ---- Shared deploy conventions (must match the systemd unit + runbook) -------
INSTALL_DIR="/opt/binance-bot"
BACKUP_DIR="/opt/binance-bot-backups"
SERVICE_USER="binancebot"
SERVICE_GROUP="binancebot"
SERVICE_NAME="binance-bot.service"
REPO_URL="https://github.com/Jirawatpyk/Binance.git"
REPO_BRANCH="master"
UNIT_SRC="${INSTALL_DIR}/deploy/binance-bot.service"
UNIT_DEST="/etc/systemd/system/${SERVICE_NAME}"

echo "==> Binance bot VPS provisioning (Oracle Ampere ARM / Ubuntu 22.04)"

# ---- Guard: must be root -----------------------------------------------------
if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: this script must be run as root." >&2
  echo "       Re-run with:  sudo bash deploy/setup-vps.sh" >&2
  exit 1
fi

# ---- 1. apt prerequisites ----------------------------------------------------
echo "==> [1/9] apt-get update + base prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg

# ---- 2. Node 20 LTS via NodeSource ------------------------------------------
# Install only if node is missing or not on the v20 line (idempotent re-runs).
echo "==> [2/9] Node 20 LTS"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null)" != v20.* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "    node $(node -v) / npm $(npm -v)"

# ---- 3. Create the non-login system user ------------------------------------
echo "==> [3/9] system user '${SERVICE_USER}'"
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  # --system: no aging, low UID; --shell nologin: cannot interactively log in.
  useradd --system --shell /usr/sbin/nologin --create-home "${SERVICE_USER}"
else
  echo "    user already exists, skipping"
fi

# ---- 4. Clone or update the repo --------------------------------------------
echo "==> [4/9] repo at ${INSTALL_DIR}"
if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
  git clone --branch "${REPO_BRANCH}" "${REPO_URL}" "${INSTALL_DIR}"
else
  echo "    repo present, pulling latest ${REPO_BRANCH}"
  git -C "${INSTALL_DIR}" pull --ff-only origin "${REPO_BRANCH}"
fi
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${INSTALL_DIR}"

# ---- 5. Playwright system deps (root) then browser (user) -------------------
# DECISION on the --with-deps split:
#   'npx playwright install --with-deps chromium' does TWO things: (a) apt-get
#   install the OS libraries Chromium needs (requires root), and (b) download the
#   Chromium build into the *current user's* ~/.cache/ms-playwright. If we ran the
#   whole thing as root, the browser would land in /root/.cache and the binancebot
#   service user would not find it. So we SPLIT:
#     - as root:        npx playwright install-deps chromium   (apt libs only)
#     - as binancebot:  npx playwright install chromium         (browser -> its $HOME)
echo "==> [5/9] Playwright: system deps as root, browser as ${SERVICE_USER}"
( cd "${INSTALL_DIR}" && npx --yes playwright install-deps chromium )

# ---- 6. Install deps + browser + build, all as the service user -------------
echo "==> [6/9] npm ci, Playwright Chromium, build (as ${SERVICE_USER})"
sudo -u "${SERVICE_USER}" --set-home bash -euo pipefail -c "
  cd '${INSTALL_DIR}'
  npm ci
  npx --yes playwright install chromium
  npm run build
"

# ---- 7. Runtime directories + off-tree backups ------------------------------
echo "==> [7/9] data/, logs/, and backup dir"
install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${INSTALL_DIR}/data"
install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${INSTALL_DIR}/logs"
install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${BACKUP_DIR}"

# ---- 8. Install the daily backup cron job -----------------------------------
# Without this the backup never runs (backup-data.sh + the runbook assume it is
# scheduled here). cron.d needs a user column; TZ pins 03:30 to Asia/Bangkok
# regardless of the host's (UTC) system clock.
echo "==> [8/9] backup cron (/etc/cron.d/binance-bot-backup)"
chmod +x "${INSTALL_DIR}/deploy/backup-data.sh"
printf 'TZ=Asia/Bangkok\n30 3 * * * %s %s/deploy/backup-data.sh >> %s/logs/backup.log 2>&1\n' \
  "${SERVICE_USER}" "${INSTALL_DIR}" "${INSTALL_DIR}" > /etc/cron.d/binance-bot-backup
chmod 0644 /etc/cron.d/binance-bot-backup

# ---- 9. Install + enable the systemd unit (do NOT start) --------------------
echo "==> [9/9] systemd unit ${SERVICE_NAME}"
if [[ ! -f "${UNIT_SRC}" ]]; then
  echo "ERROR: expected unit file at ${UNIT_SRC} but it is missing." >&2
  echo "       Ensure deploy/binance-bot.service is committed in the repo." >&2
  exit 1
fi
cp "${UNIT_SRC}" "${UNIT_DEST}"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"

# ---- Done: print the manual next steps --------------------------------------
cat <<EOF

============================================================================
  PROVISIONING COMPLETE — service is ENABLED but NOT STARTED.
============================================================================

The service cannot run yet: the gitignored secrets + cookies are not present.
Copy these files from your Windows machine into ${INSTALL_DIR}/ (preserving
the relative paths shown). Example using scp / pscp from Windows PowerShell:

  REQUIRED (bot will not work without these):
    config\\settings.yml          ->  ${INSTALL_DIR}/config/settings.yml
    config\\translators.yml       ->  ${INSTALL_DIR}/config/translators.yml
    .env                          ->  ${INSTALL_DIR}/.env
    data\\cookies.json            ->  ${INSTALL_DIR}/data/cookies.json

  OPTIONAL:
    google-credentials.json       ->  ${INSTALL_DIR}/google-credentials.json   (only if sheets: is used)
    data\\state.json              ->  ${INSTALL_DIR}/data/state.json           (preserves round-robin + idempotency)
    data\\health.json             ->  ${INSTALL_DIR}/data/health.json          (optional; recreated otherwise)

  Example (run from the repo dir on Windows; replace HOST):
    scp config\\settings.yml config\\translators.yml .env  ubuntu@HOST:/tmp/
    scp data\\cookies.json                                ubuntu@HOST:/tmp/
  then on the VPS:
    sudo install -D -o ${SERVICE_USER} -g ${SERVICE_GROUP} /tmp/settings.yml    ${INSTALL_DIR}/config/settings.yml
    sudo install -D -o ${SERVICE_USER} -g ${SERVICE_GROUP} /tmp/translators.yml ${INSTALL_DIR}/config/translators.yml
    sudo install -D -o ${SERVICE_USER} -g ${SERVICE_GROUP} /tmp/.env            ${INSTALL_DIR}/.env
    sudo install -D -o ${SERVICE_USER} -g ${SERVICE_GROUP} /tmp/cookies.json    ${INSTALL_DIR}/data/cookies.json
  and for any OPTIONAL files you copied (install -D fixes ownership too):
    sudo install -D -o ${SERVICE_USER} -g ${SERVICE_GROUP} /tmp/google-credentials.json ${INSTALL_DIR}/google-credentials.json
    sudo install -D -o ${SERVICE_USER} -g ${SERVICE_GROUP} /tmp/state.json             ${INSTALL_DIR}/data/state.json
  Rule of thumb: anything you scp via /tmp must end up owned by ${SERVICE_USER}, or the
  service (ProtectSystem=full, running as ${SERVICE_USER}) hits EACCES reading it.

NOTE on cookies/2FA: capture data/cookies.json on your OWN machine via
'npm run capture-cookies' (visible browser, enter the Google Authenticator code).
The bot self-refreshes the access token via refresh_token, so you only re-upload
cookies when the refresh_token itself expires (the bot alerts on Google Chat /
PAUSED_AUTH when that happens).

Once the files above are in place, start and tail the service:

    sudo systemctl start ${SERVICE_NAME}
    sudo journalctl -u ${SERVICE_NAME} -f

============================================================================
EOF
