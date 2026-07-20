#!/usr/bin/env bash
# Nightly PostgreSQL backup for the qirop database.
# Authenticates with the DATABASE_URL already in the backend .env — no sudo,
# so it runs fine from an ordinary user's crontab.
#
# Install on the VPS:
#   mkdir -p ~/backups && cp ~/qirop-backend/deploy/backup-db.sh ~/backups/
#   chmod +x ~/backups/backup-db.sh
#   ~/backups/backup-db.sh          # test run once
#   crontab -e   →   30 21 * * * /home/rdpuser/backups/backup-db.sh
#   (21:30 UTC = 2:30 AM PKT, while the school sleeps)
#
# Restore (into the live DB — destructive, stop the service first):
#   sudo systemctl stop qirop-backend
#   sudo -u postgres pg_restore -d qirop --clean --if-exists <file>.dump
#   sudo systemctl start qirop-backend
set -euo pipefail

ENV_FILE="$HOME/qirop-backend/.env"
BACKUP_DIR="$HOME/backups"
KEEP_DAYS=14

DB_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d'"' -f2)
[ -n "$DB_URL" ] || { echo "DATABASE_URL not found in $ENV_FILE" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/qirop-$(date +%F-%H%M).dump"

pg_dump -Fc "$DB_URL" > "$FILE"

# Drop backups older than KEEP_DAYS so the disk never fills up.
find "$BACKUP_DIR" -name "qirop-*.dump" -mtime +"$KEEP_DAYS" -delete

echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
