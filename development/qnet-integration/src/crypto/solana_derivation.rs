//! # Solana Address Derivation from Mnemonic (BIP39 + SLIP-10 + Ed25519)
//!
//! Replicates the exact same derivation as the mobile app:
//!   1. BIP39: mnemonic → seed (PBKDF2-HMAC-SHA512, 2048 rounds)
//!   2. SLIP-10: seed → HD key at m/44'/501'/0'/0' (Phantom-compatible)
//!   3. Ed25519: 32-byte seed → keypair
//!   4. base58: public key → Solana address
//!
//! ## Security Purpose
//! Used to verify that the mnemonic entered on a server node belongs
//! to the same wallet that burned tokens and received the activation code.
//! Without this, an attacker with a stolen code could use any mnemonic.
//!
//! ## Mobile Equivalent (WalletManager.js)
//! ```js
//! const seed = bip39.mnemonicToSeedSync(mnemonic);           // PBKDF2
//! const { key } = derivePath("m/44'/501'/0'/0'", seedHex);   // SLIP-10
//! const keypair = Keypair.fromSeed(key);                     // Ed25519
//! const solanaAddress = keypair.publicKey.toString();         // base58
//! ```

use hmac::{Hmac, Mac};
use sha2::Sha512;

type HmacSha512 = Hmac<Sha512>;

/// Derive Solana address from BIP39 mnemonic phrase.
/// Returns base58-encoded Ed25519 public key (= Solana address).
///
/// This MUST produce the same address as the mobile app's WalletManager.importWallet().
pub fn derive_solana_address_from_mnemonic(mnemonic: &str) -> Result<String, String> {
    let mnemonic = mnemonic.trim();
    if mnemonic.is_empty() {
        return Err("Empty mnemonic".to_string());
    }

    // Step 1: BIP39 mnemonic → 64-byte seed
    // PBKDF2-HMAC-SHA512, password=mnemonic, salt="mnemonic", iterations=2048
    let seed = bip39_mnemonic_to_seed(mnemonic);

    // Step 2: SLIP-10 HD derivation at m/44'/501'/0'/0'
    // Same as ed25519-hd-key npm package used by mobile
    let derived_key = slip10_derive_path(&seed, &[44, 501, 0, 0])
        .map_err(|e| format!("SLIP-10 derivation failed: {}", e))?;

    // Step 3: Ed25519 keypair from 32-byte seed
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&derived_key);
    let verifying_key = signing_key.verifying_key();

    // Step 4: base58 encode public key = Solana address
    let solana_address = bs58::encode(verifying_key.as_bytes()).into_string();

    Ok(solana_address)
}

/// Derive Ed25519 signing key from mnemonic (for creating signatures).
/// Returns the 32-byte Ed25519 signing key.
pub fn derive_solana_signing_key_from_mnemonic(mnemonic: &str) -> Result<ed25519_dalek::SigningKey, String> {
    let mnemonic = mnemonic.trim();
    if mnemonic.is_empty() {
        return Err("Empty mnemonic".to_string());
    }

    let seed = bip39_mnemonic_to_seed(mnemonic);
    let derived_key = slip10_derive_path(&seed, &[44, 501, 0, 0])
        .map_err(|e| format!("SLIP-10 derivation failed: {}", e))?;

    Ok(ed25519_dalek::SigningKey::from_bytes(&derived_key))
}

/// Verify Ed25519 signature against a Solana address (base58 public key).
pub fn verify_ed25519_signature(
    message: &[u8],
    signature_hex: &str,
    solana_address: &str,
) -> Result<bool, String> {
    use ed25519_dalek::Verifier;

    // Decode Solana address (base58) → 32-byte public key
    let pubkey_bytes = bs58::decode(solana_address)
        .into_vec()
        .map_err(|e| format!("Invalid Solana address base58: {}", e))?;

    if pubkey_bytes.len() != 32 {
        return Err(format!("Invalid public key length: {} (expected 32)", pubkey_bytes.len()));
    }

    let mut pk_array = [0u8; 32];
    pk_array.copy_from_slice(&pubkey_bytes);

    let verifying_key = ed25519_dalek::VerifyingKey::from_bytes(&pk_array)
        .map_err(|e| format!("Invalid Ed25519 public key: {}", e))?;

    // Decode signature (hex) → 64-byte Ed25519 signature
    let sig_bytes = hex::decode(signature_hex)
        .map_err(|e| format!("Invalid signature hex: {}", e))?;

    if sig_bytes.len() != 64 {
        return Err(format!("Invalid signature length: {} (expected 64)", sig_bytes.len()));
    }

    let mut sig_array = [0u8; 64];
    sig_array.copy_from_slice(&sig_bytes);

    let signature = ed25519_dalek::Signature::from_bytes(&sig_array);

    match verifying_key.verify(message, &signature) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}

// =========================================================================
// Internal: BIP39 seed derivation (PBKDF2-HMAC-SHA512)
// =========================================================================

/// BIP39 mnemonic → 64-byte seed using PBKDF2-HMAC-SHA512.
/// password = mnemonic, salt = "mnemonic", iterations = 2048, dkLen = 64
fn bip39_mnemonic_to_seed(mnemonic: &str) -> [u8; 64] {
    let password = mnemonic.as_bytes();
    let salt = b"mnemonic"; // BIP39 spec: salt = "mnemonic" + optional passphrase (empty)
    let iterations = 2048;

    let mut output = [0u8; 64];
    pbkdf2_hmac_sha512(password, salt, iterations, &mut output);
    output
}

/// PBKDF2-HMAC-SHA512 implementation (RFC 8018).
fn pbkdf2_hmac_sha512(password: &[u8], salt: &[u8], iterations: u32, output: &mut [u8]) {
    let hlen = 64usize; // SHA-512 output = 64 bytes
    let num_blocks = (output.len() + hlen - 1) / hlen;

    for block_num in 1..=(num_blocks as u32) {
        // U_1 = PRF(password, salt || INT(block_num))
        let mut mac = HmacSha512::new_from_slice(password)
            .expect("HMAC can take key of any size");
        mac.update(salt);
        mac.update(&block_num.to_be_bytes());
        let u1 = mac.finalize().into_bytes();

        let mut result = [0u8; 64];
        result.copy_from_slice(&u1);
        let mut prev = u1;

        // U_2 .. U_c
        for _ in 1..iterations {
            let mut mac = HmacSha512::new_from_slice(password)
                .expect("HMAC can take key of any size");
            mac.update(&prev);
            let u = mac.finalize().into_bytes();
            for (r, u_byte) in result.iter_mut().zip(u.iter()) {
                *r ^= u_byte;
            }
            prev = u;
        }

        let start = ((block_num - 1) as usize) * hlen;
        let end = (start + hlen).min(output.len());
        output[start..end].copy_from_slice(&result[..end - start]);
    }
}

// =========================================================================
// Internal: SLIP-10 Ed25519 HD derivation
// =========================================================================

/// SLIP-10 master key derivation.
/// HMAC-SHA512(key="ed25519 seed", data=seed) → (private_key, chain_code)
fn slip10_master_key(seed: &[u8; 64]) -> Result<([u8; 32], [u8; 32]), String> {
    let mut mac = HmacSha512::new_from_slice(b"ed25519 seed")
        .map_err(|e| format!("HMAC init failed: {}", e))?;
    mac.update(seed);
    let result = mac.finalize().into_bytes();

    let mut private_key = [0u8; 32];
    let mut chain_code = [0u8; 32];
    private_key.copy_from_slice(&result[..32]);
    chain_code.copy_from_slice(&result[32..]);

    Ok((private_key, chain_code))
}

/// SLIP-10 child key derivation (hardened only, as required for Ed25519).
/// HMAC-SHA512(key=chain_code, data=0x00 || private_key || index_hardened)
fn slip10_ckd_private(
    parent_key: &[u8; 32],
    parent_chain_code: &[u8; 32],
    index: u32,
) -> Result<([u8; 32], [u8; 32]), String> {
    // Hardened index = index + 0x80000000
    let hardened_index = index.checked_add(0x80000000)
        .ok_or_else(|| "Index overflow".to_string())?;

    let mut mac = HmacSha512::new_from_slice(parent_chain_code)
        .map_err(|e| format!("HMAC init failed: {}", e))?;
    mac.update(&[0x00]); // Ed25519: always 0x00 prefix
    mac.update(parent_key);
    mac.update(&hardened_index.to_be_bytes());
    let result = mac.finalize().into_bytes();

    let mut child_key = [0u8; 32];
    let mut child_chain_code = [0u8; 32];
    child_key.copy_from_slice(&result[..32]);
    child_chain_code.copy_from_slice(&result[32..]);

    Ok((child_key, child_chain_code))
}

/// Derive Ed25519 private key at SLIP-10 path.
/// path = [44, 501, 0, 0] → m/44'/501'/0'/0' (Phantom wallet standard)
fn slip10_derive_path(seed: &[u8; 64], path: &[u32]) -> Result<[u8; 32], String> {
    let (mut key, mut chain_code) = slip10_master_key(seed)?;

    for &index in path {
        let (child_key, child_chain_code) = slip10_ckd_private(&key, &chain_code, index)?;
        key = child_key;
        chain_code = child_chain_code;
    }

    Ok(key)
}

// =========================================================================
// QNet Ed25519 Key Derivation (BIP44 m/44'/9999'/0'/0'/0')
// =========================================================================

/// Derive QNet Ed25519 signing key from BIP39 mnemonic.
/// Path: m/44'/9999'/0'/0'/0' — same as mobile WalletManager.js generateQNetKeypair().
pub fn derive_qnet_signing_key_from_mnemonic(mnemonic: &str) -> Result<ed25519_dalek::SigningKey, String> {
    let mnemonic = mnemonic.trim();
    if mnemonic.is_empty() {
        return Err("Empty mnemonic".to_string());
    }

    let seed = bip39_mnemonic_to_seed(mnemonic);
    let derived_key = slip10_derive_path(&seed, &[44, 9999, 0, 0, 0])
        .map_err(|e| format!("SLIP-10 QNet derivation failed: {}", e))?;

    Ok(ed25519_dalek::SigningKey::from_bytes(&derived_key))
}

// =========================================================================
// QNet Address Derivation (BIP44 m/44'/9999'/0'/0'/0', matches mobile app)
// =========================================================================

/// Derive QNet EON wallet address from BIP39 mnemonic phrase.
///
/// Replicates WalletManager.js generateQNetAddress() exactly:
///   1. BIP39: mnemonic → seed (PBKDF2-HMAC-SHA512)
///   2. SLIP-10: seed → m/44'/9999'/0'/0'/0'
///   3. Ed25519: derived_key → 32-byte public key (nacl.sign.keyPair.fromSeed)
///   4. SHA-512(pubkey) → hex
///   5. Format: {19hex}eon{15hex}{4hex SHA3-256 checksum}
pub fn derive_qnet_address_from_mnemonic(mnemonic: &str) -> Result<String, String> {
    use sha2::{Sha512, Digest as Sha2Digest};
    use sha3::Sha3_256;

    let mnemonic = mnemonic.trim();
    if mnemonic.is_empty() {
        return Err("Empty mnemonic".to_string());
    }

    // Step 1: BIP39 mnemonic → 64-byte seed
    let seed = bip39_mnemonic_to_seed(mnemonic);

    // Step 2: SLIP-10 HD derivation at m/44'/9999'/0'/0'/0'
    // QNet coin type = 9999 (0x270F), matches mobile BIP44 path
    let derived_key = slip10_derive_path(&seed, &[44, 9999, 0, 0, 0])
        .map_err(|e| format!("SLIP-10 QNet derivation failed: {}", e))?;

    // Step 3: Ed25519 keypair from 32-byte seed (matches nacl.sign.keyPair.fromSeed)
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&derived_key);
    let verifying_key = signing_key.verifying_key();
    let pubkey_bytes = verifying_key.as_bytes();

    // Step 4: SHA-512 of public key → hex string (matches CryptoJS.SHA512)
    let mut sha512_hasher = Sha512::new();
    sha512_hasher.update(pubkey_bytes);
    let full_hash = hex::encode(sha512_hasher.finalize());

    // Step 5: Address format: 19 chars + "eon" + 15 chars + 4-char SHA3-256 checksum
    let part1 = full_hash[..19].to_lowercase();
    let part2 = full_hash[19..34].to_lowercase();
    let body = format!("{}eon{}", part1, part2);

    let mut sha3_hasher = Sha3_256::new();
    sha3_hasher.update(body.as_bytes());
    let checksum_hex = hex::encode(sha3_hasher.finalize());
    let checksum = &checksum_hex[..4];

    Ok(format!("{}eon{}{}", part1, part2, checksum))
}

// =========================================================================
// Tests
// =========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derivation_deterministic() {
        let addr1 = derive_solana_address_from_mnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about").unwrap();
        let addr2 = derive_solana_address_from_mnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about").unwrap();
        assert_eq!(addr1, addr2);
        // Solana addresses are base58, 32-44 chars
        assert!(addr1.len() >= 32 && addr1.len() <= 44, "address length: {}", addr1.len());
        println!("Derived Solana address: {}", addr1);
    }

    #[test]
    fn test_derivation_different_mnemonics() {
        let addr1 = derive_solana_address_from_mnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about").unwrap();
        let addr2 = derive_solana_address_from_mnemonic("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong").unwrap();
        assert_ne!(addr1, addr2);
    }

    #[test]
    fn test_empty_mnemonic_fails() {
        assert!(derive_solana_address_from_mnemonic("").is_err());
        assert!(derive_solana_address_from_mnemonic("  ").is_err());
    }

    #[test]
    fn test_ed25519_sign_verify() {
        let mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let solana_addr = derive_solana_address_from_mnemonic(mnemonic).unwrap();
        let signing_key = derive_solana_signing_key_from_mnemonic(mnemonic).unwrap();

        use ed25519_dalek::Signer;
        let message = b"register:QNET-SXXXXX-YYYYYY-ZZZZZZ:1234567890";
        let signature = signing_key.sign(message);
        let sig_hex = hex::encode(signature.to_bytes());

        assert!(verify_ed25519_signature(message, &sig_hex, &solana_addr).unwrap());
        // Wrong message
        assert!(!verify_ed25519_signature(b"wrong", &sig_hex, &solana_addr).unwrap());
    }
}

