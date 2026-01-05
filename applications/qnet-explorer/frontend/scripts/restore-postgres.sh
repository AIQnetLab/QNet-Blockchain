#!/bin/bash

# PostgreSQL Restore Script for QNet Explorer

set -e

# Configuration
DB_NAME="${DB_NAME:-qnet_explorer}"
DB_USER="${DB_USER:-qnet_explorer}"
BACKUP_FILE="${1:-}"

if [ -z "$BACKUP_FILE" ]; then
    echo "Usage: $0 <backup_file.sql.gz>"
    echo ""
    echo "Available backups:"
    ls -lh /var/backups/qnet-explorer/qnet_explorer_*.sql.gz 2>/dev/null || echo "No backups found"
    exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
    echo "ERROR: Backup file not found: $BACKUP_FILE"
    exit 1
fi

echo "=========================================="
echo "QNet Explorer PostgreSQL Restore"
echo "=========================================="
echo "Database: $DB_NAME"
echo "User: $DB_USER"
echo "Backup file: $BACKUP_FILE"
echo ""
echo "⚠️  WARNING: This will overwrite the current database!"
read -p "Are you sure? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "Restore cancelled"
    exit 0
fi

# Check if PostgreSQL is available
if ! command -v psql &> /dev/null; then
    echo "ERROR: psql not found. Please install PostgreSQL client tools."
    exit 1
fi

# Decompress if needed
TEMP_FILE="${BACKUP_FILE%.gz}"
if [[ "$BACKUP_FILE" == *.gz ]]; then
    echo "[1/3] Decompressing backup..."
    gunzip -c "$BACKUP_FILE" > "$TEMP_FILE" || {
        echo "❌ Failed to decompress backup"
        exit 1
    }
else
    TEMP_FILE="$BACKUP_FILE"
fi

# Restore database
echo "[2/3] Restoring database..."
if psql -U "$DB_USER" -d "$DB_NAME" < "$TEMP_FILE" 2>/dev/null || \
   pg_restore -U "$DB_USER" -d "$DB_NAME" "$TEMP_FILE" 2>/dev/null; then
    echo "✅ Database restored successfully"
else
    echo "❌ Restore failed"
    [ "$TEMP_FILE" != "$BACKUP_FILE" ] && rm -f "$TEMP_FILE"
    exit 1
fi

# Clean up temp file
[ "$TEMP_FILE" != "$BACKUP_FILE" ] && rm -f "$TEMP_FILE"

echo "[3/3] Verifying restore..."
ROW_COUNT=$(psql -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM transactions;" 2>/dev/null || echo "0")
echo "✅ Transactions in database: $ROW_COUNT"

echo ""
echo "=========================================="
echo "✅ Restore completed successfully!"
echo "=========================================="

exit 0

