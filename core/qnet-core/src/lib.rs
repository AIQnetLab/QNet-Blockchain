//! QNet Core - Fundamental blockchain components

pub mod crypto;

// Re-export main crypto functions
pub use crypto::{hash, sign, verify, KeyPair, PublicKey, Signature};

// Common types
pub type Hash = [u8; 32];
pub type Address = [u8; 20];
pub type Amount = u64; 