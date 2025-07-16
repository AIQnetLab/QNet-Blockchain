#![allow(unused_imports)]
#![allow(unused_variables)]
#![allow(dead_code)]
#![allow(missing_docs)]

//! QNet Core - Fundamental blockchain components

pub mod crypto;
pub mod security;

// Re-export main crypto functions
pub use crypto::{hash, sign, verify, KeyPair};

// Common types
pub type Hash = [u8; 32];
pub type Address = [u8; 20];
pub type Amount = u64; 