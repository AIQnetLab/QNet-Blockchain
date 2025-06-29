# Solana Integration Guide for QNet

## Overview

This guide explains how QNet integrates with the 1DEV burn contract on Solana for node activation.

## Architecture

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│                 │         │                  │         │                 │
│  User Wallet    │────────▶│  1DEV Burn       │────────▶│  QNet Node      │
│  (Phantom)      │  Burn   │  Contract        │  Verify │  (Rust)         │
│                 │  1DEV   │  (Solana)        │  PDA    │                 │
└─────────────────┘         └──────────────────┘         └─────────────────┘
```

## Node Activation Flow

### 1. User Burns 1DEV (Solana)
```typescript
// User connects wallet and burns 1DEV
const tx = await program.methods
  .burnForNode(
    nodeType,           // LightNode, FullNode, or SuperNode
    nodePublicKey       // Ed25519 public key for the node
  )
  .accounts({
    burnState: burnStatePDA,
    nodeActivation: nodeActivationPDA,
    user: wallet.publicKey,
    userTokenAccount: user1devAccount,
    onedevMint: ONEDEV_MINT,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

### 2. QNet Node Verification
```rust
// In QNet node software
pub async fn verify_node_activation(
    node_pubkey: &PublicKey,
    solana_rpc: &str,
) -> Result<NodeActivation, Error> {
    // Calculate PDA address
    let (pda, _) = Pubkey::find_program_address(
        &[b"node", node_pubkey.as_ref()],
        &ONEDEV_BURN_PROGRAM_ID,
    );
    
    // Fetch account data from Solana
    let client = RpcClient::new(solana_rpc);
    let account = client.get_account(&pda)?;
    
    // Deserialize and verify
    let activation: NodeActivation = NodeActivation::try_from_slice(&account.data)?;
    
    // Verify ownership
    if activation.node_pubkey != *node_pubkey {
        return Err(Error::InvalidActivation);
    }
    
    Ok(activation)
}
```

## Integration Steps

### 1. Configure QNet Node
```toml
# qnet-node/config.toml
[solana]
rpc_url = "https://api.mainnet-beta.solana.com"
burn_program_id = "QNETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

[node]
type = "LightNode"
public_key = "your-node-ed25519-public-key"
```

### 2. Node Startup Verification
```rust
// qnet-node/src/main.rs
async fn start_node() -> Result<()> {
    // Load config
    let config = load_config()?;
    
    // Verify node activation on Solana
    let activation = verify_node_activation(
        &config.node.public_key,
        &config.solana.rpc_url,
    ).await?;
    
    println!("Node activated!");
    println!("Type: {:?}", activation.node_type);
    println!("Activated: {}", activation.activation_timestamp);
    println!("1DEV burned: {}", activation.onedev_burned);
    
    // Start node with appropriate permissions
    match activation.node_type {
        NodeType::SuperNode => start_super_node(activation),
        NodeType::FullNode => start_full_node(activation),
        NodeType::LightNode => start_light_node(activation),
    }
}
```

## Monitoring and Analytics

### Query Burn Progress
```typescript
// Check current burn status
const burnState = await program.account.burnState.fetch(burnStatePDA);

console.log(`Total burned: ${burnState.totalBurned} 1DEV`);
console.log(`Total nodes: ${burnState.totalNodes}`);
console.log(`Current price: ${burnState.currentPrice} 1DEV`);
console.log(`Transition completed: ${burnState.transitionCompleted}`);
```

### Query Node Activation
```typescript
// Check if a node is activated
const [nodeActivationPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("node"), nodePublicKey.toBuffer()],
  program.programId
);

try {
  const activation = await program.account.nodeActivation.fetch(nodeActivationPDA);
  console.log("Node is activated:", activation);
} catch {
  console.log("Node not activated");
}
```

## Post-Transition Migration

After 90% burn or 5 years, existing nodes must migrate:

```typescript
// Migrate existing node to QNC network
const tx = await program.methods
  .migrateNode(originalTxSignature)
  .accounts({
    burnState: burnStatePDA,
    nodeActivation: nodeActivationPDA,
    user: wallet.publicKey,
  })
  .rpc();
```

## Security Considerations

1. **Node Key Management**
   - Keep node private keys secure
   - Never expose private keys in code
   - Use hardware wallets for high-value nodes

2. **Verification**
   - Always verify PDA derivation
   - Check activation status before starting node
   - Monitor for contract upgrades

3. **RPC Reliability**
   - Use multiple RPC endpoints
   - Implement retry logic
   - Cache activation data locally

## Testing

### Local Testing
```bash
# Start local validator
solana-test-validator

# Deploy contract
anchor deploy

# Run tests
anchor test
```

### Devnet Testing
```bash
# Switch to devnet
solana config set --url devnet

# Airdrop SOL
solana airdrop 2

# Deploy and test
anchor deploy --provider.cluster devnet
```

## Troubleshooting

### Common Issues

1. **"Node not found"**
   - Ensure correct node public key
   - Check if activation transaction confirmed
   - Verify PDA derivation

2. **"Insufficient balance"**
   - Check 1DEV token balance
   - Ensure correct token account
   - Verify current price

3. **"Transition completed"**
   - Check if 90% burned or 5 years passed
   - Use migration function for existing nodes
   - New nodes must use QNC burning

## Support

- Documentation: https://docs.qnet.network
- Discord: https://discord.gg/qnet
- GitHub: https://github.com/qnet-project 