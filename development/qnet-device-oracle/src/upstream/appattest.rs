//! App Attest receipt exchange: the only Apple signal that sees many keys on one device (the risk metric).
//! Receipt parsing and its signature chain to the Apple root belong to `qnet-device-attest`, which the
//! genesis attestors use too; this module only talks to Apple and applies the oracle's freshness rule.

use std::sync::Arc;

use super::devicecheck::AppleEnv;
use super::jwt::Es256Jwt;
use super::{classify_status, HttpClient, HttpRequest, Method, VendorError};
use crate::messages::{b64_decode, b64_encode};

/// A fresh receipt is at most this old when it arrives (Apple's replay guidance).
pub const RECEIPT_MAX_AGE: u64 = 300;

/// The fields of a receipt whose signature verified.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiptInfo {
    pub app_id: String,
    /// The certified key's uncompressed point.
    pub public_key: Vec<u8>,
    /// `ATTEST` (inside an attestation object) or `RECEIPT` (from an exchange, carries the metric).
    pub attest: bool,
    pub created_at: u64,
    pub metric: Option<u32>,
    pub not_before: Option<u64>,
    pub expires_at: Option<u64>,
}

pub trait ReceiptVerifier: Send + Sync {
    fn verify(&self, der: &[u8], now: u64) -> Result<ReceiptInfo, String>;
}

/// Receipts checked with the shared verifier and the Apple root it pins.
pub struct AppleReceipts;

impl ReceiptVerifier for AppleReceipts {
    fn verify(&self, der: &[u8], now: u64) -> Result<ReceiptInfo, String> {
        use qnet_device_attest::receipt::{verify_receipt, ReceiptKind};
        let r = verify_receipt(der, now as i64).map_err(|e| e.to_string())?;
        let t = |x: i64| x.max(0) as u64;
        Ok(ReceiptInfo {
            app_id: r.app_id,
            public_key: r.public_key.as_bytes().to_vec(),
            attest: r.kind == ReceiptKind::Attest,
            created_at: t(r.created_at),
            metric: r.risk_metric,
            not_before: r.not_before.map(t),
            expires_at: r.expires_at.map(t),
        })
    }
}

pub enum Exchange {
    New(Vec<u8>),
    /// The receipt's not-before has not passed yet.
    NotYet,
}

pub struct AppAttestData {
    http: Arc<dyn HttpClient>,
    jwt: Arc<Es256Jwt>,
    prod_url: String,
    dev_url: String,
    /// `<TeamID>.<bundle id>`.
    app_id: String,
    verifier: Arc<dyn ReceiptVerifier>,
}

impl AppAttestData {
    pub fn new(
        http: Arc<dyn HttpClient>,
        jwt: Arc<Es256Jwt>,
        prod_url: &str,
        dev_url: &str,
        app_id: &str,
        verifier: Arc<dyn ReceiptVerifier>,
    ) -> Self {
        AppAttestData {
            http,
            jwt,
            prod_url: prod_url.trim_end_matches('/').to_string(),
            dev_url: dev_url.trim_end_matches('/').to_string(),
            app_id: app_id.to_string(),
            verifier,
        }
    }

    pub fn exchange(&self, receipt: &[u8], env: AppleEnv, now: u64) -> Result<Exchange, VendorError> {
        let base = match env {
            AppleEnv::Production => &self.prod_url,
            AppleEnv::Development => &self.dev_url,
        };
        let jwt = self.jwt.token(now).map_err(VendorError::Config)?;
        let req = HttpRequest {
            method: Method::Post,
            url: format!("{}/v1/attestationData", base),
            headers: vec![("authorization", jwt)],
            body: b64_encode(receipt).into_bytes(),
        };
        let resp = self.http.send(&req).map_err(|e| VendorError::Unavailable(format!("appattest {}", e)))?;
        match resp.status {
            200 => {
                let text = String::from_utf8_lossy(&resp.body);
                b64_decode(&text)
                    .map(Exchange::New)
                    .ok_or_else(|| VendorError::Unavailable("appattest answer is not base64".into()))
            }
            304 => Ok(Exchange::NotYet),
            s => Err(classify_status(s, "appattest")),
        }
    }

    /// Checks a receipt for this app and this device key. `fresh` also requires a metric receipt
    /// created within the last five minutes.
    pub fn check(&self, der: &[u8], hw_pub: &[u8], fresh: bool, now: u64) -> Result<ReceiptInfo, String> {
        let r = self.verifier.verify(der, now)?;
        if r.app_id != self.app_id {
            return Err("receipt: another app".into());
        }
        if r.public_key != hw_pub {
            return Err("receipt: another key".into());
        }
        if fresh {
            if r.attest || r.metric.is_none() {
                return Err("receipt: not a metric receipt".into());
            }
            if r.created_at > now + 60 || now.saturating_sub(r.created_at) > RECEIPT_MAX_AGE {
                return Err("receipt: not fresh".into());
            }
        }
        Ok(r)
    }
}
