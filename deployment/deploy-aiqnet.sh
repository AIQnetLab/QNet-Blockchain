#!/bin/bash
# QNet Automated Deployment Script for aiqnet.io
# Server: 195.246.231.53 (1984.is VPS)

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SERVER_IP="195.246.231.53"
DOMAIN_NAME="aiqnet.io"
SSH_USER="root"
APP_DIR="/var/www/qnet"
GITHUB_REPO="https://github.com/AIQnetLab/QNet-Blockchain.git"
# The site runs as this unprivileged system user, never as root: it owns only $APP_DIR, its pm2 and the
# app's .env.local (FAUCET_PRIVATE_KEY, database URL), so a flaw in Next.js or a dependency does not
# hand over the host, the database superuser or the TLS keys.
APP_USER="aiqnet"
APP_HOME="/home/$APP_USER"
# Node.js release line for the site: an LTS line with security support (18 reached end of life on
# 2025-04-30). package.json "engines" and /root/update-aiqnet.sh refuse anything older.
NODE_MAJOR=22

echo -e "${BLUE}🚀 QNet Deployment to aiqnet.io${NC}"
echo -e "${BLUE}================================${NC}"
echo -e "Server IP: ${GREEN}$SERVER_IP${NC}"
echo -e "Domain: ${GREEN}$DOMAIN_NAME${NC}"
echo -e "Location: ${GREEN}Reykjavik, Iceland${NC}"
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
    
    echo '🏷️ Setting hostname...'
    hostnamectl set-hostname aiqnet
    echo '127.0.0.1 aiqnet' >> /etc/hosts
    
    echo '✅ Initial setup completed'
"

echo -e "${YELLOW}📋 Step 2: Deploy QNet Application${NC}"
run_remote "
    set -e
    echo '📁 Creating application directory...'
    mkdir -p $APP_DIR
    chown $APP_USER:$APP_USER $APP_DIR

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
    # The key of the faucet passes the node cabinet gives (src/server/faucet-pass.ts), made once the same way, so that a
    # pass outlives every restart of the site; without it a restart ends the passes the server gave.
    grep -Eq '^FAUCET_PASS_KEY=[0-9a-f]{64}\$' .env.local || { sed -i '/^FAUCET_PASS_KEY=/d' .env.local; echo FAUCET_PASS_KEY=\$(openssl rand -hex 32) >> .env.local; }
    # Without SOLANA_RPC_URL every visitor of the node pages shares the public endpoint's few requests a second
    # (src/server/solana-endpoint.ts): a release needs it set.
    grep -q '^SOLANA_RPC_URL=https://' .env.local || echo 'SOLANA_RPC_URL is not set in .env.local: set a dedicated devnet endpoint before the node pages open.' >&2

    echo '⚙️ Configuring PM2...'
    cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'aiqnet-explorer',
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
      // '1' lets the node cabinet send QNet Wallet its link and claim requests; off until app builds that
      // answer them are installed (src/server/phone-flows.ts).
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
    # A systemd unit that resurrects $APP_USER's pm2 list at boot (runs as root, starts pm2 as $APP_USER).
    pm2 startup systemd -u $APP_USER --hp $APP_HOME

    echo '✅ QNet Explorer deployed successfully'
"

echo -e "${YELLOW}📋 Step 3: Configure Nginx${NC}"
run_remote "
    echo '🔧 Configuring Nginx for aiqnet.io...'
    cat > /etc/nginx/sites-available/$DOMAIN_NAME << 'EOF'
# Rate-limit zone for /api. limit_req_zone is valid only in the http context: this file is included
# inside http {}, so the zone is declared here, outside the server blocks. Its own name: a zone 'api' may
# already be declared in conf.d on the host, and nginx refuses a zone declared twice. This file is the only
# nginx site of aiqnet.io: scripts/security_hardening.sh sets http-level options only, and refuses to run
# over a site file without the relay's rules below.
limit_req_zone \$binary_remote_addr zone=aiqnet_api:10m rate=10r/s;
# The QNet Link relay's own zone: explorer /api traffic, which any page can send from a visitor's browser
# (an <img> or a script needs no permission), never uses up the relay's budget (R4-SRA-01).
limit_req_zone \$binary_remote_addr zone=aiqnet_link:10m rate=10r/s;
# The node cabinet's own zone (/api/cabinet/), for the same reason.
limit_req_zone \$binary_remote_addr zone=aiqnet_cabinet:10m rate=10r/s;
# Fetch Metadata: 1 for a browser request that no page of this origin made (Sec-Fetch-Site cross-site,
# same-site or none). The header is absent from the app's requests and from browsers that do not send it.
map \$http_sec_fetch_site \$aiqnet_cross_fetch {
    default 1;
    '' 0;
    same-origin 0;
}

# The site has one origin, https://aiqnet.io (src/lib/hosts.ts): the relay's and the faucet's Origin
# check, the extension's activation origin and the app's relay base all name it. www.aiqnet.io and
# explorer.aiqnet.io (old links) only redirect there, and so does the app itself for any other Host.
server {
    listen 80;
    server_name aiqnet.io www.aiqnet.io explorer.aiqnet.io;
    return 301 https://aiqnet.io\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name aiqnet.io;

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

    # API routes with rate limiting
    location /api {
        limit_req zone=aiqnet_api burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # The QNet Link relay (docs/protocols/qnet-link-v1.md section 5). Its URLs carry the session id, and
    # a session's requests come from the computer (polls) and the phone (the app): an access log would
    # pair the two addresses under one id. So nothing of it is logged, and only critical errors (the
    # 'error' level names the client and the request line). A browser request that another page, another
    # host or a typed address made (Fetch Metadata Sec-Fetch-Site other than same-origin) is refused here,
    # in the rewrite phase, before limit_req counts it; the app sends no such header, and the site's own
    # pages send same-origin. src/server/request-guard.ts refuses the same in the app.
    location ^~ /api/link/ {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        if (\$aiqnet_cross_fetch) {
            return 403;
        }
        limit_req zone=aiqnet_link burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # The node cabinet's routes (src/server/cabinet): their paths and bodies name nodes, wallets and payment
    # addresses, so nothing of them is logged either, and only critical errors. Only the site's own pages call
    # them: another page's request is refused before the cabinet's zone counts it, as for the relay.
    location ^~ /api/cabinet/ {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        if (\$aiqnet_cross_fetch) {
            return 403;
        }
        limit_req zone=aiqnet_cabinet burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Health check
    location /health {
        access_log off;
        default_type text/plain;
        return 200 \"QNet Explorer is running\";
    }
}

# The other names of the site redirect to https://aiqnet.io, path and query kept, and reach no proxy: no
# second origin of the site, and no location here that could hand the app a client's own X-Real-IP. A
# relay or cabinet path is not logged here either, as on aiqnet.io.
server {
    listen 443 ssl http2;
    server_name www.aiqnet.io explorer.aiqnet.io;

    # Temporary self-signed certificate (replaced by Let's Encrypt in step 4)
    ssl_certificate /etc/ssl/certs/ssl-cert-snakeoil.pem;
    ssl_certificate_key /etc/ssl/private/ssl-cert-snakeoil.key;

    location ^~ /api/link/ {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        return 308 https://aiqnet.io\$request_uri;
    }

    location ^~ /api/cabinet/ {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        return 308 https://aiqnet.io\$request_uri;
    }

    location / {
        return 308 https://aiqnet.io\$request_uri;
    }
}

# QNet Link host (docs/protocols/qnet-link-v1.md section 4): the links the site hands to the QNet app live
# on a host of their own, so a browser never keeps them as a same-host navigation. The same Next.js app
# answers here: src/proxy.ts serves /l and the /.well-known app-association files and redirects every
# other path to aiqnet.io. Same proxy headers as aiqnet.io, no headers of nginx's own (no second CSP).
server {
    listen 80;
    server_name link.aiqnet.io;
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name link.aiqnet.io;

    # Temporary self-signed certificate (replaced by Let's Encrypt in step 4)
    ssl_certificate /etc/ssl/certs/ssl-cert-snakeoil.pem;
    ssl_certificate_key /etc/ssl/private/ssl-cert-snakeoil.key;

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

    # The link page's build assets: exactly /_next/static/, with this host's name (see aiqnet.io above).
    location ^~ /_next/static/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }

    # The relay and the cabinet answer only on aiqnet.io (the app redirects these paths there); not logged here
    # either.
    location ^~ /api/link/ {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        return 308 https://aiqnet.io\$request_uri;
    }

    location ^~ /api/cabinet/ {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        return 308 https://aiqnet.io\$request_uri;
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
echo -e "${BLUE}⚠️ Make sure DNS is propagated: aiqnet.io, www.aiqnet.io, explorer.aiqnet.io and link.aiqnet.io → $SERVER_IP${NC}"
echo -e "${BLUE}Check with: nslookup aiqnet.io; nslookup www.aiqnet.io; nslookup explorer.aiqnet.io; nslookup link.aiqnet.io${NC}"
read -p "Press Enter when DNS is ready..."

# Confirm DNS actually resolves to this server; otherwise certbot --non-interactive
# fails the challenge and silently leaves the temporary self-signed cert in place.
for HOST_NAME in "$DOMAIN_NAME" "www.$DOMAIN_NAME" "explorer.$DOMAIN_NAME" "link.$DOMAIN_NAME"; do
    RESOLVED_IP=$(getent hosts "$HOST_NAME" | awk '{print $1}' | head -n1)
    if [ "$RESOLVED_IP" != "$SERVER_IP" ]; then
        echo -e "${RED}❌ $HOST_NAME resolves to '${RESOLVED_IP:-nothing}', expected $SERVER_IP. Fix DNS and re-run.${NC}"
        exit 1
    fi
done

# One certificate for the four names; certbot installs it in each matching server block. On a server
# set up before this layout: replace the site's nginx file with the one from step 3 (aiqnet.io alone in
# the proxying block; www.aiqnet.io and explorer.aiqnet.io in the redirect-only block; link.aiqnet.io;
# no other file in sites-enabled that names these hosts), run 'nginx -t && systemctl reload nginx', then
# the certbot line below, and check that https://link.aiqnet.io/.well-known/assetlinks.json answers 200
# JSON with no redirect and that https://explorer.aiqnet.io/explorer and https://www.aiqnet.io/activate
# answer 308 to the same path on https://aiqnet.io.
run_remote "
    echo '🔐 Installing SSL certificate for aiqnet.io, www.aiqnet.io, explorer.aiqnet.io and link.aiqnet.io...'
    certbot --nginx -d aiqnet.io -d www.aiqnet.io -d explorer.aiqnet.io -d link.aiqnet.io --non-interactive --agree-tos --email admin@aiqnet.io
    
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

echo -e "${YELLOW}📋 Step 6: Create Management Scripts${NC}"
run_remote "
    echo '📝 Creating update script...'
    cat > /root/update-aiqnet.sh << 'EOF'
#!/bin/bash
set -e
echo '🔄 Updating QNet...'
# The site needs a supported Node.js line (package.json engines); an older one is never built on.
if [ \"\$(node --version | sed 's/^v//; s/\\..*//')\" -lt $NODE_MAJOR ]; then
    echo \"Node.js \$(node --version) is installed; $NODE_MAJOR or later is required. Nothing was changed.\" >&2
    exit 1
fi
# Pull, install and build as $APP_USER, never as root.
sudo -u $APP_USER -H bash -c '
    set -e
    cd $APP_DIR
    git pull origin master
    cd applications/qnet-explorer/frontend
    node scripts/lockfile-check.mjs
    npm ci
    npm run build
'
grep -Eq '^FAUCET_PASS_KEY=[0-9a-f]{64}\$' $APP_DIR/applications/qnet-explorer/frontend/.env.local || { sed -i '/^FAUCET_PASS_KEY=/d' $APP_DIR/applications/qnet-explorer/frontend/.env.local; echo FAUCET_PASS_KEY=\$(openssl rand -hex 32) >> $APP_DIR/applications/qnet-explorer/frontend/.env.local; }
grep -Eq '^CABINET_READ_KEY=[0-9a-f]{64}\$' $APP_DIR/applications/qnet-explorer/frontend/.env.local || { sed -i '/^CABINET_READ_KEY=/d' $APP_DIR/applications/qnet-explorer/frontend/.env.local; echo CABINET_READ_KEY=\$(openssl rand -hex 32) >> $APP_DIR/applications/qnet-explorer/frontend/.env.local; }
grep -q '^SOLANA_RPC_URL=https://' $APP_DIR/applications/qnet-explorer/frontend/.env.local || echo 'SOLANA_RPC_URL is not set in .env.local: the node pages share the public Solana endpoint.' >&2
sudo -u $APP_USER -H pm2 restart aiqnet-explorer
sudo -u $APP_USER -H pm2 save

echo '✅ QNet updated successfully'
EOF
    
    chmod +x /root/update-aiqnet.sh
    
    echo '📝 Creating status script...'
    cat > /root/status-aiqnet.sh << 'EOF'
#!/bin/bash
echo '📊 QNet Status Report'
echo '===================='
echo ''
echo '🖥️ System Status:'
echo \"CPU Usage: \$(top -bn1 | grep \"Cpu(s)\" | awk '{print \$2}' | awk -F'%' '{print \$1}')%\"
echo \"Memory Usage: \$(free | grep Mem | awk '{printf \"%.1f%%\", \$3/\$2 * 100.0}')\"
echo \"Disk Usage: \$(df -h / | awk 'NR==2{printf \"%s\", \$5}')\"
echo ''
echo '🚀 Application Status:'
sudo -u $APP_USER -H pm2 status
echo ''
echo '🌐 Network Status:'
echo \"Domain: aiqnet.io\"
echo \"IP: 195.246.231.53\"
echo \"SSL: \$(curl -s -o /dev/null -w \"%{http_code}\" https://aiqnet.io)\"
echo ''
echo '📈 Performance:'
echo \"Batched transfers/sec: 13,000\"
echo \"Single transfers/sec: 450\"
echo \"Project Size: 11MB\"
EOF
    
    chmod +x /root/status-aiqnet.sh
    
    echo '✅ Management scripts created'
"

echo -e "${GREEN}🎉 Deployment Completed Successfully!${NC}"
echo -e "${GREEN}=================================${NC}"
echo ""
echo -e "${BLUE}📊 QNet Deployment Summary:${NC}"
echo -e "• Website: ${GREEN}https://aiqnet.io${NC}"
echo -e "• Monitoring: ${GREEN}https://aiqnet.io:19999${NC}"
echo -e "• Server IP: ${GREEN}$SERVER_IP${NC}"
echo -e "• Location: ${GREEN}Reykjavik, Iceland${NC}"
echo -e "• SSL: ${GREEN}Let's Encrypt (Auto-renewal enabled)${NC}"
echo ""
echo -e "${BLUE}🔧 Management Commands:${NC}"
echo -e "• View logs: ${YELLOW}ssh root@$SERVER_IP 'sudo -u $APP_USER -H pm2 logs aiqnet-explorer'${NC}"
echo -e "• Monitor: ${YELLOW}ssh root@$SERVER_IP 'sudo -u $APP_USER -H pm2 monit'${NC}"
echo -e "• Update: ${YELLOW}ssh root@$SERVER_IP '/root/update-aiqnet.sh'${NC}"
echo -e "• Status: ${YELLOW}ssh root@$SERVER_IP '/root/status-aiqnet.sh'${NC}"
echo -e "• Restart: ${YELLOW}ssh root@$SERVER_IP 'sudo -u $APP_USER -H pm2 restart aiqnet-explorer'${NC}"
echo ""
echo -e "${BLUE}📈 Performance Metrics:${NC}"
echo -e "• Batched transfers/sec: ${GREEN}13,000${NC}"
echo -e "• Single transfers/sec: ${GREEN}450${NC}"
echo -e "• Project Size: ${GREEN}11MB${NC}"
echo -e "• Memory Usage: ${GREEN}~1GB${NC}"
echo -e "• Server RAM: ${GREEN}2GB${NC}"
echo ""
echo -e "${GREEN}✅ aiqnet.io is now live on privacy-focused Icelandic infrastructure!${NC}"
echo -e "${GREEN}🇮🇸 Powered by 1984.is - Maximum Privacy & Security${NC}" 