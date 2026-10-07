#!/bin/bash
# Web-server hardening for the aiqnet.io host, run after deployment/deploy-aiqnet.sh. It sets http-level
# nginx options only and never writes a site: /etc/nginx/sites-available/aiqnet.io belongs to
# deploy-aiqnet.sh alone, whose file carries the QNet Link relay's own location (no access log, the
# Fetch Metadata refusal, a rate-limit zone of its own), the link host and the redirect-only names
# (docs/protocols/qnet-link-v1.md sections 5 and 12); applications/qnet-explorer/frontend/src/lib/__tests__/
# deploy-config.test.mjs keeps every script other than the deploy scripts from writing a site file.
#
# Security headers come from the app (applications/qnet-explorer/frontend), not from nginx: next.config.js
# sends X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy,
# Cross-Origin-Opener-Policy and HSTS, and src/proxy.ts sends each page's Content-Security-Policy with a
# fresh script nonce. A second Content-Security-Policy from nginx would be enforced alongside the app's, and
# a second copy of the others with a different value would conflict with it.

set -euo pipefail

SITE_FILE=/etc/nginx/sites-available/aiqnet.io

echo "=== QNet web-server hardening ==="

# 1. The site file must be the deploy script's: refuse to go on over one without the relay's rules.
echo "1. Checking the site file written by deployment/deploy-aiqnet.sh..."
if [ ! -f "$SITE_FILE" ]; then
    echo "✗ $SITE_FILE is missing: run step 3 of deployment/deploy-aiqnet.sh first." >&2
    exit 1
fi
for rule in 'location ^~ /api/link/ {' 'access_log off;' 'if ($aiqnet_cross_fetch) {' 'zone=aiqnet_link' 'server_name link.aiqnet.io;'; do
    if ! grep -qF -- "$rule" "$SITE_FILE"; then
        echo "✗ $SITE_FILE lacks '$rule': it is not the file deployment/deploy-aiqnet.sh writes." >&2
        echo "  Replace it with the file of step 3 of deploy-aiqnet.sh, then run this script again." >&2
        exit 1
    fi
done

# 2. http-level options, in conf.d (included in the http context): the nginx version stays out of every
# answer and error page.
echo "2. Hiding the nginx version..."
cat > /etc/nginx/conf.d/security-hardening.conf << 'EOF'
# scripts/security_hardening.sh: http-level options only. Sites are written by deployment/deploy-aiqnet.sh.
server_tokens off;
EOF

# 3. Test and apply.
echo "3. Testing and applying the configuration..."
if nginx -t; then
    systemctl reload nginx
    echo "✓ nginx reloaded"
else
    echo "✗ nginx configuration error: nothing was reloaded" >&2
    exit 1
fi

echo "=== Hardening complete: nginx version hidden; the site file of deploy-aiqnet.sh left as it is ==="
