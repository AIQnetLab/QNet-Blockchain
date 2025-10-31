# 🚀 QNet Explorer Deployment Guide

## 📋 Overview

The QNet Explorer is a Next.js-based blockchain explorer that provides a web interface for interacting with the QNet blockchain. After the project restructuring, all components are properly organized and ready for deployment.

## 🏗️ Architecture

```
QNet Explorer
├── Frontend (Next.js) - Port 3000
│   ├── Web Interface
│   ├── API Routes (/api/*)
│   └── Real-time Updates
└── Backend Integration
    ├── QNet Node API (Port 8545)
    ├── Blockchain Data
    └── WebSocket Connections
```

## 🖥️ Local Development

### Prerequisites

- Node.js 18+
- npm or yarn
- Git

### Quick Start

```bash
# Clone repository
git clone https://github.com/AIQnetLab/QNet-Blockchain.git
cd QNet-Blockchain/applications/qnet-explorer/frontend

# Install dependencies
npm install

# Start development server
npm run dev

# Access at http://localhost:3000
```

### Development Scripts

```bash
# Development with hot reload
npm run dev

# Development with Turbopack (faster)
npm run dev:turbo

# Build for production
npm run build

# Start production server
npm start

# Lint and format code
npm run lint
npm run format
```

## 🌐 Production Deployment

### Method 1: Simple Deployment Scripts

#### Windows
```bash
# Run the deployment script
deploy.bat
```

#### Linux/macOS
```bash
# Make script executable
chmod +x deploy.sh

# Run deployment
./deploy.sh
```

### Method 2: Docker Deployment

```bash
# Build and run with Docker Compose
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f
```

### Method 3: Manual Deployment

```bash
# Install dependencies
npm install

# Build for production
npm run build

# Start production server
npm start
```

## 🔧 Configuration

### Environment Variables

Create `.env.local` file:

```bash
# API Configuration
NEXT_PUBLIC_API_URL=http://localhost:8545
NEXT_PUBLIC_WS_URL=ws://localhost:8545/ws

# Network Configuration
NEXT_PUBLIC_NETWORK=mainnet
NEXT_PUBLIC_CHAIN_ID=1

# Feature Flags
NEXT_PUBLIC_ENABLE_FAUCET=true
NEXT_PUBLIC_ENABLE_DAO=true
NEXT_PUBLIC_ENABLE_STAKING=true

# Analytics (Optional)
NEXT_PUBLIC_GA_ID=your-google-analytics-id
```

### Production Environment

```bash
# Direct node connection - fully decentralized
NEXT_PUBLIC_NODE_URL=http://NODE_IP:8001
NEXT_PUBLIC_WS_URL=ws://NODE_IP:8001/ws
NEXT_PUBLIC_NETWORK=mainnet

# Security
NEXT_PUBLIC_ENABLE_ANALYTICS=true
NEXT_PUBLIC_SENTRY_DSN=your-sentry-dsn
```

## 📊 Monitoring

### Health Checks
```bash
# Check application
curl http://localhost:3000/api/health

# Check specific endpoints
curl http://localhost:3000/api/verify-build
```

### Log Management

```bash
# PM2 logs
pm2 logs qnet-explorer

# Docker logs
docker logs qnet-explorer

# Nginx logs
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### Performance Monitoring

```bash
# PM2 monitoring
pm2 monit

# System resources
htop
df -h
free -h
```

### Backup & Updates

```bash
# Backup current deployment
tar -czf qnet-explorer-backup-$(date +%Y%m%d).tar.gz /home/qnet/QNet-Blockchain

# Update deployment
cd /home/qnet/QNet-Blockchain
git pull origin master
cd applications/qnet-explorer/frontend
npm ci --only=production
npm run build
pm2 restart qnet-explorer
```

## 🔒 Security Considerations

### SSL/TLS Configuration

```bash
# Install Certbot for Let's Encrypt
sudo apt install certbot python3-certbot-nginx

# Obtain SSL certificate
sudo certbot --nginx -d your-domain.com

# Auto-renewal
sudo crontab -e
# Add: 0 12 * * * /usr/bin/certbot renew --quiet
```

### Firewall Configuration

```bash
# Configure UFW
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

### Security Headers

Add to Nginx configuration:

```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer-when-downgrade" always;
add_header Content-Security-Policy "default-src 'self' http: https: data: blob: 'unsafe-inline'" always;
```

## 🚀 Available Features

### Web Interface
- **Blockchain Explorer**: Browse blocks, transactions, addresses
- **Real-time Updates**: Live blockchain data
- **Node Dashboard**: Monitor node status
- **Wallet Integration**: Connect wallets

### API Endpoints
- `/api/activate` - Node activation
- `/api/dao/proposals` - DAO proposals
- `/api/dao/vote` - DAO voting
- `/api/faucet/claim` - Token faucet
- `/api/node/activate` - Node activation
- `/api/verify-build` - Build verification

### Advanced Features
- **Matrix Rain Animation**: Quantum-themed UI effects
- **Dark/Light Theme**: User preference themes
- **Responsive Design**: Mobile and desktop optimized
- **Performance Optimized**: Fast loading and rendering

## 🔧 Troubleshooting

### Common Issues

#### Port Already in Use
```bash
# Find process using port 3000
sudo lsof -i :3000
# Kill process
sudo kill -9 <PID>
```

#### Build Failures
```bash
# Clear cache and rebuild
rm -rf .next node_modules
npm install
npm run build
```

#### API Connection Issues
```bash
# Check QNet node is running
curl http://localhost:8545/health

# Check network connectivity
telnet localhost 8545
```

### Performance Issues

```bash
# Increase Node.js memory limit
export NODE_OPTIONS="--max-old-space-size=4096"

# Enable production optimizations
export NODE_ENV=production
```

## 📞 Support

- **GitHub Issues**: https://github.com/AIQnetLab/QNet-Blockchain/issues
- **Documentation**: See `/documentation` directory
- **Community**: Join our Discord/Telegram

---

**The QNet Explorer is fully functional and ready for deployment!** 