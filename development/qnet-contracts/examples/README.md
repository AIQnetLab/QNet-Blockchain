# QNet Native Smart Contract Examples

Examples of contracts targeting QNet's Post-Quantum EVM (PQ-EVM).
All signing uses **CRYSTALS-Dilithium3** (ML-DSA-65, NIST FIPS 204 Level 3) — the same algorithm
used by QNet's core consensus layer (`quantum_crypto.rs`).
Encryption uses **CRYSTALS-Kyber1024** (NIST FIPS 203).

---

## Contracts

| File | Description |
|------|-------------|
| `qnet_token.rs` | QEP-20 fungible token — QNet equivalent of ERC-20 |
| `pq_multisig.rs` | 2-of-N PQ multi-sig wallet using Dilithium3 signatures (ML-DSA-65) |
| `qnc_yield_pool.rs` | **User/wallet-facing** QNC yield pool — purely financial, no node logic. Any wallet user stakes QNC and earns proportional yield (`reward = pool × stake / total_staked`). Deployer funds the reward pool; QNet block production is unaffected. |

---

## Compiling & Deploying

> Requires the `qnet-node` binary built in release mode.

```bash
# 1. Build the node binary (run from repo root)
cargo build --release --bin qnet-node

# 2. Deploy a contract via the RPC endpoint
curl -X POST http://localhost:9876/api/v1/contract/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "from": "YOUR_WALLET_ADDRESS",
    "bytecode": "0x6000F3",
    "gas_limit": 1000000,
    "value": 0,
    "pq_signature": "BASE64_DILITHIUM_SIG"
  }'

# 3. Call a deployed contract
curl -X POST http://localhost:9876/api/v1/contract/call \
  -H "Content-Type: application/json" \
  -d '{
    "to": "CONTRACT_ADDRESS",
    "data": "0x00000001...",
    "gas_limit": 100000
  }'
```

---

## Writing Your Own Contract

QNet contracts are currently written as Rust modules that produce bytecode
via the `PQEvmInterpreter`. A high-level source language (`qnet-sol`) is on
the roadmap. For now, use the helper functions in `qnet_token.rs` as a template.

Key differences from Ethereum Solidity:

| Feature | Ethereum | QNet |
|---------|----------|------|
| Signature scheme | ECDSA (secp256k1) | Dilithium3 / ML-DSA-65 (NIST FIPS 204 L3) |
| Hash function | Keccak-256 | Keccak-256 + SHA3-256 |
| Encryption | none native | Kyber1024 via PQ_ENCRYPT opcode |
| Block time | ~12 s | ~1 s (microblock) |
| Finality | ~2 min (32 conf.) | MacroBlock (~90 s) |
| Custom opcodes | — | `0xE0` MICROBLOCK_COMMIT, `0xE1` MICROBLOCK_VERIFY |
| PQ opcodes | — | `0xF0` PQ_SIGN, `0xF1` PQ_VERIFY, `0xF2` PQ_ENCRYPT |
