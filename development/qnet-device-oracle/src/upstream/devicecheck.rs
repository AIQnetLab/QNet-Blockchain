//! Apple's per-device two bits: the iOS carrier of the device slot.

use std::sync::Arc;

use super::jwt::Es256Jwt;
use super::{classify_status, HttpClient, HttpRequest, Method, VendorError};

/// Production (App Store, TestFlight) or development (builds signed with our development key).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppleEnv {
    Production,
    Development,
}

pub struct DeviceCheck {
    http: Arc<dyn HttpClient>,
    jwt: Arc<Es256Jwt>,
    prod_url: String,
    dev_url: String,
}

fn transaction_id() -> String {
    let mut b = [0u8; 16];
    aws_lc_rs::rand::fill(&mut b).expect("system randomness");
    hex::encode(b)
}

impl DeviceCheck {
    pub fn new(http: Arc<dyn HttpClient>, jwt: Arc<Es256Jwt>, prod_url: &str, dev_url: &str) -> Self {
        DeviceCheck {
            http,
            jwt,
            prod_url: prod_url.trim_end_matches('/').to_string(),
            dev_url: dev_url.trim_end_matches('/').to_string(),
        }
    }

    fn post(&self, path: &str, env: AppleEnv, body: serde_json::Value, now_ms: u64) -> Result<(u16, Vec<u8>), VendorError> {
        let base = match env {
            AppleEnv::Production => &self.prod_url,
            AppleEnv::Development => &self.dev_url,
        };
        let jwt = self.jwt.token(now_ms / 1000).map_err(VendorError::Config)?;
        let req = HttpRequest {
            method: Method::Post,
            url: format!("{}{}", base, path),
            headers: vec![("authorization", format!("Bearer {}", jwt)), ("content-type", "application/json".into())],
            body: body.to_string().into_bytes(),
        };
        let resp = self.http.send(&req).map_err(|e| VendorError::Unavailable(format!("devicecheck {}", e)))?;
        Ok((resp.status, resp.body))
    }

    /// Reads the two bits. `Ok(None)`: no bits were ever set for this device.
    pub fn query(&self, token: &str, env: AppleEnv, now_ms: u64) -> Result<Option<(bool, bool)>, VendorError> {
        let body = serde_json::json!({"device_token": token, "transaction_id": transaction_id(), "timestamp": now_ms});
        let (status, resp) = self.post("/v1/query_two_bits", env, body, now_ms)?;
        if status != 200 {
            return Err(status_error(status, &resp));
        }
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&resp) {
            if v.is_object() {
                let bit = |k: &str| v.get(k).and_then(|b| b.as_bool()).unwrap_or(false);
                return Ok(Some((bit("bit0"), bit("bit1"))));
            }
        }
        let text = String::from_utf8_lossy(&resp).to_ascii_lowercase();
        if text.contains("bit state not found") || text.contains("failed to find bit state") {
            return Ok(None);
        }
        Err(VendorError::Unavailable("devicecheck unexpected query answer".into()))
    }

    pub fn update(&self, token: &str, env: AppleEnv, bit0: bool, bit1: bool, now_ms: u64) -> Result<(), VendorError> {
        let body = serde_json::json!({
            "device_token": token, "transaction_id": transaction_id(), "timestamp": now_ms,
            "bit0": bit0, "bit1": bit1,
        });
        let (status, resp) = self.post("/v1/update_two_bits", env, body, now_ms)?;
        if status == 200 {
            Ok(())
        } else {
            Err(status_error(status, &resp))
        }
    }
}

/// 400 with "Bad Device Token" is the device's; every other 400 is a malformed request of ours.
fn status_error(status: u16, body: &[u8]) -> VendorError {
    if status == 400 {
        let text = String::from_utf8_lossy(body).to_ascii_lowercase();
        if text.contains("device token") {
            return VendorError::Rejected("devicecheck bad device token".into());
        }
        return VendorError::Config(format!("devicecheck status=400 {}", text.chars().take(60).collect::<String>()));
    }
    classify_status(status, "devicecheck")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::upstream::fake::{test_jwt, FakeHttp};

    fn dc(http: Arc<FakeHttp>) -> DeviceCheck {
        DeviceCheck::new(http, test_jwt(), "https://dc.prod", "https://dc.dev")
    }

    #[test]
    fn query_reads_bits_or_not_found() {
        let http = Arc::new(FakeHttp::default());
        http.push("dc.prod/v1/query_two_bits", 200, br#"{"bit0":true,"bit1":false,"last_update_time":"2026-09"}"#);
        http.push("dc.dev/v1/query_two_bits", 200, b"Bit State Not Found");
        let d = dc(http.clone());
        assert_eq!(d.query("tok", AppleEnv::Production, 1).unwrap(), Some((true, false)));
        assert_eq!(d.query("tok", AppleEnv::Development, 1).unwrap(), None);
        let seen = http.seen.lock();
        let body: serde_json::Value = serde_json::from_slice(&seen[0].body).unwrap();
        assert_eq!(body["device_token"], "tok");
        assert!(seen[0].headers.iter().any(|(k, v)| *k == "authorization" && v.starts_with("Bearer ")));
    }

    #[test]
    fn errors_are_classified() {
        let http = Arc::new(FakeHttp::default());
        http.push("query", 400, b"Missing or badly formatted device token payload");
        http.push("query", 400, b"Bad Timestamp");
        http.push("query", 401, b"Unable to verify authorization token");
        http.push("query", 429, b"");
        http.push_err("query");
        let d = dc(http);
        assert!(matches!(d.query("t", AppleEnv::Production, 1), Err(VendorError::Rejected(_))));
        assert!(matches!(d.query("t", AppleEnv::Production, 1), Err(VendorError::Config(_))));
        assert!(matches!(d.query("t", AppleEnv::Production, 1), Err(VendorError::Config(_))));
        assert!(matches!(d.query("t", AppleEnv::Production, 1), Err(VendorError::Unavailable(_))));
        assert!(matches!(d.query("t", AppleEnv::Production, 1), Err(VendorError::Unavailable(_))));
    }

    #[test]
    fn update_sends_both_bits() {
        let http = Arc::new(FakeHttp::default());
        http.push("update_two_bits", 200, b"");
        let d = dc(http.clone());
        d.update("t", AppleEnv::Production, false, true, 5).unwrap();
        let body: serde_json::Value = serde_json::from_slice(&http.seen.lock()[0].body).unwrap();
        assert_eq!((body["bit0"].as_bool(), body["bit1"].as_bool()), (Some(false), Some(true)));
    }
}
