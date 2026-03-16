/// Post-Quantum Multi-Signature Wallet Contract
///
/// A 2-of-N Dilithium5 multisig wallet deployed on QNet's PQ-EVM.
/// Unlike ECDSA multisigs (Gnosis Safe, etc.), all signing keys use
/// CRYSTALS-Dilithium5 — quantum-resistant per NIST FIPS 204.
///
/// # Protocol
///
/// 1. Deploy with list of owner PQ public keys and required threshold.
/// 2. Any owner calls `submit_tx(to, value, data)` → returns `tx_id`.
/// 3. Each owner calls `confirm(tx_id)` with a valid Dilithium5 signature.
/// 4. Once `confirmations >= threshold`, anyone can call `execute(tx_id)`.
///
/// # Storage layout
///
/// | Slot                   | Content                            |
/// |------------------------|------------------------------------|
/// | 0x00                   | threshold (u64)                    |
/// | 0x01                   | owner_count (u64)                  |
/// | 0x10_0000 + i          | owners[i] public key offset        |
/// | 0x20_0000 + tx_id      | Transaction { to, value, data_len, executed } |
/// | 0x30_0000 + tx_id * N  | confirmations bitmask              |

use crate::{Address, PQEvmInterpreter, ExecutionContext, GasConfig};
// QNet consensus uses CRYSTALS-Dilithium3 (ML-DSA-65, NIST FIPS 204 level 3)
use pqcrypto_mldsa::mldsa65 as dilithium3;
use pqcrypto_traits::sign::PublicKey;

// ─────────────────────────────────────────────────────────────────────────────
// Off-chain helper: build a confirm-transaction calldata payload
// ─────────────────────────────────────────────────────────────────────────────

/// Build the calldata bytes for a `confirm(tx_id)` call, including the
/// Dilithium3 signature over the canonical message `"CONFIRM:<tx_id>"`.
///
/// # Arguments
/// * `tx_id`   — transaction index in the multisig queue
/// * `secret_key` — caller's Dilithium3 secret key (ML-DSA-65)
///
/// # Returns
/// Raw calldata bytes ready to pass as `input_data` in a QNet transaction.
pub fn build_confirm_calldata(tx_id: u64, secret_key: &dilithium3::SecretKey) -> Vec<u8> {
    let canonical_msg = format!("CONFIRM:{}", tx_id);
    let signed = dilithium3::sign(canonical_msg.as_bytes(), secret_key);
    let sig_bytes = signed.as_bytes();

    // Calldata layout:
    //   [0..4]   selector = 0x00_00_00_03 (confirm)
    //   [4..12]  tx_id as big-endian u64
    //   [12..16] sig_len as big-endian u32
    //   [16..]   signature bytes
    let mut data = vec![0x00, 0x00, 0x00, 0x03]; // selector: confirm
    data.extend_from_slice(&tx_id.to_be_bytes());
    data.extend_from_slice(&(sig_bytes.len() as u32).to_be_bytes());
    data.extend_from_slice(sig_bytes);
    data
}

/// Build calldata for `submit_tx(to, value, data)`.
pub fn build_submit_calldata(to: Address, value: u64, tx_data: &[u8]) -> Vec<u8> {
    // selector: 0x00_00_00_01
    let mut data = vec![0x00, 0x00, 0x00, 0x01];
    data.extend_from_slice(&to);                              // 20 bytes
    data.extend_from_slice(&value.to_be_bytes());             //  8 bytes
    data.extend_from_slice(&(tx_data.len() as u32).to_be_bytes()); // 4 bytes
    data.extend_from_slice(tx_data);
    data
}

// ─────────────────────────────────────────────────────────────────────────────
// On-chain verification helper (runs inside PQ-EVM via Rust FFI)
// ─────────────────────────────────────────────────────────────────────────────

/// Verify that `sig_bytes` is a valid Dilithium3 signature over
/// `"CONFIRM:<tx_id>"` by the owner whose public key is `pk_bytes`.
///
/// Uses ML-DSA-65 (CRYSTALS-Dilithium3) — the same algorithm that QNet's
/// `quantum_crypto.rs` uses for all consensus signatures.
///
/// Called from the `confirm()` handler inside the PQ-EVM interpreter via the
/// PQ_VERIFY (0xF1) opcode; this Rust function is the underlying implementation.
pub fn verify_confirm_sig(tx_id: u64, pk_bytes: &[u8], sig_bytes: &[u8]) -> bool {
    let canonical_msg = format!("CONFIRM:{}", tx_id);

    let pk = match dilithium3::PublicKey::from_bytes(pk_bytes) {
        Ok(k) => k,
        Err(_) => return false,
    };
    let signed_msg = match dilithium3::SignedMessage::from_bytes(sig_bytes) {
        Ok(s) => s,
        Err(_) => return false,
    };
    match dilithium3::open(&signed_msg, &pk) {
        Ok(verified_msg) => verified_msg == canonical_msg.as_bytes(),
        Err(_) => false,
    }
}

/// Pending transaction entry stored in EVM state.
#[derive(Debug, Clone)]
pub struct PendingTx {
    pub to: Address,
    pub value: u64,
    pub data: Vec<u8>,
    pub confirmations: Vec<usize>, // confirmed owner indices
    pub executed: bool,
}

/// In-memory multisig state (mirrors on-chain SSTORE slots for testing).
pub struct PQMultisig {
    pub owners: Vec<dilithium3::PublicKey>,
    pub threshold: usize,
    pub txs: Vec<PendingTx>,
}

impl PQMultisig {
    pub fn new(owners: Vec<dilithium3::PublicKey>, threshold: usize) -> Self {
        assert!(threshold <= owners.len(), "threshold > owner count");
        Self { owners, threshold, txs: Vec::new() }
    }

    /// Submit a new transaction, returns tx_id.
    pub fn submit_tx(&mut self, to: Address, value: u64, data: Vec<u8>) -> usize {
        self.txs.push(PendingTx { to, value, data, confirmations: Vec::new(), executed: false });
        self.txs.len() - 1
    }

    /// Confirm a transaction with a Dilithium5 signature.
    /// Returns `true` if the signature is valid and owner hasn't confirmed yet.
    pub fn confirm(&mut self, tx_id: usize, owner_idx: usize, sig_bytes: &[u8]) -> bool {
        if tx_id >= self.txs.len() || owner_idx >= self.owners.len() { return false; }
        if self.txs[tx_id].executed { return false; }
        if self.txs[tx_id].confirmations.contains(&owner_idx) { return false; }

        if verify_confirm_sig(tx_id as u64, self.owners[owner_idx].as_bytes(), sig_bytes) {
            self.txs[tx_id].confirmations.push(owner_idx);
            true
        } else {
            false
        }
    }

    /// Execute if threshold reached. Returns the calldata that would be sent.
    pub fn execute(&mut self, tx_id: usize) -> Result<Vec<u8>, &'static str> {
        let tx = self.txs.get_mut(tx_id).ok_or("tx not found")?;
        if tx.executed { return Err("already executed"); }
        if tx.confirmations.len() < self.threshold { return Err("insufficient confirmations"); }
        tx.executed = true;
        Ok(tx.data.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pq_multisig_2of3() {
        let (pk1, sk1) = dilithium3::keypair();
        let (pk2, sk2) = dilithium3::keypair();
        let (pk3, _sk3) = dilithium3::keypair();

        let mut wallet = PQMultisig::new(vec![pk1, pk2, pk3], 2);
        let to: Address = [0xAA; 20];
        let tx_id = wallet.submit_tx(to, 1000, vec![]);

        let sig1 = dilithium3::sign(format!("CONFIRM:{}", tx_id).as_bytes(), &sk1);
        let sig2 = dilithium3::sign(format!("CONFIRM:{}", tx_id).as_bytes(), &sk2);

        assert!(wallet.confirm(tx_id, 0, sig1.as_bytes()));
        assert!(wallet.confirm(tx_id, 1, sig2.as_bytes()));
        assert!(wallet.execute(tx_id).is_ok());
    }
}
