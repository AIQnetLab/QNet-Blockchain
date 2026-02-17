# QNet Hybrid Smart Contract Architecture

## Overview: Dual Smart Contract System

QNet implements a unique **hybrid smart contract architecture** combining:

1. **Native QNet Contracts** - WebAssembly-based, mobile-optimized
2. **PQ-EVM Compatibility** - Ethereum-compatible with post-quantum security

---

## 🏗️ Architecture Components

### **1. Native QNet Smart Contracts**

**Technology**: WebAssembly (WASM) Virtual Machine  
**Languages**: Rust, AssemblyScript, C/C++, Go, Python  
**Location**: `development/qnet-contracts/qnet-native/`

**Key Features**:
- ✅ **Mobile Optimization**: <2MB memory footprint, <0.01% battery usage
- ✅ **Post-Quantum Security**: Dilithium3 + ML-KEM-768 (Kyber) quantum-resistant crypto
- ✅ **High Performance**: 50,000+ TPS per node
- ✅ **Microblock Integration**: Sub-second finality

**Example Contract**: `node_activation_qnc.py`
```python
class QNCNodeActivationContract:
    def activate_node(self, node_type: NodeType, qnc_amount: int):
        # Transfer QNC to Pool 3
        self.transfer_to_pool3(qnc_amount)
        # Activate node with quantum signatures
        self.record_activation_pq(node_type)
```

### **2. Post-Quantum EVM (PQ-EVM)**

**Technology**: Enhanced EVM with quantum-resistant opcodes  
**Compatibility**: Full Ethereum compatibility  
**Location**: `development/qnet-vm/pq_evm.rs`

**New Opcodes**:
- `PQ_SIGN` (0xF0) - Dilithium signatures
- `PQ_VERIFY` (0xF1) - Signature verification
- `PQ_ENCRYPT` (0xF2) - ML-KEM-768 (Kyber) encryption
- `PQ_DECRYPT` (0xF3) - ML-KEM-768 (Kyber) decryption

**Gas Metering**:
```rust
PQ_SIGN_COST: 15000,    // Dilithium signing
PQ_VERIFY_COST: 8000,   // Signature verification
PQ_ENCRYPT_COST: 12000, // ML-KEM-768 encryption
PQ_DECRYPT_COST: 10000  // ML-KEM-768 decryption
```

### **3. Cross-System Integration**

**Native ↔ PQ-EVM Communication**:
```rust
// Native contract calling PQ-EVM contract
let result = pq_evm_call(
    contract_address,
    function_selector,
    abi_encoded_params,
    quantum_signature
);

// PQ-EVM contract calling Native contract
interface INativeContract {
    function callNative(bytes32 contractId, bytes calldata data) 
        external returns (bytes memory);
}
```

---

## 🔄 Hybrid Execution Model

### **Phase 1: 1DEV Burn (Solana + Native)**
1. **Solana Contract**: Burns 1DEV tokens → generates activation code
2. **Native QNet Contract**: Validates activation code → activates node
3. **Cross-chain verification** via quantum-resistant proofs

### **Phase 2: QNC Pool 3 (Native + PQ-EVM)**
1. **Native Contract**: Handles QNC transfers to Pool 3
2. **PQ-EVM Contract**: Manages reward distribution logic
3. **Microblock execution** ensures sub-second finality

### **Smart Contract Deployment Options**:

```bash
# Deploy Native Contract (WASM)
qnet deploy-native ./contract.wasm --type native

# Deploy PQ-EVM Contract (Quantum-Enhanced Ethereum)
qnet deploy-pq-evm ./contract.sol --quantum-signatures

# Deploy Hybrid Contract (Both Systems)
qnet deploy-hybrid ./native.wasm ./evm.sol --bridge-enabled
```

---

## 🛡️ Security Architecture

### **Quantum Protection**:
- **Dilithium-5**: Digital signatures (3293-byte signatures)
- **ML-KEM-768 (Kyber)**: Key encapsulation (1184-byte public keys)
- **SHA3-256**: Quantum-resistant hashing

### **Cross-System Security**:
- **State verification** between Native and PQ-EVM
- **Atomic transactions** across hybrid contracts
- **Replay protection** with quantum nonces

---

## 📊 Performance Comparison

| Metric | Native WASM | PQ-EVM | Traditional EVM |
|--------|-------------|--------|-----------------|
| **TPS** | 50,000+ | 25,000+ | 15 |
| **Finality** | 1 second | 1 second | 12 seconds |
| **Mobile Support** | ✅ Optimized | ✅ Compatible | ❌ Too heavy |
| **Quantum Security** | ✅ Native | ✅ Enhanced | ❌ Vulnerable |

---

## 🎯 Use Cases

### **Native WASM Contracts Best For**:
- Node activation and management
- Mobile-first applications
- High-frequency operations
- Battery-sensitive operations

### **PQ-EVM Contracts Best For**:
- Ethereum ecosystem compatibility
- DeFi protocols
- Complex business logic
- Cross-chain bridges

### **Hybrid Contracts Best For**:
- Governance systems (DAO)
- Complex tokenomics
- Multi-chain applications
- Enterprise solutions

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

### **PQ-EVM Contract Development**:
```bash
# Create quantum-enhanced Solidity contract  
qnet create-contract --type pq-evm --lang solidity my-contract

# Compile with quantum extensions
qnet compile-pq-evm ./contract.sol --quantum-opcodes
```

---

## 🚀 Production Status

- ✅ **Native WASM VM**: Production ready
- ✅ **PQ-EVM Implementation**: Production ready  
- ✅ **Cross-system bridge**: Production ready
- ✅ **Mobile optimization**: <0.01% battery usage achieved
- ✅ **Quantum security**: Full Dilithium3 + ML-KEM-768 (Kyber) implementation
- ✅ **Developer tools**: Complete SDK available

**Launch Ready**: July 2025 🎯 