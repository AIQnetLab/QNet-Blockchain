# QNet Node Activation Architecture (No Database)

## Overview
QNet operates without a centralized database, using blockchain and distributed storage for all data.

## Activation Flow

### 1. Token Burn on Solana
```
User → Solana Wallet → Burn 1DEV → Get Transaction Hash
```

### 2. Activation Token Generation
```javascript
// On website backend (stateless)
function generateActivationToken(burnTxHash, walletAddress, nodeType) {
  // Create JWT token with burn proof
  const payload = {
    burnTx: burnTxHash,
    wallet: walletAddress,
    nodeType: nodeType,
    timestamp: Date.now(),
    expires: Date.now() + 24*60*60*1000 // 24 hours
  };
  
  // Sign with QNet private key
  return jwt.sign(payload, QNET_PRIVATE_KEY);
}
```

### 3. Installation Script Generation
```bash
#!/bin/bash
# Unique installation script for each user

ACTIVATION_TOKEN="eyJhbGciOiJIUzI1NiIs..."
NODE_TYPE="full"
WALLET_ADDRESS="5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty"

# Download QNet node
curl -sSL https://qnet.network/releases/latest/qnet-node -o qnet-node
chmod +x qnet-node

# Initialize with activation
./qnet-node init \
  --activation-token="$ACTIVATION_TOKEN" \
  --node-type="$NODE_TYPE" \
  --wallet="$WALLET_ADDRESS"
```

## Data Storage Architecture

### 1. Activation Records
- **Where**: QNet blockchain itself
- **Format**: Special activation transactions
- **Content**: 
  ```json
  {
    "type": "NODE_ACTIVATION",
    "burnTx": "solana_tx_hash",
    "nodeId": "generated_node_id",
    "publicKey": "node_public_key",
    "nodeType": "full",
    "activationTime": 1234567890
  }
  ```

### 2. Node Registry
- **Where**: Distributed Hash Table (DHT)
- **Updates**: Gossip protocol
- **Content**: Active nodes, their types, and reputation

### 3. Burn Verification
- **Method**: Direct Solana RPC calls
- **Cache**: Local Redis/memory cache (optional)
- **Verification**: Real-time on each node start

## Website Integration

### Frontend (Next.js)
```typescript
// pages/activate-node.tsx
async function activateNode(nodeType: NodeType) {
  // 1. Burn 1DEV tokens via Solana
const burnTx = await burn1DEVTokens(nodeType);
  
  // 2. Request activation token from API
  const response = await fetch('/api/activate', {
    method: 'POST',
    body: JSON.stringify({
      burnTx: burnTx.signature,
      wallet: wallet.publicKey.toString(),
      nodeType
    })
  });
  
  const { activationToken, installScript } = await response.json();
  
  // 3. Show download options
  showDownloadModal({
    script: installScript,
    token: activationToken,
    dockerCommand: `docker run -e TOKEN=${activationToken} qnet/node`
  });
}
```

### Backend API (Stateless)
```typescript
// api/activate.ts
export async function POST(req: Request) {
  const { burnTx, wallet, nodeType } = await req.json();
  
  // 1. Verify burn transaction on Solana
  const isValid = await verifySolanaBurn(burnTx, wallet, nodeType);
  if (!isValid) throw new Error('Invalid burn transaction');
  
  // 2. Generate activation token (JWT)
  const token = generateActivationToken(burnTx, wallet, nodeType);
  
  // 3. Generate unique install script
  const script = generateInstallScript(token, nodeType, wallet);
  
  // 4. Return to user (no database write!)
  return Response.json({
    activationToken: token,
    installScript: script,
    dockerCommand: generateDockerCommand(token)
  });
}
```

## Node Startup Verification

```python
# qnet_node/activation.py
class NodeActivation:
    def verify_activation(self, token: str) -> bool:
        """Verify node activation on startup"""
        # 1. Decode JWT token
        payload = jwt.decode(token, QNET_PUBLIC_KEY)
        
        # 2. Check expiration
        if payload['expires'] < time.time():
            raise ActivationExpired()
        
        # 3. Verify burn on Solana
        if not self.verify_solana_burn(payload['burnTx']):
            raise InvalidBurnTransaction()
        
        # 4. Check if already activated (via blockchain)
        if self.is_already_activated(payload['burnTx']):
            raise AlreadyActivated()
        
        # 5. Create activation transaction on QNet
        self.create_activation_tx(payload)
        
        return True
```

## Benefits of No-Database Architecture

1. **True Decentralization**: No central point of failure
2. **Privacy**: No user data stored centrally
3. **Resilience**: System works even if website is down
4. **Transparency**: All activations visible on blockchain
5. **No Maintenance**: No database to backup/manage

## Security Considerations

1. **Token Expiration**: 24-hour window to use activation
2. **One-Time Use**: Each burn can only activate one node
3. **Signature Verification**: All tokens cryptographically signed
4. **Blockchain Verification**: Double-check on QNet blockchain
5. **Rate Limiting**: API endpoints protected against abuse

## Alternative Activation Methods

### 1. CLI Activation
```bash
# Direct activation without website
qnet-cli activate \
  --burn-tx <SOLANA_TX_HASH> \
  --wallet <WALLET_ADDRESS> \
  --node-type full
```

### 2. Offline Activation
```bash
# Generate proof offline
qnet-cli generate-proof \
  --burn-tx <SOLANA_TX_HASH> \
  --output activation.proof

# Use proof to activate
qnet-node init --proof activation.proof
```

### 3. Hardware Wallet Support
- Sign activation with hardware wallet
- Extra security for high-value nodes 