//! Fuzz testing for NetworkMessage parsing
//! 
//! Tests that malformed network messages don't crash the node.
//! Run with: cargo +nightly fuzz run fuzz_network_message

#![no_main]

use libfuzzer_sys::fuzz_target;
use arbitrary::Arbitrary;

/// Fuzz target for NetworkMessage deserialization
/// 
/// This ensures that any arbitrary byte sequence either:
/// 1. Parses successfully into a valid NetworkMessage
/// 2. Returns an error gracefully (no panic/crash)
fuzz_target!(|data: &[u8]| {
    // Try to deserialize as NetworkMessage
    // The actual parsing is done by bincode in production
    let _ = bincode::deserialize::<qnet_integration::unified_p2p::NetworkMessage>(data);
});

/// Structured fuzzing with Arbitrary trait
#[derive(Arbitrary, Debug)]
struct FuzzNetworkInput {
    message_type: u8,
    payload_len: u16,
    payload: Vec<u8>,
}

fuzz_target!(|input: FuzzNetworkInput| {
    // Build wire format: type (1) + length (2) + payload
    let mut wire_data = Vec::with_capacity(3 + input.payload.len());
    wire_data.push(input.message_type);
    wire_data.extend_from_slice(&input.payload_len.to_be_bytes());
    wire_data.extend_from_slice(&input.payload);
    
    // Try to parse - should never panic
    let _ = bincode::deserialize::<qnet_integration::unified_p2p::NetworkMessage>(&wire_data);
});

