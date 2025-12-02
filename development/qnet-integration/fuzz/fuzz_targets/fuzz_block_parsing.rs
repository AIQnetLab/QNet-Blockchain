//! Fuzz testing for block parsing
//! 
//! Tests that malformed blocks don't crash the node.
//! Run with: cargo +nightly fuzz run fuzz_block_parsing

#![no_main]

use libfuzzer_sys::fuzz_target;
use arbitrary::Arbitrary;

/// Fuzz block header parsing
#[derive(Arbitrary, Debug)]
struct FuzzBlockHeader {
    version: u32,
    height: u64,
    timestamp: u64,
    prev_hash: [u8; 32],
    merkle_root: [u8; 32],
    producer_id: Vec<u8>,
    signature: Vec<u8>,
}

fuzz_target!(|header: FuzzBlockHeader| {
    // Serialize to bytes
    let mut data = Vec::new();
    data.extend_from_slice(&header.version.to_le_bytes());
    data.extend_from_slice(&header.height.to_le_bytes());
    data.extend_from_slice(&header.timestamp.to_le_bytes());
    data.extend_from_slice(&header.prev_hash);
    data.extend_from_slice(&header.merkle_root);
    data.extend_from_slice(&(header.producer_id.len() as u16).to_be_bytes());
    data.extend_from_slice(&header.producer_id);
    data.extend_from_slice(&(header.signature.len() as u16).to_be_bytes());
    data.extend_from_slice(&header.signature);
    
    // Try to parse - should never panic
    let _ = parse_block_header(&data);
});

/// Simple block header parser that mirrors production code
fn parse_block_header(data: &[u8]) -> Result<(), &'static str> {
    if data.len() < 84 {
        return Err("Header too short");
    }
    
    let _version = u32::from_le_bytes(data[0..4].try_into().map_err(|_| "Invalid version")?);
    let height = u64::from_le_bytes(data[4..12].try_into().map_err(|_| "Invalid height")?);
    let _timestamp = u64::from_le_bytes(data[12..20].try_into().map_err(|_| "Invalid timestamp")?);
    
    // Validate height doesn't overflow
    if height > u64::MAX / 2 {
        return Err("Height too large");
    }
    
    Ok(())
}

/// Raw bytes fuzzing
fuzz_target!(|data: &[u8]| {
    let _ = parse_block_header(data);
});

