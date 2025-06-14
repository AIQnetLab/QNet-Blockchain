#!/bin/bash
# snapshot_backup.sh
DATE=$(date +%Y%m%d)
SNAPSHOT_DIR="/path/to/qnet/blockchain_data/snapshots"
BACKUP_DIR="/backup/qnet/$DATE"

mkdir -p "$BACKUP_DIR"

# Create new snapshot
curl -X POST http://localhost:8000/api/v1/snapshot/create

# Wait for snapshot creation
sleep 30

# Copy snapshots
rsync -av "$SNAPSHOT_DIR/" "$BACKUP_DIR/"

# Encrypt backup
tar czf "$BACKUP_DIR.tar.gz" "$BACKUP_DIR"
gpg --encrypt --recipient your@email.com "$BACKUP_DIR.tar.gz"

# Clean up
rm -rf "$BACKUP_DIR"
rm "$BACKUP_DIR.tar.gz"

# Keep only last 7 days of backups
find /backup/qnet/ -name "*.tar.gz.gpg" -type f -mtime +7 -delete