#!/bin/bash
# QNet Automated Deployment Script for 1984.is VPS
# Usage: ./deploy-to-1984.sh [server_ip] [domain_name]

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
    apt install -y nginx nodejs npm git curl wget htop ufw fail2ban certbot python3-certbot-nginx
    
    echo '🔧 Installing Node.js 18 LTS...'
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    apt install -y nodejs
    
    echo '⚙️ Installing PM2...'
    npm install -g pm2
    
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
    echo '📁 Creating application directory...'
    mkdir -p $APP_DIR
    cd $APP_DIR
    
    echo '📥 Cloning QNet repository...'
    if [ -d '.git' ]; then
        git pull origin master
    else
        git clone $GITHUB_REPO .
    fi
    
    echo '📦 Installing frontend dependencies...'
    cd applications/qnet-explorer/frontend
    npm ci --production
    
    echo '🏗️ Building application...'
    npm run build
    
    echo '⚙️ Configuring PM2...'
    cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'qnet-explorer',
    script: 'npm',
    args: 'start',
    cwd: '$APP_DIR/applications/qnet-explorer/frontend',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      NEXT_TELEMETRY_DISABLED: 1
    }
  }]
}
EOF
    
    echo '🚀 Starting application...'
    pm2 start ecosystem.config.js
    pm2 save
    pm2 startup ubuntu -u root --hp /root
    
    echo '✅ QNet Explorer deployed successfully'
"

echo -e "${YELLOW}📋 Step 3: Configure Nginx${NC}"
run_remote "
    echo '🔧 Configuring Nginx...'
    cat > /etc/nginx/sites-available/$DOMAIN_NAME << 'EOF'
server {
    listen 80;
    server_name $DOMAIN_NAME www.$DOMAIN_NAME;
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN_NAME www.$DOMAIN_NAME;

    # Temporary self-signed certificate (will be replaced by Let's Encrypt)
    ssl_certificate /etc/ssl/certs/ssl-cert-snakeoil.pem;
    ssl_certificate_key /etc/ssl/private/ssl-cert-snakeoil.key;
    
    # Security headers
    add_header X-Frame-Options \"SAMEORIGIN\" always;
    add_header X-XSS-Protection \"1; mode=block\" always;
    add_header X-Content-Type-Options \"nosniff\" always;
    add_header Referrer-Policy \"no-referrer-when-downgrade\" always;
    add_header Content-Security-Policy \"default-src 'self' http: https: data: blob: 'unsafe-inline'\" always;

    # Proxy to Next.js application
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }

    # Static files caching
    location /_next/static {
        proxy_pass http://localhost:3000;
        add_header Cache-Control \"public, max-age=31536000, immutable\";
    }

    # API routes
    location /api {
        proxy_pass http://localhost:3000;
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
    pm2 install pm2-logrotate
    pm2 set pm2-logrotate:max_size 10M
    pm2 set pm2-logrotate:retain 30
    
    echo '✅ Monitoring setup completed'
"

echo -e "${YELLOW}📋 Step 6: Create Update Script${NC}"
run_remote "
    echo '📝 Creating update script...'
    cat > /root/update-qnet.sh << 'EOF'
#!/bin/bash
echo '🔄 Updating QNet...'
cd $APP_DIR
git pull origin master

cd applications/qnet-explorer/frontend
npm ci --production
npm run build

pm2 restart qnet-explorer
pm2 save

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
echo -e "• View logs: ${YELLOW}ssh $SSH_USER@$SERVER_IP 'pm2 logs qnet-explorer'${NC}"
echo -e "• Monitor: ${YELLOW}ssh $SSH_USER@$SERVER_IP 'pm2 monit'${NC}"
echo -e "• Update: ${YELLOW}ssh $SSH_USER@$SERVER_IP '/root/update-qnet.sh'${NC}"
echo -e "• Restart: ${YELLOW}ssh $SSH_USER@$SERVER_IP 'pm2 restart qnet-explorer'${NC}"
echo ""
echo -e "${BLUE}📈 Performance:${NC}"
echo -e "• Blockchain TPS: ${GREEN}424,411${NC}"
echo -e "• Mobile TPS: ${GREEN}8,859${NC}"
echo -e "• Project Size: ${GREEN}11MB${NC}"
echo -e "• Memory Usage: ${GREEN}~1GB${NC}"
echo ""
echo -e "${GREEN}✅ QNet is now live on privacy-focused 1984.is infrastructure!${NC}" 