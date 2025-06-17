#!/bin/bash

echo "=== QNet NPM Security Fix ==="
echo "Fixing vulnerabilities in dependencies..."

# Navigate to application directory
cd /var/www/qnet/applications/qnet-explorer/frontend

echo "1. Creating backup..."
cp package-lock.json package-lock.json.backup

echo "2. Checking vulnerabilities..."
npm audit --audit-level=high

echo "3. Fixing vulnerabilities..."
npm audit fix --force

echo "4. Rebuilding application..."
npm run build

echo "5. Restarting service..."
systemctl restart qnet-explorer

echo "=== Fix Complete ==="
echo "Check application status:"
echo "systemctl status qnet-explorer"
echo "curl -I https://aiqnet.io" 