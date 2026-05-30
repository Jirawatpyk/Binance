#!/usr/bin/env bash
#
# backup-data.sh — daily backup of the binance-bot runtime data dir.
#
# Tars + gzips /opt/binance-bot/data (state.json, health.json, cookies.json)
# into /opt/binance-bot-backups/, then prunes archives older than 14 days so
# disk stays bounded (mirrors the bot's own disk-SLO discipline).
#
# Target: Oracle Cloud Always Free, Ampere ARM (aarch64), Ubuntu 22.04 LTS.
# Run as the 'binancebot' service user (it owns /opt/binance-bot/data).
# Driven daily by /etc/cron.d/binance-bot-backup at 03:30 Asia/Bangkok
# (installed by deploy/setup-vps.sh).
#
set -euo pipefail

# Force a consistent, TZ-correct timestamp regardless of the host's system TZ
# (the VPS is UTC; we want Asia/Bangkok stamps to match the bot's local-time logic).
export TZ="Asia/Bangkok"

DATA_DIR="/opt/binance-bot/data"
BACKUP_DIR="/opt/binance-bot-backups"
RETAIN_DAYS=14

STAMP="$(date +%Y-%m-%d-%H%M)"
ARCHIVE="${BACKUP_DIR}/binance-data-${STAMP}.tgz"

if [[ ! -d "${DATA_DIR}" ]]; then
  echo "ERROR: data dir not found: ${DATA_DIR}" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

# Create the archive.
#
# The bot may be mid-write when we read (single-instance, writes state.json /
# health.json on each tick). GNU tar can emit "file changed as we read it" and
# exit 1 in that case — that is ACCEPTABLE here: the next nightly backup will
# capture a consistent copy, and cookies.json (the only hard-to-recreate file)
# is written rarely. So we treat tar's "changed while reading" (exit 1) as a
# warning and only fail the backup on a real error (exit >= 2).
#
# -C "$(dirname ...)" + basename keeps the archive paths relative ("data/...").
set +e
tar -czf "${ARCHIVE}" -C "$(dirname "${DATA_DIR}")" "$(basename "${DATA_DIR}")"
tar_rc=$?
set -e

if [[ ${tar_rc} -eq 1 ]]; then
  echo "WARN: tar reported a file changed while reading (data dir mid-write); archive is still usable."
elif [[ ${tar_rc} -gt 1 ]]; then
  echo "ERROR: tar failed with exit code ${tar_rc}" >&2
  exit "${tar_rc}"
fi

# Prune archives older than RETAIN_DAYS days.
find "${BACKUP_DIR}" -name 'binance-data-*.tgz' -type f -mtime "+${RETAIN_DAYS}" -delete

SIZE="$(du -h "${ARCHIVE}" | cut -f1)"
echo "Backup complete: ${ARCHIVE} (${SIZE})"

# Optional offsite copy (NOT implemented here): pipe/sync the archive to a free
# object-storage tier with rclone, e.g.
#   rclone copy "${ARCHIVE}" r2:binance-bot-backups        # Cloudflare R2
#   rclone copy "${ARCHIVE}" b2:binance-bot-backups        # Backblaze B2
# Configure the remote once with `rclone config`; keep credentials off the repo.
