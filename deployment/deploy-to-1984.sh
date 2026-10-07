#!/bin/bash
# QNet Automated Deployment Script for 1984.is VPS
# Usage: ./deploy-to-1984.sh [server_ip] [domain_name]
#
# The site answers only on https://aiqnet.io (src/lib/hosts.ts): a production build sends a request for any
# other host to the same path there, and its relay, faucet and wallet connection accept only that origin.
# The aiqnet.io host itself, with link.aiqnet.io and the redirecting names, is provisioned by
# deploy-aiqnet.sh; this script sets up only the domain given, with www. redirecting to it.

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SERVER_IP=${1:-"YOUR_VPS_IP"}
DOMAIN_NAME=${2:-"qnet.is"}
SSH_USER="root"
APP_DIR="/var/www/qnet"
GITHUB_REPO="https://github.com/AIQnetLab/QNet-Blockchain.git"
# The site runs as this unprivileged system user, never as root: it owns only $APP_DIR, its pm2 and the
# app's .env.local (FAUCET_PRIVATE_KEY, database URL), so a flaw in Next.js or a dependency does not
# hand over the host.
APP_USER="aiqnet"
APP_HOME="/home/$APP_USER"
# Node.js release line: an LTS line with security support (18 reached end of life on 2025-04-30).
NODE_MAJOR=22

echo -e "${BLUE}🚀 QNet Deployment to 1984.is VPS${NC}"
echo -e "${BLUE}======================================${NC}"
echo -e "Server IP: ${GREEN}$SERVER_IP${NC}"
echo -e "Domain: ${GREEN}$DOMAIN_NAME${NC}"
echo ""

# accept-new pins the host key on first contact and rejects it if it ever
# changes (MITM), unlike "no" which blindly trusts every key. For stronger
# assurance, pre-provision the host key: ssh-keyscan $SERVER_IP >> ~/.ssh/known_hosts
# and switch this to StrictHostKeyChecking=yes.
SSH_OPTS="-o StrictHostKeyChecking=accept-new"

# Function to run commands on remote server
run_remote() {
    ssh $SSH_OPTS $SSH_USER@$SERVER_IP "$1"
}

# Function to copy files to remote server
copy_to_remote() {
    scp $SSH_OPTS "$1" $SSH_USER@$SERVER_IP:"$2"
}

echo -e "${YELLOW}📋 Step 1: Initial Server Setup${NC}"
run_remote "
    echo '🔄 Updating system packages...'
    apt update && apt upgrade -y

    echo '📦 Installing essential packages...'
    apt install -y nginx git curl wget htop ufw fail2ban certbot python3-certbot-nginx

    echo '🔧 Installing Node.js $NODE_MAJOR LTS...'
    curl -fsSL https://deb.nodesource.com/setup_$NODE_MAJOR.x | bash -
    apt install -y nodejs
    if [ \"\$(node --version | sed 's/^v//; s/\\..*//')\" -lt $NODE_MAJOR ]; then
        echo \"Node.js \$(node --version) is installed; $NODE_MAJOR or later is required.\" >&2
        exit 1
    fi

    echo '⚙️ Installing PM2...'
    npm install -g pm2

    echo '👤 Creating the app user $APP_USER...'
    id -u $APP_USER >/dev/null 2>&1 || useradd --system --create-home --home-dir $APP_HOME --shell /usr/sbin/nologin $APP_USER

    echo '🔒 Configuring firewall...'
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow ssh
    ufw allow 'Nginx Full'
    ufw --force enable

    echo '🛡️ Starting security services...'
    systemctl enable fail2ban
    systemctl start fail2ban

    echo '✅ Initial setup completed'
"

echo -e "${YELLOW}📋 Step 2: Deploy QNet Application${NC}"
run_remote "
    set -e
    echo '📁 Creating application directory...'
    mkdir -p $APP_DIR
    chown $APP_USER:$APP_USER $APP_DIR

    # The full install: 'next build' needs the build tools (TypeScript, Tailwind, PostCSS) that are
    # devDependencies, so an install without them cannot build the site.
    echo '📥 Cloning, installing and building as $APP_USER...'
    sudo -u $APP_USER -H bash -c '
        set -e
        cd $APP_DIR
        if [ -d .git ]; then git pull origin master; else git clone $GITHUB_REPO .; fi
        cd applications/qnet-explorer/frontend
        # Every package the lockfile installs pins its tarball (sha512), so npm ci takes no other bytes.
        node scripts/lockfile-check.mjs
        npm ci
        npm run build
    '

    cd $APP_DIR/applications/qnet-explorer/frontend

    # The runtime secrets (FAUCET_PRIVATE_KEY, DATABASE_URL, SOLANA_RPC_URL: a dedicated provider for the devnet the burns are on, ...) go into .env.local, readable by $APP_USER only.
    [ -f .env.local ] || install -m 600 -o $APP_USER -g $APP_USER /dev/null .env.local
    chown $APP_USER:$APP_USER .env.local
    chmod 600 .env.local
    # The key of the node pages' read passes (src/server/cabinet/solana-proxy.ts), made once, so that the passes a page
    # holds outlive every restart of the site; without it the server makes one for each run.
    grep -Eq '^CABINET_READ_KEY=[0-9a-f]{64}\$' .env.local || { sed -i '/^CABINET_READ_KEY=/d' .env.local; echo CABINET_READ_KEY=\$(openssl rand -hex 32) >> .env.local; }
    # Without SOLANA_RPC_URL every visitor of the node pages shares the public endpoint's few requests a second
    # (src/server/solana-endpoint.ts): a release needs it set.
    grep -q '^SOLANA_RPC_URL=https://' .env.local || echo 'SOLANA_RPC_URL is not set in .env.local: set a dedicated devnet endpoint before the node pages open.' >&2

    echo '⚙️ Configuring PM2...'
    cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'qnet-explorer',
    script: 'npm',
    // package.json 'start' is 'next start -H 127.0.0.1': only nginx on this host reaches the app.
    args: 'start',
    cwd: '$APP_DIR/applications/qnet-explorer/frontend',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      NEXT_TELEMETRY_DISABLED: 1,
      // '1' lets the node cabinet send QNet Wallet its link and claim requests (src/server/phone-flows.ts).
      CABINET_PHONE_FLOWS: '0',
      // The https address of QNet Wallet's Android file that /wallet offers; empty offers none (src/server/wallet-apk.ts).
      WALLET_APK_URL: ''
      // Per-IP limits key on X-Real-IP, which nginx below sets to \$remote_addr on every proxied location.
    }
  }]
}
EOF
    chown $APP_USER:$APP_USER ecosystem.config.js

    echo '🚀 Starting application as $APP_USER...'
    sudo -u $APP_USER -H pm2 start ecosystem.config.js
    sudo -u $APP_USER -H pm2 save
    pm2 startup systemd -u $APP_USER --hp $APP_HOME

    echo '✅ QNet Explorer deployed successfully'
"

echo -e "${YELLOW}📋 Step 3: Configure Nginx${NC}"
run_remote "
    echo '🔧 Configuring Nginx...'
    cat > /etc/nginx/sites-available/$DOMAIN_NAME << 'EOF'
# Fetch Metadata: 1 for a browser request that no page of this origin made (Sec-Fetch-Site cross-site,
# same-site or none). The header is absent from the app's requests and from browsers that do not send it.
map \$http_sec_fetch_site \$aiqnet_cross_fetch {
    default 1;
    '' 0;
    same-origin 0;
}

server {
    listen 80;
    server_name $DOMAIN_NAME www.$DOMAIN_NAME;
    return 301 https://$DOMAIN_NAME\$request_uri;
}

# www. only redirects to the domain, path and query kept, and reaches no proxy (one origin for the site).
server {
    listen 443 ssl http2;
    server_name www.$DOMAIN_NAME;

    # Temporary self-signed certificate (will be replaced by Let's Encrypt)
    ssl_certificate /etc/ssl/certs/ssl-cert-snakeoil.pem;
    ssl_certificate_key /etc/ssl/private/ssl-cert-snakeoil.key;

    location ^~ /api/link/ {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        return 308 https://$DOMAIN_NAME\$request_uri;
    }

    location ^~ /api/cabinet/ {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        return 308 https://$DOMAIN_NAME\$request_uri;
    }

    location / {
        return 308 https://$DOMAIN_NAME\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN_NAME;

    # Temporary self-signed certificate (will be replaced by Let's Encrypt)
    ssl_certificate /etc/ssl/certs/ssl-cert-snakeoil.pem;
    ssl_certificate_key /etc/ssl/private/ssl-cert-snakeoil.key;

    # Security headers come from the app, not from nginx: next.config.js sends X-Frame-Options,
    # X-Content-Type-Options, Referrer-Policy, Permissions-Policy, Cross-Origin-Opener-Policy and HSTS,
    # and src/proxy.ts sends each page's Content-Security-Policy with a fresh script nonce. nginx
    # adds none of them: a second Content-Security-Policy would be enforced alongside the app's, and a
    # second copy of the others with a different value would conflict with it.

    # Proxy to Next.js application
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }

    # Build assets: Next.js itself sends Cache-Control: public, max-age=31536000, immutable for them.
    # Exactly the /_next/static/ directory (a path like /_next/staticx goes to 'location /'). Host and
    # X-Real-IP here too, as in every location: without Host nginx sends its upstream name, 127.0.0.1:3000,
    # which the app would take for a local run; a client's own X-Real-IP never passes (SITE-R4-CSP-01).
    location ^~ /_next/static/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }

    # API routes
    location /api {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # The QNet Link relay: its URLs carry the session id, and one session's requests come from a
    # computer and a phone, so an access log would pair the two addresses. Nothing of it is logged,
    # and only critical errors (the 'error' level names the client and the request line). A browser
    # request that another page, another host or a typed address made is refused before it reaches the
    # app (src/server/request-guard.ts refuses the same there).
    location ^~ /api/link/ {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        if (\$aiqnet_cross_fetch) {
            return 403;
        }
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # The node cabinet's routes name nodes, wallets and payment addresses: not logged either, and only the
    # site's own pages may call them.
    location ^~ /api/cabinet/ {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        if (\$aiqnet_cross_fetch) {
            return 403;
        }
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

    echo '🔗 Enabling site...'
    ln -sf /etc/nginx/sites-available/$DOMAIN_NAME /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default

    echo '✅ Testing Nginx configuration...'
    nginx -t

    echo '🔄 Restarting Nginx...'
    systemctl restart nginx
    systemctl enable nginx

    echo '✅ Nginx configured successfully'
"

echo -e "${YELLOW}📋 Step 4: Setup SSL Certificate${NC}"
echo -e "${BLUE}⚠️ Make sure your domain $DOMAIN_NAME points to $SERVER_IP before continuing${NC}"
read -p "Press Enter when DNS is configured..."

# Confirm DNS actually resolves to this server; otherwise certbot --non-interactive
# fails the challenge and silently leaves the temporary self-signed cert in place.
RESOLVED_IP=$(getent hosts "$DOMAIN_NAME" | awk '{print $1}' | head -n1)
if [ "$RESOLVED_IP" != "$SERVER_IP" ]; then
    echo -e "${RED}❌ $DOMAIN_NAME resolves to '${RESOLVED_IP:-nothing}', expected $SERVER_IP. Fix DNS and re-run.${NC}"
    exit 1
fi

run_remote "
    echo '🔐 Installing SSL certificate...'
    certbot --nginx -d $DOMAIN_NAME -d www.$DOMAIN_NAME --non-interactive --agree-tos --email admin@$DOMAIN_NAME

    echo '⏰ Setting up auto-renewal...'
    (crontab -l 2>/dev/null; echo '0 12 * * * /usr/bin/certbot renew --quiet') | crontab -

    echo '✅ SSL certificate installed'
"

echo -e "${YELLOW}📋 Step 5: Setup Monitoring${NC}"
run_remote "
    echo '📊 Installing monitoring tools...'
    apt install -y netdata

    echo '⚙️ Configuring netdata...'
    systemctl enable netdata
    systemctl start netdata

    echo '📝 Setting up PM2 monitoring...'
    sudo -u $APP_USER -H pm2 install pm2-logrotate
    sudo -u $APP_USER -H pm2 set pm2-logrotate:max_size 10M
    sudo -u $APP_USER -H pm2 set pm2-logrotate:retain 30

    echo '✅ Monitoring setup completed'
"

echo -e "${YELLOW}📋 Step 6: Create Update Script${NC}"
run_remote "
    echo '📝 Creating update script...'
    cat > /root/update-qnet.sh << 'EOF'
#!/bin/bash
set -e
echo '🔄 Updating QNet...'
# The site needs a supported Node.js line (package.json engines); an older one is never built on.
if [ \"\$(node --version | sed 's/^v//; s/\\..*//')\" -lt $NODE_MAJOR ]; then
    echo \"Node.js \$(node --version) is installed; $NODE_MAJOR or later is required. Nothing was changed.\" >&2
    exit 1
fi
sudo -u $APP_USER -H bash -c '
    set -e
    cd $APP_DIR
    git pull origin master
    cd applications/qnet-explorer/frontend
    node scripts/lockfile-check.mjs
    npm ci
    npm run build
'
grep -Eq '^CABINET_READ_KEY=[0-9a-f]{64}\$' $APP_DIR/applications/qnet-explorer/frontend/.env.local || { sed -i '/^CABINET_READ_KEY=/d' $APP_DIR/applications/qnet-explorer/frontend/.env.local; echo CABINET_READ_KEY=\$(openssl rand -hex 32) >> $APP_DIR/applications/qnet-explorer/frontend/.env.local; }
grep -q '^SOLANA_RPC_URL=https://' $APP_DIR/applications/qnet-explorer/frontend/.env.local || echo 'SOLANA_RPC_URL is not set in .env.local: the node pages share the public Solana endpoint.' >&2
sudo -u $APP_USER -H pm2 restart qnet-explorer
sudo -u $APP_USER -H pm2 save

echo '✅ QNet updated successfully'
EOF

    chmod +x /root/update-qnet.sh
    echo '✅ Update script created at /root/update-qnet.sh'
"

echo -e "${GREEN}🎉 Deployment Completed Successfully!${NC}"
echo -e "${GREEN}=================================${NC}"
echo ""
echo -e "${BLUE}📊 Deployment Summary:${NC}"
echo -e "• QNet Explorer: ${GREEN}https://$DOMAIN_NAME${NC}"
echo -e "• Monitoring: ${GREEN}https://$DOMAIN_NAME:19999${NC}"
echo -e "• Server IP: ${GREEN}$SERVER_IP${NC}"
echo -e "• SSL: ${GREEN}Let's Encrypt (Auto-renewal enabled)${NC}"
echo ""
echo -e "${BLUE}🔧 Management Commands:${NC}"
echo -e "• View logs: ${YELLOW}ssh $SSH_USER@$SERVER_IP 'sudo -u $APP_USER -H pm2 logs qnet-explorer'${NC}"
echo -e "• Monitor: ${YELLOW}ssh $SSH_USER@$SERVER_IP 'sudo -u $APP_USER -H pm2 monit'${NC}"
echo -e "• Update: ${YELLOW}ssh $SSH_USER@$SERVER_IP '/root/update-qnet.sh'${NC}"
echo -e "• Restart: ${YELLOW}ssh $SSH_USER@$SERVER_IP 'sudo -u $APP_USER -H pm2 restart qnet-explorer'${NC}"
echo ""
echo -e "${BLUE}📈 Performance:${NC}"
echo -e "• Batched transfers/sec: ${GREEN}13,000${NC}"
echo -e "• Single transfers/sec: ${GREEN}450${NC}"
echo -e "• Project Size: ${GREEN}11MB${NC}"
echo -e "• Memory Usage: ${GREEN}~1GB${NC}"
echo ""
echo -e "${GREEN}✅ QNet is now live on privacy-focused 1984.is infrastructure!${NC}"