#!/bin/bash

# PostgreSQL Backup Script for QNet Explorer
# Automatically backs up the database with retention policy

set -e

# Configuration
DB_NAME="${DB_NAME:-qnet_explorer}"
DB_USER="${DB_USER:-qnet_explorer}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/qnet-explorer}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/qnet_explorer_${TIMESTAMP}.sql.gz"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

echo "=========================================="
echo "QNet Explorer PostgreSQL Backup"
echo "=========================================="
echo "Database: $DB_NAME"
echo "User: $DB_USER"
echo "Backup file: $BACKUP_FILE"
echo ""

# Check if PostgreSQL is available
if ! command -v pg_dump &> /dev/null; then
    echo "ERROR: pg_dump not found. Please install PostgreSQL client tools."
    exit 1
fi

# Perform backup
echo "[1/3] Creating backup..."
if pg_dump -U "$DB_USER" -d "$DB_NAME" -F c -f "${BACKUP_FILE%.gz}" 2>/dev/null || \
   pg_dump -U "$DB_USER" -d "$DB_NAME" -f "${BACKUP_FILE%.gz}" 2>/dev/null; then
    echo "✅ Backup created successfully"
else
    echo "❌ Backup failed"
    exit 1
fi

# Compress backup
echo "[2/3] Compressing backup..."
if command -v gzip &> /dev/null; then
    gzip -f "${BACKUP_FILE%.gz}"
    echo "✅ Backup compressed"
else
    echo "⚠️  gzip not found, keeping uncompressed backup"
    mv "${BACKUP_FILE%.gz}" "$BACKUP_FILE"
fi

# Verify backup file exists and is not empty
if [ ! -f "$BACKUP_FILE" ] || [ ! -s "$BACKUP_FILE" ]; then
    echo "❌ Backup file is missing or empty"
    exit 1
fi

BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "✅ Backup size: $BACKUP_SIZE"

# Clean up old backups
echo "[3/3] Cleaning up old backups (retention: $RETENTION_DAYS days)..."
find "$BACKUP_DIR" -name "qnet_explorer_*.sql.gz" -type f -mtime +$RETENTION_DAYS -delete
REMAINING=$(find "$BACKUP_DIR" -name "qnet_explorer_*.sql.gz" -type f | wc -l)
echo "✅ Old backups cleaned. Remaining backups: $REMAINING"

echo ""
echo "=========================================="
echo "✅ Backup completed successfully!"
echo "=========================================="
echo "Backup file: $BACKUP_FILE"
echo "Size: $BACKUP_SIZE"
echo ""

# Optional: Upload to S3 or other storage
if [ -n "$S3_BUCKET" ] && command -v aws &> /dev/null; then
    echo "Uploading to S3..."
    aws s3 cp "$BACKUP_FILE" "s3://$S3_BUCKET/backups/" || echo "⚠️  S3 upload failed"
fi

# Optional: Send notification
if [ -n "$BACKUP_WEBHOOK_URL" ]; then
    curl -X POST "$BACKUP_WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d "{\"status\":\"success\",\"file\":\"$BACKUP_FILE\",\"size\":\"$BACKUP_SIZE\"}" \
        --max-time 5 || echo "⚠️  Webhook notification failed"
fi

exit 0

