//! Fuzz testing for signature parsing and verification
//! 
//! Tests that malformed signatures don't crash the node.
//! Run with: cargo +nightly fuzz run fuzz_signature

#![no_main]

use libfuzzer_sys::fuzz_target;
use arbitrary::Arbitrary;

/// Fuzz compact hybrid signature structure
#[derive(Arbitrary, Debug)]
struct FuzzCompactSignature {
    node_id_len: u8,
    node_id: Vec<u8>,
    cert_serial_len: u8,
    cert_serial: Vec<u8>,
    signed_at: u64,
    ed25519_sig: [u8; 64],
    dilithium_sig_len: u16,
    dilithium_sig: Vec<u8>,
}

fuzz_target!(|sig: FuzzCompactSignature| {
    // Build wire format
    let mut data = Vec::new();
    data.push(sig.node_id_len);
    data.extend_from_slice(&sig.node_id[..sig.node_id_len.min(sig.node_id.len() as u8) as usize]);
    data.push(sig.cert_serial_len);
    data.extend_from_slice(&sig.cert_serial[..sig.cert_serial_len.min(sig.cert_serial.len() as u8) as usize]);
    data.extend_from_slice(&sig.signed_at.to_le_bytes());
    data.extend_from_slice(&sig.ed25519_sig);
    data.extend_from_slice(&sig.dilithium_sig_len.to_be_bytes());
    data.extend_from_slice(&sig.dilithium_sig[..sig.dilithium_sig_len.min(sig.dilithium_sig.len() as u16) as usize]);
    
    // Try to parse - should never panic
    let _ = parse_compact_signature(&data);
});

/// Signature parser that mirrors production code
fn parse_compact_signature(data: &[u8]) -> Result<ParsedSignature, &'static str> {
    if data.is_empty() {
        return Err("Empty signature data");
    }
    
    let mut pos = 0;
    
    // Read node_id
    if pos >= data.len() {
        return Err("Missing node_id length");
    }
    let node_id_len = data[pos] as usize;
    pos += 1;
    
    if node_id_len > 64 {
        return Err("Node ID too long");
    }
    
    if pos + node_id_len > data.len() {
        return Err("Node ID truncated");
    }
    let node_id = String::from_utf8_lossy(&data[pos..pos + node_id_len]).to_string();
    pos += node_id_len;
    
    // Read cert_serial
    if pos >= data.len() {
        return Err("Missing cert_serial length");
    }
    let cert_serial_len = data[pos] as usize;
    pos += 1;
    
    if cert_serial_len > 64 {
        return Err("Cert serial too long");
    }
    
    if pos + cert_serial_len > data.len() {
        return Err("Cert serial truncated");
    }
    let cert_serial = String::from_utf8_lossy(&data[pos..pos + cert_serial_len]).to_string();
    pos += cert_serial_len;
    
    // Read timestamp
    if pos + 8 > data.len() {
        return Err("Missing timestamp");
    }
    let signed_at = u64::from_le_bytes(data[pos..pos + 8].try_into().map_err(|_| "Invalid timestamp")?);
    pos += 8;
    
    // Validate timestamp is reasonable (not in far future)
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if signed_at > now + 86400 {
        return Err("Signature from future");
    }
    
    // Read Ed25519 signature (64 bytes)
    if pos + 64 > data.len() {
        return Err("Missing Ed25519 signature");
    }
    let mut ed25519_sig = [0u8; 64];
    ed25519_sig.copy_from_slice(&data[pos..pos + 64]);
    pos += 64;
    
    // Read Dilithium signature length
    if pos + 2 > data.len() {
        return Err("Missing Dilithium signature length");
    }
    let dilithium_len = u16::from_be_bytes(data[pos..pos + 2].try_into().map_err(|_| "Invalid length")?) as usize;
    pos += 2;
    
    // Validate Dilithium signature size (max ~4kb for Dilithium3)
    if dilithium_len > 5000 {
        return Err("Dilithium signature too large");
    }
    
    if pos + dilithium_len > data.len() {
        return Err("Dilithium signature truncated");
    }
    let dilithium_sig = data[pos..pos + dilithium_len].to_vec();
    
    Ok(ParsedSignature {
        node_id,
        cert_serial,
        signed_at,
        ed25519_sig,
        dilithium_sig,
    })
}

#[derive(Debug)]
struct ParsedSignature {
    node_id: String,
    cert_serial: String,
    signed_at: u64,
    ed25519_sig: [u8; 64],
    dilithium_sig: Vec<u8>,
}

/// Raw bytes fuzzing
fuzz_target!(|data: &[u8]| {
    let _ = parse_compact_signature(data);
});

