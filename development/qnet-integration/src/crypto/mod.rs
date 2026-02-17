//! # QNet Cryptography Module
//!
//! ## Overview
//! Isolated cryptographic modules for external security audit.
//! All post-quantum and classical cryptography implementations.
//!
//! ## NIST Compliance
//! - CRYSTALS-Dilithium (NIST Level 3) - Post-quantum signatures
//! - Ed25519 - Classical signatures (hybrid fallback)
//! - SHA3-256 - Hash functions
//!
//! ## Module Structure
//!
//! ```text
//! crypto/
//! ├── mod.rs              - This file (public exports)
//! ├── hybrid_crypto.rs    - Dilithium + Ed25519 hybrid signatures
//! ├── quantum_crypto.rs   - Quantum-resistant cryptography core
//! ├── quantum_poh.rs      - Verifiable Time Sequence (VTS)
//! ├── vrf.rs              - Legacy VRF (deprecated)
//! ├── vrf_hybrid.rs       - Hybrid VRF for QRB (NOT producer selection)
//! ├── key_manager.rs      - Key generation and management
//! └── crypto_integration.rs - Service integration layer
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
//! - NIST PQC Round 3 compliant (Dilithium3)

// ============================================================================
// SUBMODULES
// ============================================================================

/// Hybrid cryptography: CRYSTALS-Dilithium + Ed25519
/// Implements dual-signature system for post-quantum security with classical fallback
pub mod hybrid_crypto;

/// Quantum-resistant cryptography core
/// Node activation, phase management, pricing calculations
pub mod quantum_crypto;

/// Verifiable Time Sequence (VTS)
/// Time-based consensus with quantum-resistant hashing
pub mod quantum_poh;

/// Dilithium3-VRF: Post-quantum VRF for secret leader election
/// Uses NIST FIPS 204 (ML-DSA-65) + SHA3-256
pub mod vrf;

/// Hybrid VRF for QRB (Quantum Randomness Beacon)
/// Used for: microblock VRF outputs → RANDAO accumulation → dApp randomness
/// NOT used for: Producer selection (uses deterministic SHA3-512 in node.rs)
pub mod vrf_hybrid;

/// Key management
/// Dilithium key generation, storage, rotation
pub mod key_manager;

/// Solana address derivation from mnemonic (BIP39 + SLIP-10)
/// Used to verify mnemonic ownership during server node activation
pub mod solana_derivation;

// NOTE: crypto_integration.rs is deprecated (uses non-existent qnet_core::crypto)
// The hybrid_crypto and quantum_crypto modules handle all production crypto needs
// pub mod crypto_integration;

// ============================================================================
// RE-EXPORTS FOR CONVENIENCE
// ============================================================================

// Hybrid crypto types
pub use hybrid_crypto::{
    HybridCrypto,
    HybridCertificate,
    HybridSignature,
    CompactHybridSignature,
    GLOBAL_HYBRID_INSTANCES,
};

// Quantum crypto types
pub use quantum_crypto::{
    QNetQuantumCrypto,
    BlockchainPhaseState,
    DilithiumSignature,
    QuantumCryptoStatus,
    QuantumAlgorithms,
    ActivationPayload,
    SimpleNodeRecord,
};

// Quantum VTS types
pub use quantum_poh::{
    QuantumPoH,
    PoHEntry,
};

// VRF types (Dilithium3-VRF)
pub use vrf::{
    DilithiumVrf,
    QNetVrf,
    VrfOutput,
    WalletIdentity,
};

// Hybrid VRF types
pub use vrf_hybrid::{
    QNetHybridVrf,
    HybridVrfOutput,
};

// Key manager types
pub use key_manager::DilithiumKeyManager;

