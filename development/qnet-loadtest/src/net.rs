//! HTTP client for the QNet node RPC surface used by the load test:
//! real `/api/v1/transaction` submit + inclusion/finality queries.

use serde::Serialize;
use serde_json::Value;

/// Flat request body accepted by `POST /api/v1/transaction` (node
/// `TransactionRequest`). Server sets timestamp/hash/tx_type itself.
/// `dilithium_public_key`: hex(raw 1952 B) on an account's FIRST tx; None
/// afterwards — the node rehydrates the elided pk from committed state.
#[derive(Serialize, Debug)]
pub struct TxRequest {
    pub from: String,
    pub to: String,
    pub amount: u64,
    pub gas_price: u64,
    pub gas_limit: u64,
    pub nonce: u64,
    pub dilithium_signature: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dilithium_public_key: Option<String>,
}

#[derive(Clone)]
pub struct NodeClient {
    http: reqwest::Client,
    pub base: String,
}

impl NodeClient {
    pub fn new(base: &str) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .pool_max_idle_per_host(64)
            .build()
            .expect("reqwest client build");
        Self { http, base: base.trim_end_matches('/').to_string() }
    }

    /// Submit a transaction; returns the server-assigned `tx_hash` on success.
    pub async fn submit_tx(&self, req: &TxRequest) -> Result<String, String> {
        let url = format!("{}/api/v1/transaction", self.base);
        let resp = self.http.post(&url).json(req).send().await.map_err(|e| e.to_string())?;
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        if v.get("success").and_then(|s| s.as_bool()) == Some(true) {
            v.get("tx_hash").and_then(|h| h.as_str()).map(String::from)
                .ok_or_else(|| "response missing tx_hash".to_string())
        } else {
            Err(v.get("error").and_then(|e| e.as_str()).unwrap_or("submit failed").to_string())
        }
    }

    /// Current local microblock height.
    pub async fn get_height(&self) -> Result<u64, String> {
        let url = format!("{}/api/v1/height", self.base);
        let v: Value = self.http.get(&url).send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;
        v.get("height").and_then(|h| h.as_u64()).ok_or_else(|| "no height field".to_string())
    }

    /// Transaction hashes included in the microblock at height `h`.
    pub async fn microblock_tx_hashes(&self, h: u64) -> Result<Vec<String>, String> {
        let url = format!("{}/api/v1/microblock/{}", self.base, h);
        let resp = self.http.get(&url).send().await.map_err(|e| e.to_string())?;
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(v.get("transactions").and_then(|t| t.as_array())
            .map(|arr| arr.iter()
                .filter_map(|t| t.get("hash").and_then(|h| h.as_str()).map(String::from))
                .collect())
            .unwrap_or_default())
    }

    /// True iff macroblock `index` is hard-finalized: its 2f+1 checkpoint QC is
    /// present and `qc.signers >= floor(2*committee/3)+1`.
    pub async fn macroblock_hard_final(&self, index: u64, fallback_committee: usize) -> Result<bool, String> {
        let url = format!("{}/api/v1/macroblock/{}/proof", self.base, index);
        let v: Value = self.http.get(&url).send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;
        if v.get("error").is_some() {
            return Ok(false); // not yet finalized / no QC yet
        }
        let signers = v.pointer("/qc/signers").and_then(|s| s.as_array()).map(|a| a.len()).unwrap_or(0);
        // Prefer the committee the node reports; if it doesn't enumerate it (empty array),
        // fall back to the operator-supplied --committee size. 0 = no assumption → not counted.
        let reported = v.get("committee").and_then(|c| c.as_array()).map(|a| a.len()).unwrap_or(0);
        let committee = if reported > 0 { reported } else { fallback_committee };
        if committee == 0 { return Ok(false); }
        Ok(signers >= (2 * committee) / 3 + 1)
    }

    /// Fetch a SHARDED 2-level logs-inclusion proof for a tx: returns
    /// (raw_leaf, level1_steps, block_root, level2_steps, logs_root_hex). Level 1 folds leaf→block_root;
    /// level 2 folds block_root→logs_root. Used by P3b; requires the sharded `/logs/proof` code deployed.
    pub async fn logs_proof(&self, tx_hash: &str, log_index: usize)
        -> Result<(Vec<u8>, Vec<crate::proof::ProofStep>, [u8; 32], Vec<crate::proof::ProofStep>, String), String>
    {
        let url = format!("{}/api/v1/logs/proof?tx_hash={}&log_index={}", self.base, tx_hash, log_index);
        let v: Value = self.http.get(&url).send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;
        if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
            return Err(err.to_string());
        }
        let leaf_hex = v.get("leaf").and_then(|l| l.as_str()).ok_or("proof missing leaf")?;
        let leaf = hex::decode(leaf_hex).map_err(|e| format!("bad leaf hex: {e}"))?;
        let root = v.get("logs_root").and_then(|r| r.as_str()).ok_or("proof missing logs_root")?.to_string();
        let block_root_hex = v.get("block_root").and_then(|r| r.as_str()).ok_or("proof missing block_root")?;
        let mut block_root = [0u8; 32];
        hex::decode_to_slice(block_root_hex, &mut block_root).map_err(|e| format!("bad block_root hex: {e}"))?;
        let l1 = crate::proof::parse_proof(
            v.get("proof").and_then(|p| p.as_array()).map(|a| a.as_slice()).unwrap_or(&[])
        )?;
        let l2 = crate::proof::parse_proof(
            v.get("window_proof").and_then(|p| p.as_array()).map(|a| a.as_slice()).unwrap_or(&[])
        )?;
        Ok((leaf, l1, block_root, l2, root))
    }
}

/// Macroblock index that finalizes microblock height `h` (QNet: 90 microblocks/macroblock).
pub fn finalizing_macroblock(h: u64) -> u64 {
    if h == 0 { 0 } else { (h - 1) / 90 + 1 }
}
