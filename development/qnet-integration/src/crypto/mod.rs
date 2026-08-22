//! # QNet Cryptography Module
//!
//! ## Overview
//! Isolated cryptographic modules for external security audit.
//! All post-quantum and classical cryptography implementations.
//!
//! ## NIST Compliance
//! - CRYSTALS-ML-DSA-65 / ML-DSA-65 (NIST FIPS 204, Level 3) - the ONLY signature scheme
//! - X25519Kyber768 / ML-KEM-768 (NIST FIPS 203) - post-quantum TLS key exchange
//! - Ed25519 - Solana-side only (1DEV burn wallet ownership); NOT a QNet signature
//! - SHA3-256 - Hash functions
//!
//! ## Module Structure
//!
//! ```text
//! crypto/
//! ├── mod.rs              - This file (public exports)
//! ├── pq_crypto.rs        - Pure ML-DSA-65 (ML-DSA-65) signatures
//! ├── quantum_crypto.rs   - Quantum-resistant cryptography core
//! ├── vrf.rs              - Legacy VRF (deprecated)
//! └── key_manager.rs      - Key generation and management
//! ```
//!
//! ## Security Audit Scope
//! This module contains ALL cryptographic operations for QNet blockchain.
//! External auditors should focus on:
//! 1. Key generation entropy sources
//! 2. Signature verification logic
//! 3. Certificate lifecycle management
//! 4. VRF randomness generation
//!
//! ## Version History
//! - v2.19.0: Initial isolation for audit
//! - NIST PQC Round 3 compliant (ML-DSA-65)

// ============================================================================
// SUBMODULES
// ============================================================================

/// Post-quantum cryptography: pure CRYSTALS-ML-DSA-65 (ML-DSA-65) signatures.
/// Ed25519 is fully removed from QNet signing. Attached-signature wire tags use the `pq_*`
/// namespace: `pq_p2p_bin:` is the live P2P format; `pq_bin:` / `pq:` / `pq_p2p:` are
/// legacy parse-only stubs with no current producer. Parsers use `strip_prefix` (no hardcoded
/// byte offsets). The crypto itself is a single pure ML-DSA-65 signature per message.
pub mod pq_crypto;

/// Quantum-resistant cryptography core
/// Node activation, phase management, pricing calculations
pub mod quantum_crypto;

/// ML-DSA-65-VRF: deterministic leader election and the per-block beacon contribution.
/// The doc that stood here described Proof-of-History, which was removed — it never described `vrf`.
pub mod vrf;

/// Key management
/// Dilithium key generation, storage, rotation
pub mod key_manager;

/// v27 HOLE1: deterministic ML-DSA-65 keypair derivation from a mnemonic.
/// Identity becomes a pure function of the wallet seed (wipe-safe, no
/// random keygen, no runtime TOFU). Carries a mandatory fail-closed KAT.
pub mod genesis_key;

/// Solana address derivation from mnemonic (BIP39 + SLIP-10)
/// Used to verify mnemonic ownership during server node activation
pub mod solana_derivation;

// ============================================================================
// RE-EXPORTS FOR CONVENIENCE
// ============================================================================

// Post-quantum crypto types (pure ML-DSA-65 / ML-DSA-65)
pub use pq_crypto::{
    PqCrypto,
    PqCertificate,
    PqSignature,
    CompactPqSignature,
    GLOBAL_PQ_INSTANCES,
};

// Quantum crypto types
pub use quantum_crypto::{
    QNetQuantumCrypto,
    DilithiumSignature,
    QuantumCryptoStatus,
    QuantumAlgorithms,
    ActivationPayload,
    SimpleNodeRecord,
};

// Quantum VTS types

// VRF types (ML-DSA-65-VRF)
pub use vrf::{
    DilithiumVrf,
    QNetVrf,
    VrfOutput,
    WalletIdentity,
};

// Key manager types
pub use key_manager::DilithiumKeyManager;

