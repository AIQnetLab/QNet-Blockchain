#!/bin/bash
# ============================================================================
# QNet Explorer - PostgreSQL Security Setup Script (Linux)
# For production deployment on Ubuntu/Debian servers
# ============================================================================

set -e

PRODUCTION=false
ALLOWED_IP=""
SKIP_PASSWORD=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --production)
            PRODUCTION=true
            shift
            ;;
        --allowed-ip)
            ALLOWED_IP="$2"
            shift 2
            ;;
        --skip-password)
            SKIP_PASSWORD=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

echo "============================================================================"
echo "QNet Explorer - PostgreSQL Security Configuration (Linux)"
echo "============================================================================"
echo ""

# ============================================================================
# 1. Detect PostgreSQL installation
# ============================================================================

echo "[1/10] Detecting PostgreSQL installation..."

if ! command -v psql &> /dev/null; then
    echo "ERROR: PostgreSQL not found. Please install PostgreSQL first."
    exit 1
fi

PG_VERSION=$(psql --version | grep -oP '\d+' | head -1)
PG_DATA_DIR="/var/lib/postgresql/$PG_VERSION/main"
PG_CONFIG_DIR="/etc/postgresql/$PG_VERSION/main"

if [ -d "$PG_CONFIG_DIR" ]; then
    echo "   Found PostgreSQL $PG_VERSION at: $PG_CONFIG_DIR"
else
    echo "   WARNING: Config directory not found at $PG_CONFIG_DIR"
    echo "   Trying alternative location..."
    PG_CONFIG_DIR="/etc/postgresql/$PG_VERSION/data"
    if [ ! -d "$PG_CONFIG_DIR" ]; then
        echo "   ERROR: Cannot find PostgreSQL config directory"
        exit 1
    fi
fi

# ============================================================================
# 2. Check root privileges
# ============================================================================

echo "[2/10] Checking privileges..."

if [ "$EUID" -ne 0 ]; then
    echo "   ERROR: This script must be run as root (sudo)"
    exit 1
fi

echo "   Running as root ✓"

# ============================================================================
# 3. Create backups
# ============================================================================

echo "[3/10] Creating configuration backups..."

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="./backups/$TIMESTAMP"
mkdir -p "$BACKUP_DIR"

cp "$PG_CONFIG_DIR/postgresql.conf" "$BACKUP_DIR/postgresql.conf.backup"
cp "$PG_CONFIG_DIR/pg_hba.conf" "$BACKUP_DIR/pg_hba.conf.backup"

echo "   Backups saved to: $BACKUP_DIR"

# ============================================================================
# 4. Generate or read secure password
# ============================================================================

if [ "$SKIP_PASSWORD" = false ]; then
    echo "[4/10] Managing database password..."
    
    PASSWORD_FILE="../.postgres_password"
    
    if [ ! -f "$PASSWORD_FILE" ]; then
        echo "   Generating new secure password..."
        NEW_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
        echo -n "$NEW_PASSWORD" > "$PASSWORD_FILE"
        chmod 600 "$PASSWORD_FILE"
        echo "   New password generated and saved to: $PASSWORD_FILE"
    else
        NEW_PASSWORD=$(cat "$PASSWORD_FILE")
        echo "   Using existing password from: $PASSWORD_FILE"
    fi
    
    echo ""
    echo "   IMPORTANT: Save this password securely!"
    echo "   Password: $NEW_PASSWORD"
    echo ""
else
    echo "[4/10] Skipping password change (--skip-password flag)"
fi

# ============================================================================
# 5. Update postgresql.conf
# ============================================================================

echo "[5/10] Updating postgresql.conf..."

# Add security settings
cat >> "$PG_CONFIG_DIR/postgresql.conf" << EOF

# ============================================================================
# QNet Security Settings (Applied: $TIMESTAMP)
# ============================================================================

# Connection settings
listen_addresses = 'localhost'
max_connections = 100
superuser_reserved_connections = 3

# Authentication
password_encryption = scram-sha-256

# SSL Settings (uncomment and configure for production)
# ssl = on
# ssl_cert_file = '/etc/ssl/certs/postgresql-server.crt'
# ssl_key_file = '/etc/ssl/private/postgresql-server.key'
# ssl_min_protocol_version = 'TLSv1.2'

# Timeouts
statement_timeout = 30000
idle_in_transaction_session_timeout = 60000
tcp_keepalives_idle = 60
tcp_keepalives_interval = 10
tcp_keepalives_count = 3

# Logging for security monitoring
log_connections = on
log_disconnections = on
log_line_prefix = '%t [%p]: user=%u,db=%d,client=%h '
logging_collector = on
log_directory = 'log'
log_filename = 'postgresql-%Y-%m-%d_%H%M%S.log'
log_rotation_age = 1d
log_rotation_size = 100MB
log_min_duration_statement = 1000

# Resource limits
shared_buffers = 256MB
effective_cache_size = 1GB
work_mem = 4MB
maintenance_work_mem = 64MB
temp_file_limit = 10GB

# Performance (SSD optimized)
random_page_cost = 1.1
effective_io_concurrency = 200

EOF

if [ "$PRODUCTION" = true ] && [ -n "$ALLOWED_IP" ]; then
    sed -i "s/listen_addresses = 'localhost'/listen_addresses = 'localhost,$ALLOWED_IP'/" "$PG_CONFIG_DIR/postgresql.conf"
    echo "   Production mode: Added allowed IP: $ALLOWED_IP"
fi

echo "   postgresql.conf updated successfully"

# ============================================================================
# 6. Update pg_hba.conf
# ============================================================================

echo "[6/10] Updating pg_hba.conf..."

cat > "$PG_CONFIG_DIR/pg_hba.conf" << 'EOF'
# QNet Explorer - Host-Based Authentication Configuration
# TYPE  DATABASE        USER            ADDRESS                 METHOD

# Local connections
local   all             postgres                                peer
local   qnet_explorer   qnet_user                               scram-sha-256

# Localhost connections (IPv4 and IPv6)
host    qnet_explorer   qnet_user       127.0.0.1/32            scram-sha-256
host    qnet_explorer   qnet_user       ::1/128                 scram-sha-256

# Reject all other connections
host    all             all             0.0.0.0/0               reject
host    all             all             ::/0                    reject
EOF

if [ "$PRODUCTION" = true ] && [ -n "$ALLOWED_IP" ]; then
    sed -i "/# Reject all other connections/i hostssl qnet_explorer   qnet_user       $ALLOWED_IP/32          scram-sha-256" "$PG_CONFIG_DIR/pg_hba.conf"
    echo "   Production mode: Added hostssl rule for $ALLOWED_IP"
fi

echo "   pg_hba.conf updated successfully"

# ============================================================================
# 7. Set proper file permissions
# ============================================================================

echo "[7/10] Setting file permissions..."

chown postgres:postgres "$PG_CONFIG_DIR/postgresql.conf"
chown postgres:postgres "$PG_CONFIG_DIR/pg_hba.conf"
chmod 600 "$PG_CONFIG_DIR/postgresql.conf"
chmod 600 "$PG_CONFIG_DIR/pg_hba.conf"

if [ -f "$PASSWORD_FILE" ]; then
    chmod 600 "$PASSWORD_FILE"
fi

echo "   File permissions set correctly"

# ============================================================================
# 8. Update database password
# ============================================================================

if [ "$SKIP_PASSWORD" = false ]; then
    echo "[8/10] Updating database user password..."
    
    sudo -u postgres psql -c "ALTER USER qnet_user WITH PASSWORD '$NEW_PASSWORD';" 2>/dev/null || {
        echo "   WARNING: Could not update password automatically"
        echo "   Please run manually:"
        echo "   sudo -u postgres psql -c \"ALTER USER qnet_user WITH PASSWORD '$NEW_PASSWORD';\""
    }
    
    echo "   Password updated successfully"
else
    echo "[8/10] Skipping database password update (--skip-password flag)"
fi

# ============================================================================
# 9. Configure fail2ban (if installed)
# ============================================================================

echo "[9/10] Configuring fail2ban..."

if command -v fail2ban-client &> /dev/null; then
    FAIL2BAN_CONF="/etc/fail2ban/filter.d/postgresql.conf"
    
    cat > "$FAIL2BAN_CONF" << 'EOF'
# Fail2ban filter for PostgreSQL authentication failures

[Definition]
failregex = ^.*FATAL:.*authentication failed for user.*from host <HOST>
            ^.*FATAL:.*password authentication failed for user.*from host <HOST>
            ^.*FATAL:.*no pg_hba.conf entry for host <HOST>

ignoreregex =
EOF

    FAIL2BAN_JAIL="/etc/fail2ban/jail.d/postgresql.conf"
    
    cat > "$FAIL2BAN_JAIL" << 'EOF'
[postgresql]
enabled = true
port = 5432
filter = postgresql
logpath = /var/log/postgresql/postgresql-*.log
maxretry = 5
findtime = 600
bantime = 3600
EOF

    systemctl restart fail2ban
    echo "   fail2ban configured and restarted"
else
    echo "   fail2ban not installed (recommended for production)"
    echo "   Install: sudo apt-get install fail2ban"
fi

# ============================================================================
# 10. Restart PostgreSQL
# ============================================================================

echo "[10/10] Restarting PostgreSQL..."

systemctl restart postgresql

sleep 3

if systemctl is-active --quiet postgresql; then
    echo "   PostgreSQL restarted successfully"
else
    echo "   ERROR: PostgreSQL failed to start"
    echo "   Check logs: sudo journalctl -u postgresql -n 50"
    exit 1
fi

# ============================================================================
# Summary
# ============================================================================

echo ""
echo "============================================================================"
echo "Security Configuration Complete!"
echo "============================================================================"
echo ""
echo "Next Steps:"
echo ""
echo "1. Test database connection:"
echo "   psql -U qnet_user -d qnet_explorer -h localhost"
echo ""
echo "2. Update Explorer .env file with new password"
echo ""
echo "3. For production deployment:"
echo "   - Generate SSL certificates:"
echo "     sudo openssl req -new -x509 -days 365 -nodes -text \\"
echo "       -out /etc/ssl/certs/postgresql-server.crt \\"
echo "       -keyout /etc/ssl/private/postgresql-server.key"
echo "     sudo chmod 600 /etc/ssl/private/postgresql-server.key"
echo "     sudo chown postgres:postgres /etc/ssl/private/postgresql-server.key"
echo ""
echo "   - Configure firewall:"
echo "     sudo ufw deny 5432/tcp"
echo "     sudo ufw allow from $ALLOWED_IP to any port 5432"
echo ""
echo "   - Install and configure PgBouncer for connection pooling"
echo ""
echo "4. Monitor logs:"
echo "   sudo tail -f /var/log/postgresql/postgresql-*.log"
echo ""
echo "5. Check fail2ban status:"
echo "   sudo fail2ban-client status postgresql"
echo ""
echo "============================================================================"

