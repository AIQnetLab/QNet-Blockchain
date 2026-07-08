# QNet Smart Contract Architecture

## Overview: WASM Smart Contract System

QNet implements a **WebAssembly-based smart contract architecture**:

1. **Native QNet Contracts** - WebAssembly-based, mobile-optimized
2. **On-chain token & NFT standards** - QRC-20 fungible tokens and QRC-721 NFTs, plus a general-purpose WASM VM

---

## 🏗️ Architecture Components

### **1. Native QNet Smart Contracts**

**Technology**: WebAssembly (WASM) Virtual Machine — a deterministic `wasmi` interpreter where each executed instruction is one metered fuel unit and the sender pays for the fuel actually consumed  
**Languages**: Rust, AssemblyScript, C/C++, Go, Python  
**Location**: `development/qnet-contracts/qnet-native/`

**Key Features**:
- ✅ **Mobile Optimization**: <2MB memory footprint, <0.01% battery usage
- ✅ **Post-Quantum Security**: ML-DSA-65 (Dilithium3) signatures + hybrid X25519Kyber768 (ML-KEM-768) transport key exchange
- ✅ **High Performance**: 50,000+ TPS per node
- ✅ **Microblock Integration**: Sub-second block time; Checkpoint-BFT v2 macroblock finality (~60s)

**Example Contract**: `node_activation_qnc.py`
```python
class QNCNodeActivationContract:
    def activate_node(self, node_type: NodeType, qnc_amount: int):
        # Transfer QNC to Pool 3
        self.transfer_to_pool3(qnc_amount)
        # Activate node with quantum signatures
        self.record_activation_pq(node_type)
```

### **2. On-chain Token & NFT Standards + WASM VM**

**Technology**: On-chain QRC-20 / QRC-721 standards plus a general-purpose WASM VM  
**Location**: `core/qnet-vm/`, token/NFT standards in `core/qnet-state/src/transaction.rs`

**Built and enabled**:
- **QRC-20 fungible tokens**: deploy, transfer, approve, transferFrom, mint, burn — fully on-chain
- **QRC-721 NFTs**: deploy, mint, transfer, approve, transferFrom — fully on-chain
- **General-purpose WASM VM**: deterministic `wasmi` interpreter with per-consumed-fuel gas metering, deploy-time determinism validation (no floats/threads), deploy + call + cross-contract calls (EIP-2930-style access list)

**Gas Model** (pay-for-consumed-fuel):
- The `wasmi` interpreter meters each executed WASM instruction as one fuel unit. That fuel count is deterministic (identical instruction stream on every node).
- The sender prepays `gas_limit * effective_gas_price` up front. The metered fee charged is `(intrinsic_gas + fuel_consumed) * effective_gas_price`, and the unused remainder is refunded to the sender. `intrinsic_gas` is the flat static cost of the `ContractCall`; `fuel_consumed` is the actual instruction count the call burned (billed even on a trap, since consumed work is real).
- The fuel fee is a **symmetric account move**: the same `fuel_consumed * effective_gas_price` that is subtracted from the sender's refund is added to the block producer's fee credit — so total QNC supply is unchanged and conservation holds by construction. A quantum (Dilithium-signed) transaction pays 1.5× via `effective_gas_price`.
- **Activation height**: per-consumed-fuel metering (and the EIP-1559-style refund) applies to blocks at or above `GAS_METERING_ACTIVATION_HEIGHT`. Below that height the legacy flat `gas_limit * gas_price` fee is charged, preserving consensus over historical blocks. `fuel_consumed` is 0 for every non-WASM transaction, so the metered fee collapses to the flat behaviour there.
- Contract execution is deterministic (validated at deploy time: no floats/threads/SIMD, sorted-key storage).
- Cross-contract calls use an EIP-2930-style access list and share the same fuel budget.

### **3. Cross-Contract Integration**

**Contract ↔ contract calls** run through a host function with an EIP-2930-style
access list, so a deployed contract can call another deployed contract within the
same deterministic execution and gas budget.

---

## 🔄 Activation & Execution Model

### **Phase 1: 1DEV Burn (Solana + Native)**
1. **Solana Contract**: Burns 1DEV tokens (proof-of-burn) → generates activation code
2. **Native QNet Contract**: Validates activation code → activates node
3. **Cross-chain verification** via quantum-resistant proofs

### **Phase 2: QNC Pool 3 (Native)**
1. **Native Contract**: Handles QNC transfers to Pool 3 for activation
2. **Reward distribution**: driven by emission pools + reputation at the protocol level
3. **Microblock execution** gives sub-second block time; Checkpoint-BFT v2 finalizes macroblocks (~60s)

### **Smart Contract Deployment**:

```bash
# Deploy a WASM contract via the RPC endpoint
curl -X POST http://localhost:9876/api/v1/contract/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "from": "YOUR_WALLET_ADDRESS",
    "bytecode": "0x...",
    "gas_limit": 1000000,
    "value": 0,
    "pq_signature": "BASE64_DILITHIUM_SIG"
  }'
```

---

## 🛡️ Security Architecture

### **Quantum Protection**:
- **ML-DSA-65 (Dilithium3)**: Digital signatures — transactions, consensus, node identity, and P2P gossip are all signed with pure ML-DSA-65
- **Hybrid X25519Kyber768 (ML-KEM-768)**: Transport key exchange over QUIC + TLS 1.3
- **SHA3-256**: Quantum-resistant hashing

### **Contract Security**:
- **Deterministic execution** validated at deploy time (no floats/threads)
- **Atomic transactions** priced by consumed fuel (sender pays intrinsic + fuel burned; conservation-preserving symmetric move to the producer)
- **Replay protection** with nonces

---

## 📊 Performance Comparison

| Metric | QNet WASM VM | Traditional EVM |
|--------|-------------|-----------------|
| **TPS** | 50,000+ | 15 |
| **Block time** | ~1 second (microblock) | 12 seconds |
| **Finality** | ~60s (Checkpoint-BFT v2 macroblock) | ~min (probabilistic) |
| **Mobile Support** | ✅ Optimized | ❌ Too heavy |
| **Quantum Security** | ✅ Native (ML-DSA-65) | ❌ Vulnerable |

---

## 🎯 Use Cases

### **Native WASM Contracts Best For**:
- Node activation and management
- Mobile-first applications
- High-frequency operations
- Battery-sensitive operations

### **QRC-20 / QRC-721 Standards Best For**:
- Fungible tokens (QRC-20)
- NFTs (QRC-721)
- DeFi protocols
- Complex tokenomics

### **General-purpose WASM Contracts Best For**:
- Complex business logic with cross-contract calls
- Multi-contract applications
- Enterprise solutions
- Future governance systems (DAO governance is not wired yet)

---

## 🔧 Development Tools

### **Native Contract Development**:
```bash
# Create new native contract
qnet create-contract --type native --lang rust my-contract

# Build and test
qnet build-native ./src/lib.rs
qnet test-native ./tests/
```

### **WASM Contract Deployment**:
```bash
# Deploy a compiled WASM contract via RPC
qnet deploy-contract ./contract.wasm --gas-limit 1000000

# Call a deployed contract
qnet call-contract <CONTRACT_ADDRESS> --data 0x... --gas-limit 100000
```

---

## 🚀 Production Status

- ✅ **Native WASM VM**: Built and enabled (deterministic `wasmi` interpreter, per-consumed-fuel gas metering above the activation height, EIP-1559-style refund of unused gas)
- ✅ **QRC-20 tokens**: Fully on-chain (deploy, transfer, approve, transferFrom, mint, burn)
- ✅ **QRC-721 NFTs**: Fully on-chain (deploy, mint, transfer, approve, transferFrom)
- ✅ **Cross-contract calls**: EIP-2930-style access list
- ✅ **Mobile optimization**: <0.01% battery usage achieved
- ✅ **Quantum security**: Pure ML-DSA-65 (Dilithium3) signatures + hybrid X25519Kyber768 (ML-KEM-768) transport KEX
- ✅ **Developer tools**: SDK available 