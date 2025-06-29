# 1DEV Token Creation and Testing Guide

## 🎯 Overview

This guide explains how to create the 1DEV meme token on Solana and test the QNet economic model.

## 📋 Token Specifications

### **1DEV Token Details:**
- **Name**: 1DEV
- **Symbol**: 1DEV
- **Supply**: 1,000,000,000 (1 billion)
- **Decimals**: 6
- **Blockchain**: Solana
- **Type**: SPL Token (meme token)

### **Economic Model:**
- **Phase 1**: Burn-to-join (1,500 1DEV for any node type)
- **Microblock interval**: 1 second (optimized for high-frequency consensus)
- **Decreasing price**: 10% reduction per 10% burned supply
- **Transition**: After 90% burned OR 5 years → QNC activation model (DYNAMIC PRICING: 2.5k-30k QNC)
- **Security**: Hybrid Dilithium2 + Ed25519 signatures with rate limiting
- **Purpose**: Sybil resistance and network bootstrapping

## 🛠️ Token Creation Steps

### **Step 1: Install Solana CLI**
```bash
# Install Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/v1.17.0/install)"

# Add to PATH
export PATH="/home/$(whoami)/.local/share/solana/install/active_release/bin:$PATH"

# Verify installation
solana --version
```

### **Step 2: Configure Solana CLI**
```bash
# Set to devnet for testing
solana config set --url https://api.devnet.solana.com

# Create keypair for token authority
solana-keygen new --outfile ~/.config/solana/1dev-authority.json

# Set as default keypair
solana config set --keypair ~/.config/solana/1dev-authority.json

# Get some SOL for fees
solana airdrop 2
```

### **Step 3: Install SPL Token CLI**
```bash
# Install SPL Token program
cargo install spl-token-cli

# Verify installation
spl-token --version
```

### **Step 4: Create 1DEV Token**
```bash
# Create token mint
spl-token create-token --decimals 6

# Output will be: Creating token <MINT_ADDRESS>
# Save this address - this is your dev_mint_address!

# Example output:
# Creating token 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
```

### **Step 5: Create Token Account and Mint Supply**
```bash
# Create token account
spl-token create-account <MINT_ADDRESS>

# Mint initial supply (1 billion tokens with 6 decimals)
spl-token mint <MINT_ADDRESS> 1000000000

# Verify supply
spl-token supply <MINT_ADDRESS>
```

### **Step 6: Add Token Metadata**
```bash
# Install Metaplex CLI
npm install -g @metaplex-foundation/js-cli

# Create metadata for 1DEV token
metaplex create-metadata \
  --mint <MINT_ADDRESS> \
  --name "1DEV" \
  --symbol "1DEV" \
  --description "QNet development and testing token" \
  --image "https://example.com/1dev-logo.png" \
  --keypair ~/.config/solana/1dev-authority.json
```

## 🔧 QNet Configuration Update

### **Step 7: Update config.ini**
```ini
[Token]
dev_mint_address = <YOUR_ACTUAL_MINT_ADDRESS>
; Replace with the mint address from step 4
dev_decimal_places = 6
dev_total_supply = 1000000000

[Solana]
rpc_url = https://api.devnet.solana.com
burn_address = 1nc1nerator11111111111111111111111111111111
```

### **Step 8: Update Code References**
Update these files with new mint address:
- `qnet-node/src/api/activation_bridge_api.py`
- `qnet-integration/src/solana_integration.rs`
- Any other files referencing `onedev_mint_address`

## 🧪 Testing the Token

### **Test 1: Basic Token Operations**
```bash
# Check token info
spl-token display <MINT_ADDRESS>

# Check your balance
spl-token balance <MINT_ADDRESS>

# Transfer tokens (test)
spl-token transfer <MINT_ADDRESS> 1000 <RECIPIENT_ADDRESS>
```

### **Test 2: Burn Functionality**
```bash
# Test burning tokens (simulate node activation)
spl-token burn <TOKEN_ACCOUNT> 1500

# Verify reduced supply
spl-token supply <MINT_ADDRESS>
```

### **Test 3: QNet Integration**
```bash
# Start QNet test node
python test_node_without_activation.py --port 19901

# Test activation API with real token
curl -X POST http://localhost:19901/api/activate \
  -H "Content-Type: application/json" \
  -d '{
    "node_type": "light",
    "wallet": "YOUR_SOLANA_WALLET",
    "burn_tx": "BURN_TRANSACTION_HASH"
  }'
```

## 📊 Economic Model Testing

### **Test Burn Reduction Logic**
```python
# Python script to test pricing model
def calculate_burn_price(total_burned_percent):
    base_price = 1500
    reduction = total_burned_percent * 0.1  # 10% per 10% burned
    current_price = base_price * (1.0 - reduction)
    return max(current_price, 150)  # Minimum 150 1DEV

# Test different burn percentages
test_cases = [0, 10, 20, 30, 50, 70, 90]
for burned_percent in test_cases:
    price = calculate_burn_price(burned_percent / 100)
    print(f"Burned: {burned_percent}% | Price: {price:.0f} 1DEV")
```

### **Expected Output:**
```
Burned: 0% | Price: 1500 1DEV
Burned: 10% | Price: 1350 1DEV
Burned: 20% | Price: 1200 1DEV
Burned: 30% | Price: 1050 1DEV
Burned: 50% | Price: 750 1DEV
Burned: 70% | Price: 450 1DEV
Burned: 90% | Price: 150 1DEV
```

## 🔐 Security Considerations

### **Token Authority Management:**
```bash
# For production, remove mint authority to prevent inflation
spl-token authorize <MINT_ADDRESS> mint --disable

# Keep freeze authority for emergency situations
# spl-token authorize <MINT_ADDRESS> freeze --disable  # Optional
```

### **Burn Address Verification:**
- **Solana burn address**: `1nc1nerator11111111111111111111111111111111`
- **Verify**: This is the official Solana incinerator address
- **Purpose**: Tokens sent here are permanently destroyed

## 📈 Monitoring and Analytics

### **Track Token Metrics:**
```bash
# Create monitoring script
#!/bin/bash
MINT_ADDRESS="YOUR_MINT_ADDRESS"

while true; do
    SUPPLY=$(spl-token supply $MINT_ADDRESS)
    BURNED=$(echo "1000000000 - $SUPPLY" | bc)
    BURNED_PERCENT=$(echo "scale=2; $BURNED / 1000000000 * 100" | bc)
    
    echo "$(date): Supply: $SUPPLY | Burned: $BURNED ($BURNED_PERCENT%)"
    sleep 300  # Check every 5 minutes
done
```

### **Integration with QNet Dashboard:**
- Add burn tracking to web monitor
- Display current price based on burn percentage
- Show transition countdown (90% or 5 years)

## 🚀 Production Deployment

### **Mainnet Deployment Steps:**
1. **Switch to mainnet**: `solana config set --url https://api.mainnet-beta.solana.com`
2. **Create production token** with same parameters
3. **Update all configurations** with mainnet addresses
4. **Verify token metadata** and burn functionality
5. **Deploy QNet nodes** with production token

### **Launch Checklist:**
- [ ] Token created on Solana mainnet
- [ ] Metadata properly configured
- [ ] Burn functionality tested
- [ ] QNet integration verified
- [ ] Economic model parameters confirmed
- [ ] Monitoring systems ready

## 💡 Development Tips

### **Local Testing:**
- Use Solana devnet for all testing
- Create multiple test accounts to simulate users
- Test edge cases (minimum burn, maximum burn)
- Verify transition to QNC model

### **Common Issues:**
- **Insufficient SOL**: Need SOL for transaction fees
- **Account not found**: Create token account first
- **Authority errors**: Use correct keypair for operations
- **Network errors**: Check Solana RPC endpoint

---

**This guide provides everything needed to create and test the 1DEV token for QNet's economic model. Start with devnet testing before moving to production!** 