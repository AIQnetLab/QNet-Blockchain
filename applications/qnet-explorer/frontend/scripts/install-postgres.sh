#!/bin/bash

set -e

echo "=========================================="
echo "QNet Explorer PostgreSQL Installation"
echo "=========================================="

# Install PostgreSQL
echo "[1/5] Installing PostgreSQL..."
sudo apt update
sudo apt install -y postgresql-15 postgresql-contrib

# Start PostgreSQL service
echo "[2/5] Starting PostgreSQL service..."
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Generate secure password
DB_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-25)
DB_USER="qnet_explorer"
DB_NAME="qnet_explorer"

echo "[3/5] Creating database and user..."
sudo -u postgres psql <<EOF
CREATE DATABASE ${DB_NAME};
CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};
\q
EOF

# Configure PostgreSQL (works with and without Docker)
echo "[4/5] Configuring PostgreSQL..."
sudo sed -i "s/#listen_addresses = 'localhost'/listen_addresses = 'localhost'/" /etc/postgresql/15/main/postgresql.conf

# Allow local and Docker network access (if Docker is used)
echo "host    ${DB_NAME}    ${DB_USER}    127.0.0.1/32    md5" | sudo tee -a /etc/postgresql/15/main/pg_hba.conf
echo "host    ${DB_NAME}    ${DB_USER}    172.17.0.0/16    md5" | sudo tee -a /etc/postgresql/15/main/pg_hba.conf

# Restart PostgreSQL
echo "[5/5] Restarting PostgreSQL..."
sudo systemctl restart postgresql

echo ""
echo "=========================================="
echo "✅ PostgreSQL installed successfully!"
echo "=========================================="
echo ""
echo "Database credentials:"
echo "  Database: ${DB_NAME}"
echo "  User: ${DB_USER}"
echo "  Password: ${DB_PASSWORD}"
echo ""
echo "Add to your .env file:"
echo "  POSTGRES_PASSWORD=${DB_PASSWORD}"
echo "  # For Docker: DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@host.docker.internal:5432/${DB_NAME}"
echo "  # For local (no Docker): DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}"
echo ""
echo "Next steps:"
echo "  1. Run migrations: npm run db:migrate"
echo "  2. Start sync service: npm run sync:start"
echo ""

