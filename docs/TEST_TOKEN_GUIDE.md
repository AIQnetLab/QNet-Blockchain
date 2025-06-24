# QNet Test Token Guide

## Overview

This guide covers the setup and usage of the 1DEV test token on Solana Devnet for QNet blockchain testing. The test token follows pump.fun standards with 1 billion total supply.

## Token Specifications

| Parameter | Value |
|-----------|-------|
| **Name** | 1DEV Test Token |
| **Symbol** | 1DEV-TEST |
| **Network** | Solana Devnet |
| **Total Supply** | 1,000,000,000 (1 billion) |
| **Decimals** | 6 |
| **Standard** | SPL Token (pump.fun compatible) |

## Token Creation

### Prerequisites

- Node.js 18+ installed
- Solana CLI tools (optional)
- Internet connection for devnet access

### Creation Script

The test token is created using the automated script:

```bash
cd scripts
npm install
node create-test-token.js
```

### What the Script Does

1. **Generates Keypairs**: Creates mint authority and faucet wallet
2. **Requests Airdrops**: Gets SOL for transaction fees
3. **Creates Token Mint**: Deploys SPL token with 6 decimals
4. **Mints Initial Supply**: 100M tokens to faucet (10% of total)
5. **Disables Mint Authority**: Makes supply fixed at 1 billion
6. **Saves Configuration**: Creates config files for integration

## Faucet Configuration

### Faucet Specifications

| Parameter | Value |
|-----------|-------|
| **Faucet Amount** | 1,500 1DEV-TEST |
| **Cooldown Period** | 24 hours |
| **Max Claims** | Unlimited |
| **Network** | Solana Devnet |

### Faucet Usage

#### API Endpoint
```
POST /api/faucet/claim
```

#### Request Body
```json
{
  "walletAddress": "SOLANA_WALLET_ADDRESS",
  "amount": 1500,
  "tokenType": "1DEV"
}
```

#### Response
```json
{
  "success": true,
  "txHash": "TRANSACTION_SIGNATURE",
  "balance": "1500.0"
}
```

### Error Codes

| Code | Error | Description |
|------|-------|-------------|
| 400 | Invalid request | Missing or invalid parameters |
| 429 | Cooldown active | Must wait 24 hours between claims |
| 503 | Faucet not configured | Token setup incomplete |

## Integration with QNet

### Environment Variables

After token creation, these variables are automatically set:

```env
TOKEN_MINT_ADDRESS=GENERATED_MINT_ADDRESS
FAUCET_PRIVATE_KEY=GENERATED_PRIVATE_KEY
FAUCET_WALLET_ADDRESS=GENERATED_WALLET_ADDRESS
SOLANA_NETWORK=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
```

### Node Activation Prices

| Node Type | Price (1DEV-TEST) | Percentage of Supply |
|-----------|-------------------|---------------------|
| **Light Node** | 1,500 | 0.00015% |
| **Full Node** | 1,500 | 0.00015% |
| **Super Node** | 1,500 | 0.00015% |

**Note**: All node types have the same burn price of 1,500 tokens. Price decreases by 10% for every 10% of total supply burned, following the QNet economic model.

**Note**: All node types have the same burn price of 1,500 tokens. Price decreases by 10% for every 10% of total supply burned.

## Testing Scenarios

### Basic Testing Flow

1. **Get Test Tokens**
   ```bash
   curl -X POST https://aiqnet.io/api/faucet/claim \
     -H "Content-Type: application/json" \
     -d '{"walletAddress":"YOUR_WALLET","amount":1500,"tokenType":"1DEV"}'
   ```

2. **Connect QNet Wallet**
   - Install QNet Chrome extension
   - Connect to https://aiqnet.io
   - Verify token balance

3. **Activate Node**
   - Choose node type (Light/Full/Super)
   - Confirm transaction
   - Verify activation status

### Advanced Testing

#### Multiple Node Activation
```javascript
// Test activating multiple nodes
const nodeTypes = ['light', 'full', 'super'];
for (const type of nodeTypes) {
  await activateNode(type);
  await verifyActivation(type);
}
```

#### Balance Verification
```javascript
// Check token balance after operations
const balance = await connection.getTokenAccountBalance(tokenAccount);
console.log(`Balance: ${balance.value.uiAmount} 1DEV-TEST`);
```

## Monitoring and Explorer

### Block Explorers

- **Solscan**: `https://solscan.io/token/MINT_ADDRESS?cluster=devnet`
- **Solana Explorer**: `https://explorer.solana.com/address/MINT_ADDRESS?cluster=devnet`

### Key Metrics to Monitor

1. **Total Supply**: Should remain at 1,000,000,000
2. **Circulating Supply**: Tracks distributed tokens
3. **Faucet Balance**: Monitor remaining faucet funds
4. **Transaction Volume**: Track usage patterns

## Troubleshooting

### Common Issues

#### Faucet Not Working
```bash
# Check faucet configuration
curl https://aiqnet.io/api/faucet/claim

# Expected response:
{
  "faucetAmount": 1500,
  "cooldownHours": 24,
  "tokenType": "1DEV",
  "network": "Solana Devnet",
  "status": "active"
}
```

#### Token Not Appearing in Wallet
1. Verify wallet is connected to Devnet
2. Add token manually using mint address
3. Check transaction status in explorer

#### Node Activation Fails
1. Verify sufficient token balance (≥1500 1DEV-TEST)
2. Check wallet connection to correct network
3. Ensure QNet extension is properly installed

### Reset Test Environment

To start fresh:

```bash
# 1. Create new test token
cd scripts
node create-test-token.js

# 2. Restart frontend with new configuration
cd ../applications/qnet-explorer/frontend
rm -rf .next
npm run build
npm start
```

## Security Considerations

### Test Environment Only

⚠️ **Important**: This token is for testing only and has no real value.

- Private keys are stored in configuration files
- Faucet distributes tokens freely
- No security audits performed
- Not suitable for production use

### Best Practices

1. **Never use test tokens on mainnet**
2. **Don't share test private keys publicly**
3. **Use separate wallets for testing**
4. **Clear test data before production**

## Production Migration

When moving to mainnet:

1. **Create production 1DEV token** with proper security
2. **Implement secure key management**
3. **Set up proper faucet with rate limiting**
4. **Conduct security audits**
5. **Update all configuration to mainnet**

## Support

For issues with the test token:

1. Check this documentation
2. Verify network connectivity
3. Review transaction logs
4. Check Solana devnet status

---

**Last Updated**: June 2025  
**Network**: Solana Devnet  
**Purpose**: QNet Testing Only 