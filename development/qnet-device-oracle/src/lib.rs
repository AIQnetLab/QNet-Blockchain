//! QNet device oracle: holds the vendor credentials (Apple DeviceCheck and App Attest data, Google Play
//! Integrity and device recall), keeps the per-device slot lease of every light node, and signs lease
//! statements and revocation snapshots with its ML-DSA-65 key. Only the five genesis nodes reach it,
//! over mutual TLS. It is not on the per-ping path.

pub mod alerts;
pub mod api;
pub mod boot;
pub mod civil;
pub mod config;
pub mod evidence;
pub mod gates;
pub mod lease;
pub mod limits;
pub mod log;
pub mod messages;
pub mod replica;
pub mod server;
pub mod service;
pub mod signer;
pub mod store;
#[cfg(test)]
pub mod testkit;
pub mod types;
pub mod upstream;
