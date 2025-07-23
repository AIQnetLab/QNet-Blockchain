# 1DEV Burn Contract Deployment Guide

## Overview

This guide explains how to deploy the 1DEV burn tracking contract to Solana devnet/mainnet.

## Prerequisites

### 1. Install Solana CLI
```bash
# Linux/macOS
curl -sSf https://release.solana.com/stable/install | sh

# Windows
# Download from: https://github.com/solana-labs/solana/releases
# Or use: winget install Solana.SolanaCLI
```

### 2. Install Anchor CLI
```bash
# Install AVM (Anchor Version Manager)
cargo install --git https://github.com/coral-xyz/anchor avm --locked

# Install latest Anchor
avm install latest
avm use latest
```

### 3. Create/Configure Wallet
```bash
# Create new wallet
solana-keygen new

# Set devnet cluster
solana config set --url https://api.devnet.solana.com

# Request airdrop (devnet only)
solana airdrop 2
```

## Deployment Steps

### Option 1: Automatic Deployment (Recommended)

**Linux/macOS:**
```bash
chmod +x deploy.sh
./deploy.sh
```

**Windows:**
```powershell
PowerShell -ExecutionPolicy Bypass -File deploy.ps1
```

### Option 2: Manual Deployment

1. **Build the contract:**
   ```bash
   anchor build
   ```

2. **Deploy to devnet:**
   ```bash
   anchor deploy
   ```

3. **Get program ID:**
   ```bash
   anchor keys list
   ```

4. **Initialize contract:**
   ```bash
   anchor run initialize
   ```

## Post-Deployment

### Update Configuration

1. **Update environment variable:**
   ```bash
   export BURN_TRACKER_PROGRAM_ID="<your-program-id>"
   ```

2. **Update config files:**
   - `Anchor.toml`
   - `src/lib.rs`
   - All QNet integration files

3. **Update QNet nodes:**
   - Restart all QNet nodes
   - Verify burn verification works

## Testing

### 1. Test Contract Functions
```bash
# Test initialization
anchor test

# Test burn recording
anchor run test-burn

# Test statistics
anchor run test-stats
```

### 2. Test Integration
```bash
# Start QNet node
cd ../../qnet-integration
cargo run --bin qnet-node

# Test activation
# (Follow QNet node activation guide)
```

## Production Deployment

### Mainnet Checklist

- [ ] Code audited and reviewed
- [ ] All tests passing
- [ ] Devnet deployment successful
- [ ] Integration tests completed
- [ ] Sufficient SOL for deployment (~2 SOL)
- [ ] Backup wallet secured

### Mainnet Commands
```bash
# Switch to mainnet
solana config set --url https://api.mainnet-beta.solana.com

# Deploy (ensure you have sufficient SOL)
anchor deploy --program-id <your-program-id>
```

## Troubleshooting

### Common Issues

1. **Insufficient balance:**
   ```bash
   solana balance  # Check current balance
   solana airdrop 2  # Request airdrop (devnet only)
   ```

2. **Build errors:**
   ```bash
   # Clean and rebuild
   anchor clean
   anchor build
   ```

3. **Network issues:**
   ```bash
   # Check network connection
   solana cluster-version
   
   # Switch RPC endpoint
   solana config set --url https://api.devnet.solana.com
   ```

4. **Program ID mismatch:**
   - Update `declare_id!()` in `src/lib.rs`
   - Update `Anchor.toml` program addresses
   - Rebuild and redeploy

## Contract Verification

After deployment, verify:

1. **Contract deployed:**
   ```bash
   solana program show <program-id>
   ```

2. **Functions working:**
   ```bash
   # Test burn recording
   anchor run test-burn-record
   
   # Test statistics
   anchor run test-get-stats
   ```

3. **Integration working:**
   - Start QNet node
   - Test activation process
   - Verify burn transactions

## Support

For deployment issues:
1. Check logs in `deploy.log`
2. Verify all prerequisites
3. Test on devnet first
4. Contact QNet team if needed

## Security Notes

- **Never share private keys**
- **Use hardware wallets for mainnet**
- **Keep deployment keys secure**
- **Audit contract code before mainnet**
- **Test thoroughly on devnet**

## Contract Addresses

### Current Deployment
- **Program ID:** `D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7` (production)
- **1DEV Mint:** `62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ`
- **Burn Address:** `1nc1nerator11111111111111111111111111111111`

### Update After Deployment
After successful deployment, update this file with the actual program ID. 