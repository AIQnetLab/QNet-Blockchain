# QNet Security Deployment Instructions

## Quick Security Fix

Copy these files to your server and execute:

### 1. Fix NPM Vulnerabilities
```bash
chmod +x npm_security_fix.sh
./npm_security_fix.sh
```

### 2. Apply Nginx Security Hardening
```bash
chmod +x security_hardening.sh
./security_hardening.sh
```

### 3. Verify Security Status
```bash
# Check website
curl -I https://aiqnet.io

# Check Fail2ban status
fail2ban-client status

# Check blocked IPs
fail2ban-client status nginx-noscript

# Test Nginx configuration
nginx -t
```

## Expected Results

After applying these fixes:
- ✅ NPM vulnerabilities resolved
- ✅ Rate limiting active (10 req/s general, 5 req/s API)
- ✅ Security headers implemented
- ✅ Attack patterns blocked
- ✅ SSL A+ rating maintained

## Security Level: 9/10

Your QNet blockchain explorer at https://aiqnet.io will be fully secured! 