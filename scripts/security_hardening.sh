#!/bin/bash

echo "=== QNet Security Hardening Script ==="
echo "Applying additional security measures..."

# 1. Fix Nginx rate limiting configuration
echo "1. Configuring rate limiting..."
cat > /etc/nginx/conf.d/rate-limiting.conf << 'EOF'
# Rate limiting zones
limit_req_zone $binary_remote_addr zone=general:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=api:10m rate=5r/s;
EOF

# 2. Update security headers
echo "2. Configuring security headers..."
cat > /etc/nginx/snippets/security-headers.conf << 'EOF'
# Security Headers
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https:; frame-ancestors 'none';" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;

# Hide Nginx version
server_tokens off;
EOF

# 3. Create improved site configuration
echo "3. Updating site configuration..."
cat > /etc/nginx/sites-available/aiqnet.io << 'EOF'
server {
    listen 80;
    server_name aiqnet.io www.aiqnet.io;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name aiqnet.io www.aiqnet.io;

    # SSL Configuration
    ssl_certificate /etc/letsencrypt/live/aiqnet.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/aiqnet.io/privkey.pem;

    # SSL Security
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512:ECDHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # Include security headers
    include /etc/nginx/snippets/security-headers.conf;

    # Rate limiting
    limit_req zone=general burst=20 nodelay;

    # Block common attack patterns
    location ~* \.(php|asp|exe|pl|cgi|scgi)$ {
        return 444;
    }

    # Block access to sensitive files
    location ~* \.(env|git|svn|htaccess|htpasswd)$ {
        return 444;
    }

    # Block admin panels and common attack paths
    location ~* /(admin|wp-admin|phpmyadmin|adminer|config|\.git) {
        return 444;
    }

    # Main application
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Security
        proxy_hide_header X-Powered-By;
    }

    # API rate limiting
    location /api/ {
        limit_req zone=api burst=10 nodelay;
        
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

# 4. Test and apply configuration
echo "4. Testing and applying configuration..."
if nginx -t; then
    echo "✓ Nginx configuration is valid"
    systemctl reload nginx
    echo "✓ Nginx reloaded successfully"
else
    echo "✗ Nginx configuration error!"
    exit 1
fi

echo "=== Security Hardening Complete ==="
echo "✓ Rate limiting configured"
echo "✓ Security headers applied"
echo "✓ Attack patterns blocked"
echo "✓ Nginx configuration updated"
echo ""
echo "Site is secured and ready for production!" 