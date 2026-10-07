//! The warm standby: follows the primary's replication log over mutual TLS and copies the whole database
//! when it is new or fell behind the log's retention. It serves no lease operations until promoted.

use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

use crate::alerts::Alerts;
use crate::config::Replica;
use crate::messages::b64_decode;
use crate::store::{Cf, LogEntry, Store, SCHEMA};

const PAGE: usize = 500;
/// Lag behind the primary that raises an alert.
const LAG_ALERT_SECS: u64 = 300;

pub struct Follower {
    primary: String,
    client: reqwest::blocking::Client,
    store: Arc<Store>,
    alerts: Arc<Alerts>,
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Records of another layout are never copied in: the primary and this standby read one schema.
fn check_schema(v: &Value) -> Result<(), String> {
    match v["schema"].as_u64() {
        Some(s) if s == SCHEMA as u64 => Ok(()),
        other => Err(format!("primary schema {:?} but this standby reads schema {}", other, SCHEMA)),
    }
}

impl Follower {
    pub fn new(cfg: &Replica, store: Arc<Store>, alerts: Arc<Alerts>) -> Result<Self, String> {
        let mut identity = std::fs::read(&cfg.cert).map_err(|e| format!("read {}: {}", cfg.cert.display(), e))?;
        identity.extend(std::fs::read(&cfg.key).map_err(|e| format!("read {}: {}", cfg.key.display(), e))?);
        let identity = reqwest::Identity::from_pem(&identity).map_err(|e| format!("standby identity: {}", e))?;
        let ca = std::fs::read(&cfg.server_ca).map_err(|e| format!("read {}: {}", cfg.server_ca.display(), e))?;
        let ca = reqwest::Certificate::from_pem(&ca).map_err(|e| format!("primary CA: {}", e))?;
        let client = reqwest::blocking::Client::builder()
            .use_rustls_tls()
            .tls_built_in_root_certs(false)
            .add_root_certificate(ca)
            .identity(identity)
            .https_only(true)
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Follower { primary: cfg.primary_url.trim_end_matches('/').to_string(), client, store, alerts })
    }

    fn get(&self, path: &str) -> Result<(u16, Value), String> {
        let r = self.client.get(format!("{}{}", self.primary, path)).send().map_err(|e| e.without_url().to_string())?;
        let status = r.status().as_u16();
        let body = r.bytes().map_err(|e| e.without_url().to_string())?;
        Ok((status, serde_json::from_slice(&body).unwrap_or(Value::Null)))
    }

    /// Copies every data family page by page, then continues from the primary's sequence at the start.
    fn full_sync(&self) -> Result<(), String> {
        let (_, status) = self.get("/v1/replica/status")?;
        check_schema(&status)?;
        let seq = status["seq"].as_u64().ok_or("primary status without seq")?;
        self.store.wipe()?;
        for cf in Cf::ALL {
            let mut after = String::new();
            loop {
                let (s, v) = self.get(&format!("/v1/replica/dump?cf={}&after={}&limit={}", cf.name(), after, PAGE))?;
                if s != 200 {
                    return Err(format!("dump status={}", s));
                }
                let page: Vec<(Vec<u8>, Vec<u8>)> = bincode::deserialize(
                    &b64_decode(v["page"].as_str().unwrap_or("")).ok_or("dump page is not base64")?,
                )
                .map_err(|e| e.to_string())?;
                if page.is_empty() {
                    break;
                }
                self.store.put_snapshot_page(cf, &page)?;
                after = v["last"].as_str().unwrap_or("").to_string();
            }
        }
        self.store.finish_sync(seq)?;
        if crate::log::is_warn() {
            println!("[WARN][REPLICA] full_sync_done seq={}", seq);
        }
        Ok(())
    }

    /// One round: returns whether more entries are waiting.
    fn step(&self) -> Result<bool, String> {
        if !self.store.synced()? {
            self.full_sync()?;
        }
        let (s, v) = self.get(&format!("/v1/replica/log?after={}&limit={}", self.store.seq(), PAGE))?;
        if s == 409 {
            // The primary trimmed entries this standby still needs.
            self.full_sync()?;
            return Ok(true);
        }
        if s != 200 {
            return Err(format!("log status={}", s));
        }
        check_schema(&v)?;
        let entries: Vec<LogEntry> =
            bincode::deserialize(&b64_decode(v["entries"].as_str().unwrap_or("")).ok_or("log page is not base64")?)
                .map_err(|e| e.to_string())?;
        for e in &entries {
            self.store.apply_replica(e)?;
        }
        Ok(entries.len() == PAGE)
    }

    pub fn run(self) {
        let mut behind_since: Option<u64> = None;
        loop {
            match self.step() {
                Ok(true) => continue,
                Ok(false) => behind_since = None,
                Err(e) => {
                    let now = unix_now();
                    let since = *behind_since.get_or_insert(now);
                    if crate::log::is_warn() {
                        println!("[WARN][REPLICA] follow_failed err={}", e);
                    }
                    if now >= since + LAG_ALERT_SECS {
                        self.alerts.raise("standby_behind", &format!("secs={} err={}", now - since, e), now);
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_primary_of_another_schema_is_not_followed() {
        assert!(check_schema(&serde_json::json!({"seq": 4, "schema": SCHEMA})).is_ok());
        assert!(check_schema(&serde_json::json!({"seq": 4, "schema": SCHEMA + 1})).is_err());
        assert!(check_schema(&serde_json::json!({"seq": 4})).is_err(), "a primary that states no schema");
    }
}
