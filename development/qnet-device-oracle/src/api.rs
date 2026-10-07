//! Request bodies of the internal API and its error shape. Every body is JSON; keys are hex, tokens and
//! receipts are passed through as the device produced them.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::types::{Op, Platform, Prov, Refusal, Trust};

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaimRequest {
    pub node_id: String,
    pub platform: Platform,
    /// `enrol` (first link, Use this device, re-link) or `rebind` (another wallet in the same install).
    pub op: Op,
    /// The device-signed enrolment or rebind message.
    pub preimage: String,
    /// hex of the 65-byte device key.
    pub hw_pub: String,
    pub prov: Prov,
    pub trust: Trust,
    /// The genesis view: the key was never bound (its `ldk_` index).
    #[serde(default)]
    pub key_new: Option<bool>,
    /// Android: hex(sha3(attestation key)), its certificate count, and whether it already holds a live key.
    /// The key and the live-key flag count for remote-provisioned chains only.
    #[serde(default)]
    pub att_key: Option<String>,
    #[serde(default)]
    pub certs_issued: Option<u32>,
    #[serde(default)]
    pub att_key_multi: bool,
    /// iOS: the attestation receipt (base64) of a newly attested key.
    #[serde(default)]
    pub receipt: Option<String>,
    #[serde(default)]
    pub dc_token: Option<String>,
    #[serde(default)]
    pub pi_token: Option<String>,
    /// A support reference the user quotes to clear a slot.
    #[serde(default)]
    pub reset_ref: Option<String>,
    /// The end user's address, for the per-IP limit only; held in memory, never stored or logged.
    #[serde(default)]
    pub client_ip: Option<String>,
    /// Public evidence the genesis verified (attestation object, chain, report), kept sealed for appeals.
    #[serde(default)]
    pub evidence: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RefreshRequest {
    pub node_id: String,
    pub preimage: String,
    #[serde(default)]
    pub dc_token: Option<String>,
    #[serde(default)]
    pub pi_token: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseRequest {
    pub node_id: String,
    pub preimage: String,
    #[serde(default)]
    pub dc_token: Option<String>,
    #[serde(default)]
    pub pi_token: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RotateRequest {
    pub node_id: String,
    pub preimage: String,
    /// The new device key.
    pub hw_pub: String,
    pub prov: Prov,
    pub trust: Trust,
    #[serde(default)]
    pub att_key: Option<String>,
    #[serde(default)]
    pub certs_issued: Option<u32>,
    #[serde(default)]
    pub att_key_multi: bool,
    #[serde(default)]
    pub receipt: Option<String>,
    #[serde(default)]
    pub dc_token: Option<String>,
    #[serde(default)]
    pub pi_token: Option<String>,
    #[serde(default)]
    pub evidence: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeRequest {
    pub node_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PiDecodeRequest {
    pub token: String,
    /// The nonce the token must carry.
    pub nonce: String,
}

/// A refusal the genesis issued itself, filed so support can answer an appeal quoting its `ref`.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RefusalRequest {
    pub node_id: String,
    pub platform: Platform,
    pub hw_pub: String,
    /// b64url of the 32-byte challenge nonce of the refused message.
    pub nonce: String,
    pub reason: String,
    #[serde(default)]
    pub evidence: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApproveRequest {
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(default)]
    pub node_id: Option<String>,
    pub operator: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ApiError {
    Refused { reason: Refusal, reference: Option<String>, until: Option<u64>, retry_at: Option<u64> },
    BadRequest(String),
    NotFound(&'static str),
    Conflict(&'static str),
    Forbidden,
    Unavailable(String),
    Internal(String),
}

impl ApiError {
    pub fn refused(reason: Refusal) -> Self {
        ApiError::Refused { reason, reference: None, until: None, retry_at: None }
    }

    pub fn bad(msg: &str) -> Self {
        ApiError::BadRequest(msg.to_string())
    }

    pub fn status(&self) -> u16 {
        match self {
            ApiError::Refused { .. } => 422,
            ApiError::BadRequest(_) => 400,
            ApiError::NotFound(_) => 404,
            ApiError::Conflict(_) => 409,
            ApiError::Forbidden => 403,
            ApiError::Unavailable(_) => 503,
            ApiError::Internal(_) => 500,
        }
    }

    pub fn body(&self) -> Value {
        match self {
            ApiError::Refused { reason, reference, until, retry_at } => {
                let mut v = json!({"error": reason.as_str()});
                if let Some(r) = reference {
                    v["ref"] = json!(r);
                }
                if let Some(u) = until {
                    v["until"] = json!(u);
                }
                if let Some(r) = retry_at {
                    v["retry_at"] = json!(r);
                }
                v
            }
            ApiError::BadRequest(m) => json!({"error": "bad_request", "detail": m}),
            ApiError::NotFound(m) => json!({"error": m}),
            ApiError::Conflict(m) => json!({"error": m}),
            ApiError::Forbidden => json!({"error": "forbidden"}),
            ApiError::Unavailable(m) => json!({"error": "unavailable", "detail": m}),
            ApiError::Internal(_) => json!({"error": "internal"}),
        }
    }
}
