#!/bin/bash

# Setup cron job for automatic PostgreSQL backups

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SCRIPT="${SCRIPT_DIR}/backup-postgres.sh"
CRON_SCHEDULE="${CRON_SCHEDULE:-0 2 * * *}" # Default: 2 AM daily

echo "=========================================="
echo "Setting up automatic PostgreSQL backups"
echo "=========================================="

# Make backup script executable
chmod +x "$BACKUP_SCRIPT"

# Create cron job
CRON_JOB="${CRON_SCHEDULE} ${BACKUP_SCRIPT} >> /var/log/qnet-backup.log 2>&1"

# Check if cron job already exists
if crontab -l 2>/dev/null | grep -q "$BACKUP_SCRIPT"; then
    echo "⚠️  Cron job already exists. Removing old entry..."
    crontab -l 2>/dev/null | grep -v "$BACKUP_SCRIPT" | crontab -
fi

# Add new cron job
(crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -

echo "✅ Cron job added successfully"
echo ""
echo "Schedule: $CRON_SCHEDULE"
echo "Script: $BACKUP_SCRIPT"
echo ""
echo "To view cron jobs: crontab -l"
echo "To remove cron job: crontab -e"
echo ""

exit 0

