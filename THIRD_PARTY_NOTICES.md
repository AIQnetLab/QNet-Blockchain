# Third Party Notices

This software incorporates components from various open source projects.

## Cryptographic Libraries

### pqcrypto (CRYSTALS-Dilithium)
- License: Apache-2.0 / MIT
- Source: https://github.com/pqcrypto/pqcrypto
- Purpose: Post-quantum digital signatures (NIST FIPS 204)

### ed25519-dalek
- License: BSD-3-Clause
- Source: https://github.com/dalek-cryptography/ed25519-dalek
- Purpose: Ed25519 digital signatures

### sha3
- License: Apache-2.0 / MIT
- Source: https://github.com/RustCrypto/hashes
- Purpose: SHA3 hash functions (NIST FIPS 202)

### blake3
- License: CC0-1.0 / Apache-2.0
- Source: https://github.com/BLAKE3-team/BLAKE3
- Purpose: High-performance hashing

### aes-gcm
- License: Apache-2.0 / MIT
- Source: https://github.com/RustCrypto/AEADs
- Purpose: AES-256-GCM encryption for key storage

## Networking

### quinn (QUIC)
- License: Apache-2.0 / MIT
- Source: https://github.com/quinn-rs/quinn
- Purpose: QUIC transport protocol (IETF RFC 9000)

### tokio
- License: MIT
- Source: https://github.com/tokio-rs/tokio
- Purpose: Async runtime

### warp
- License: MIT
- Source: https://github.com/seanmonstar/warp
- Purpose: HTTP/REST API

## Serialization

### serde
- License: Apache-2.0 / MIT
- Source: https://github.com/serde-rs/serde
- Purpose: Serialization framework

### bincode
- License: MIT
- Source: https://github.com/bincode-org/bincode
- Purpose: Binary serialization

## Compression

### zstd
- License: BSD-3-Clause
- Source: https://github.com/gyscos/zstd-rs
- Purpose: Block data compression

## Acknowledgments

QNet implements several high-performance blockchain concepts:

- **Verifiable Time Sequence (VTS)**: Cryptographic time ordering using sequential hashing with VDF properties
- **Adaptive BFT**: Adaptive timeout management for Byzantine fault-tolerant consensus
- **Parallel Executor**: Parallel transaction execution with dependency analysis
- **Shred Protocol**: Efficient block propagation using erasure coding

These implementations are original work by AIQnetLab, inspired by general blockchain research and industry best practices.

---

For the full license of each dependency, please refer to their respective repositories or the Cargo.lock file.

