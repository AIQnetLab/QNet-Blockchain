#!/bin/bash

# QNet Production Bridge Deployment Script
# Deploys bridge server to production environment

set -e

echo "🚀 Starting QNet Production Bridge Deployment..."

# Configuration
IMAGE_NAME="qnet/bridge-server"
CONTAINER_NAME="qnet-bridge-production"
PORT=8080
DOMAIN="bridge.qnet.io"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed"
        exit 1
    fi
    
    if ! command -v docker-compose &> /dev/null; then
        log_error "Docker Compose is not installed"
        exit 1
    fi
    
    log_info "✅ Prerequisites check passed"
}

# Build Docker image
build_image() {
    log_info "Building Docker image..."
    
    docker build -t $IMAGE_NAME:latest .
    docker tag $IMAGE_NAME:latest $IMAGE_NAME:v2.0.0
    
    log_info "✅ Docker image built successfully"
}

# Stop existing container
stop_existing() {
    if docker ps -q -f name=$CONTAINER_NAME | grep -q .; then
        log_info "Stopping existing container..."
        docker stop $CONTAINER_NAME
        docker rm $CONTAINER_NAME
    fi
}

# Deploy container
deploy_container() {
    log_info "Deploying production container..."

    # JWT_SECRET must be provisioned out-of-band (secrets manager / CI secret) and
    # kept stable across deploys. Minting a fresh one per restart silently invalidates
    # every issued token and leaves no rotation/audit trail, so fail closed instead.
    if [ -z "$JWT_SECRET" ]; then
        log_error "JWT_SECRET is not set. Provision it from your secrets manager and export it before deploying."
        exit 1
    fi

    docker run -d \
        --name $CONTAINER_NAME \
        --restart unless-stopped \
        -p $PORT:8080 \
        -e ENVIRONMENT=production \
        -e JWT_SECRET="$JWT_SECRET" \
        -e CORS_ORIGINS="https://wallet.qnet.io,https://aiqnet.io" \
        --memory="1g" \
        --cpus="2" \
        --log-driver json-file \
        --log-opt max-size=200m \
        --log-opt max-file=50 \
        $IMAGE_NAME:latest
    
    log_info "✅ Container deployed successfully"
}

# Setup reverse proxy (Nginx)
setup_nginx() {
    log_info "Setting up Nginx reverse proxy..."
    
    cat > /etc/nginx/sites-available/qnet-bridge << EOF
server {
    listen 80;
    server_name $DOMAIN;
    
    # Redirect to HTTPS
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;
    
    # SSL Configuration (Let's Encrypt)
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512:ECDHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    
    # Security headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    
    # Rate limiting
    limit_req_zone \$binary_remote_addr zone=api:10m rate=10r/s;
    limit_req zone=api burst=20 nodelay;
    
    location / {
        proxy_pass http://localhost:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        
        # CORS headers
        add_header Access-Control-Allow-Origin "https://wallet.qnet.io" always;
        add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
        
        if (\$request_method = 'OPTIONS') {
            return 204;
        }
    }
    
    location /api/health {
        proxy_pass http://localhost:$PORT/api/health;
        access_log off;
    }
}
EOF
    
    # Enable site
    ln -sf /etc/nginx/sites-available/qnet-bridge /etc/nginx/sites-enabled/
    
    # Test and reload Nginx
    nginx -t && systemctl reload nginx
    
    log_info "✅ Nginx configured successfully"
}

# Setup SSL certificate
setup_ssl() {
    log_info "Setting up SSL certificate..."
    
    if ! command -v certbot &> /dev/null; then
        log_warn "Certbot not installed, installing..."
        apt-get update
        apt-get install -y certbot python3-certbot-nginx
    fi
    
    # Fail loudly if DNS does not yet resolve to this host: certbot --non-interactive
    # would otherwise fail the challenge and leave the self-signed cert silently in place.
    if ! host "$DOMAIN" > /dev/null 2>&1 && ! nslookup "$DOMAIN" > /dev/null 2>&1; then
        log_error "DNS for $DOMAIN does not resolve yet. Point it at this server and re-run before issuing SSL."
        exit 1
    fi

    # Generate certificate
    certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email admin@qnet.io

    log_info "✅ SSL certificate configured"
}

# Health check
health_check() {
    log_info "Performing health check..."
    
    # Wait for container to start
    sleep 10
    
    # Check container status
    if ! docker ps | grep -q $CONTAINER_NAME; then
        log_error "Container is not running"
        exit 1
    fi
    
    # Check API health
    for i in {1..30}; do
        if curl -f http://localhost:$PORT/api/health &> /dev/null; then
            log_info "✅ Health check passed"
            return 0
        fi
        log_warn "Waiting for service to be ready... ($i/30)"
        sleep 2
    done
    
    log_error "Health check failed"
    exit 1
}

# Setup monitoring
setup_monitoring() {
    log_info "Setting up monitoring..."
    
    # Create monitoring script
    cat > /usr/local/bin/qnet-bridge-monitor.sh << 'EOF'
#!/bin/bash

CONTAINER_NAME="qnet-bridge-production"
WEBHOOK_URL="${SLACK_WEBHOOK_URL}"

# Check container health
if ! docker ps | grep -q $CONTAINER_NAME; then
    echo "$(date): QNet Bridge container is down" >> /var/log/qnet-bridge-monitor.log
    
    # Restart container
    docker start $CONTAINER_NAME
    
    # Send alert if webhook is configured
    if [ ! -z "$WEBHOOK_URL" ]; then
        curl -X POST -H 'Content-type: application/json' \
            --data '{"text":"🚨 QNet Bridge container was down and has been restarted"}' \
            $WEBHOOK_URL
    fi
fi

# Check API health
if ! curl -f http://localhost:8080/api/health &> /dev/null; then
    echo "$(date): QNet Bridge API health check failed" >> /var/log/qnet-bridge-monitor.log
fi
EOF
    
    chmod +x /usr/local/bin/qnet-bridge-monitor.sh
    
    # Add to crontab
    (crontab -l 2>/dev/null; echo "*/5 * * * * /usr/local/bin/qnet-bridge-monitor.sh") | crontab -
    
    log_info "✅ Monitoring configured"
}

# Main deployment function
main() {
    log_info "🚀 QNet Production Bridge Deployment Started"
    
    check_prerequisites
    build_image
    stop_existing
    deploy_container
    health_check
    
    # Only setup Nginx and SSL if running as root
    if [ "$EUID" -eq 0 ]; then
        setup_nginx
        setup_ssl
        setup_monitoring
    else
        log_warn "Skipping Nginx/SSL setup (requires root)"
    fi
    
    # Display deployment information
    echo
    log_info "🎉 QNet Production Bridge Deployment Completed!"
    log_info "🌐 Bridge URL: https://$DOMAIN"
    log_info "🏥 Health Check: https://$DOMAIN/api/health"
    log_info "📊 Container: $CONTAINER_NAME"
    log_info "🔍 Logs: docker logs -f $CONTAINER_NAME"
    echo
    log_info "API Endpoints:"
    log_info "  - POST /api/auth/wallet - Wallet authentication"
    log_info "  - POST /api/v1/phase1/activate - Phase 1 (1DEV burn) activation"
    log_info "  - POST /api/v2/phase2/activate - Phase 2 (QNC Pool 3) activation"
    log_info "  - GET /api/v2/pool3/info - Pool 3 information"
    log_info "  - GET /api/network/stats - Network statistics"
    echo
}

# Run main function
main "$@" 