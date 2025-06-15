# QNet Single Domain Deployment Guide

## 🎯 Recommended Domain: `qnet.is`

### Why qnet.is?
- ✅ **Short & Memorable** - Easy to type and remember
- ✅ **Privacy-Focused** - Icelandic domain with strong privacy laws
- ✅ **Same Provider** - Available at 1984.is (VPS + Domain)
- ✅ **Unique** - No confusion with other projects
- ✅ **Professional** - Clean, tech-focused appearance

## 🌐 Single Domain Structure

### Main Routes
```
https://qnet.is/                    - Landing page & project info
https://qnet.is/explorer            - Blockchain explorer interface
https://qnet.is/wallet              - Wallet download & setup
https://qnet.is/docs                - Technical documentation
https://qnet.is/api                 - API documentation & endpoints
https://qnet.is/mobile              - Mobile SDK downloads
https://qnet.is/node                - Node setup guides
https://qnet.is/whitepaper          - Technical whitepaper
```

### API Endpoints
```
https://qnet.is/api/blocks          - Block data
https://qnet.is/api/transactions    - Transaction data
https://qnet.is/api/nodes           - Network nodes
https://qnet.is/api/stats           - Network statistics
https://qnet.is/api/faucet          - Testnet faucet
```

## 🔧 Nginx Configuration for Single Domain

### Complete Site Configuration
```nginx
# /etc/nginx/sites-available/qnet.is
server {
    listen 80;
    server_name qnet.is www.qnet.is;
    return 301 https://qnet.is$request_uri;
}

server {
    listen 443 ssl http2;
    server_name qnet.is www.qnet.is;

    # SSL Configuration
    ssl_certificate /etc/letsencrypt/live/qnet.is/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/qnet.is/privkey.pem;
    
    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
    add_header Content-Security-Policy "default-src 'self' http: https: data: blob: 'unsafe-inline'" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # Main application (Next.js)
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
    }

    # Static files optimization
    location /_next/static {
        proxy_pass http://localhost:3000;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # API routes with rate limiting
    location /api {
        limit_req zone=api burst=20 nodelay;
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # API-specific headers
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
        add_header Access-Control-Allow-Headers "DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range" always;
    }

    # Wallet downloads (static files)
    location /downloads {
        alias /var/www/qnet/downloads;
        autoindex on;
        add_header Content-Disposition "attachment";
    }

    # Documentation (if separate from main app)
    location /docs {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Health check endpoint
    location /health {
        access_log off;
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }
}

# Rate limiting configuration
http {
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
}
```

## 🚀 Next.js Route Structure

### File Organization
```
applications/qnet-explorer/frontend/
├── pages/
│   ├── index.tsx                   # Landing page (/)
│   ├── explorer/
│   │   ├── index.tsx              # Explorer home (/explorer)
│   │   ├── blocks/
│   │   │   └── [id].tsx           # Block details (/explorer/blocks/123)
│   │   └── transactions/
│   │       └── [hash].tsx         # Transaction details (/explorer/transactions/abc)
│   ├── wallet/
│   │   ├── index.tsx              # Wallet info (/wallet)
│   │   └── download.tsx           # Download page (/wallet/download)
│   ├── docs/
│   │   ├── index.tsx              # Documentation home (/docs)
│   │   ├── api.tsx                # API docs (/docs/api)
│   │   └── setup.tsx              # Setup guide (/docs/setup)
│   ├── mobile/
│   │   └── index.tsx              # Mobile SDK (/mobile)
│   └── api/
│       ├── blocks/
│       │   └── index.ts           # GET /api/blocks
│       ├── transactions/
│       │   └── index.ts           # GET /api/transactions
│       └── stats/
│           └── index.ts           # GET /api/stats
```

## 📱 Mobile-Friendly Navigation

### Main Navigation Menu
```typescript
const navigation = [
  { name: 'Home', href: '/' },
  { name: 'Explorer', href: '/explorer' },
  { name: 'Wallet', href: '/wallet' },
  { name: 'Mobile SDK', href: '/mobile' },
  { name: 'Docs', href: '/docs' },
  { name: 'API', href: '/docs/api' }
];
```

## 🔐 SSL Certificate Setup

### Single Domain Certificate
```bash
# Install certificate for main domain and www subdomain
certbot --nginx -d qnet.is -d www.qnet.is

# Auto-renewal setup
echo "0 12 * * * /usr/bin/certbot renew --quiet" | crontab -
```

## 📊 Analytics & Monitoring

### Single Domain Tracking
```javascript
// Google Analytics 4 setup
gtag('config', 'GA_MEASUREMENT_ID', {
  page_title: 'QNet Blockchain',
  page_location: 'https://qnet.is'
});

// Track different sections
gtag('event', 'page_view', {
  page_title: 'Explorer',
  page_location: 'https://qnet.is/explorer'
});
```

## 💰 Cost Comparison

### Domain Options
| Domain | Annual Cost | Provider | Privacy | Professional |
|--------|-------------|----------|---------|--------------|
| qnet.is | $30 | 1984.is | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| quantumnet.com | $15 | 1984.is | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| qnetwork.io | $40 | 1984.is | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| qnet.org | $20 | 1984.is | ⭐⭐⭐⭐ | ⭐⭐⭐ |

### Total Monthly Cost
- **VPS #2**: $16.80/month
- **qnet.is domain**: $2.50/month ($30/year)
- **SSL**: Free (Let's Encrypt)
- **Total**: **$19.30/month**

## 🎯 SEO Optimization for Single Domain

### Meta Tags Structure
```html
<!-- Home page -->
<title>QNet - Post-Quantum Blockchain Network</title>
<meta name="description" content="QNet: High-performance blockchain with post-quantum cryptography. 424,411 TPS, mobile-optimized, privacy-focused." />

<!-- Explorer page -->
<title>QNet Explorer - Blockchain Explorer</title>
<meta name="description" content="Explore QNet blockchain: blocks, transactions, network statistics. Real-time data with 424,411 TPS performance." />

<!-- Wallet page -->
<title>QNet Wallet - Secure Crypto Wallet</title>
<meta name="description" content="Download QNet Wallet: Browser extension and mobile app with post-quantum security and hardware wallet support." />
```

### Sitemap.xml
```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://qnet.is/</loc><priority>1.0</priority></url>
  <url><loc>https://qnet.is/explorer</loc><priority>0.9</priority></url>
  <url><loc>https://qnet.is/wallet</loc><priority>0.8</priority></url>
  <url><loc>https://qnet.is/mobile</loc><priority>0.8</priority></url>
  <url><loc>https://qnet.is/docs</loc><priority>0.7</priority></url>
  <url><loc>https://qnet.is/docs/api</loc><priority>0.6</priority></url>
</urlset>
```

## 🚀 Deployment Command

### Single Domain Deployment
```bash
# Deploy to single domain
./deployment/deploy-to-1984.sh YOUR_VPS_IP qnet.is

# The script will automatically:
# ✅ Configure nginx for qnet.is
# ✅ Setup SSL certificate
# ✅ Configure all routes
# ✅ Setup monitoring
```

## 📈 Benefits of Single Domain

### Advantages
- ✅ **Lower Cost** - One domain instead of multiple
- ✅ **Easier Management** - Single SSL certificate
- ✅ **Better SEO** - All content under one domain
- ✅ **Simpler Navigation** - Users stay on same site
- ✅ **Unified Branding** - Consistent experience
- ✅ **Easier Analytics** - Single tracking setup

### Performance Benefits
- 🚀 **No DNS lookups** between sections
- 🚀 **Shared caching** across all pages
- 🚀 **Single SSL handshake** for entire site
- 🚀 **Better Core Web Vitals** scores

---

**🎯 Recommendation: Go with `qnet.is` for maximum privacy and professionalism!** 