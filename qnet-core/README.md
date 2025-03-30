# QNet Core

The core blockchain module for QNet with post-quantum cryptography features.

## Features

- Post-quantum cryptography using Dilithium and other NIST-approved algorithms
- Hybrid Python/Rust architecture for balance between development speed and performance
- Optimized data storage with both in-memory and RocksDB options
- Commit-reveal consensus mechanism with protection against Sybil attacks
- Lightweight client support for mobile devices (SPV)

## Repository Structure

- `src/core/`: Main blockchain logic
- `src/consensus/`: Consensus mechanisms
- `src/crypto/`: Cryptographic primitives
- `src/storage/`: Storage systems
- `tests/`: Test suite
- `docs/`: Documentation

## Development

This project is part of an experimental blockchain using AI-assisted development,
with human operator guidance.