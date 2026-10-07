//! Configuration (JSON). Hosts, URLs and secret paths are all configuration; secrets themselves live in
//! files on the oracle host, never in the repository, the image or another container's environment.

use serde::Deserialize;
use std::path::{Path, PathBuf};

use crate::gates::Gates;
use crate::limits::LimitParams;
use crate::messages::is_hex64;
use crate::types::Network;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    #[default]
    Primary,
    Standby,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientRole {
    /// One of the five genesis nodes: every lease operation.
    Genesis,
    /// The support operator: tickets and evidence for appeals.
    Support,
    /// The standby oracle: the replication log.
    Replica,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Client {
    pub name: String,
    pub role: ClientRole,
    /// SHA-256 of the client certificate (DER), lowercase hex.
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tls {
    pub cert: PathBuf,
    pub key: PathBuf,
    /// The private CA that issues the client certificates.
    pub client_ca: PathBuf,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Secrets {
    /// The oracle's ML-DSA-65 key file (`keygen`).
    pub oracle_key: PathBuf,
    /// 32 bytes that seal stored evidence (`evidence-key`).
    pub evidence_key: PathBuf,
    /// A file holding the alert webhook URL.
    #[serde(default)]
    pub alert_webhook: Option<PathBuf>,
}

fn d_dc() -> String {
    "https://api.devicecheck.apple.com".into()
}
fn d_dc_dev() -> String {
    "https://api.development.devicecheck.apple.com".into()
}
fn d_aa() -> String {
    "https://data.appattest.apple.com".into()
}
fn d_aa_dev() -> String {
    "https://data-development.appattest.apple.com".into()
}

/// The app's Team ID, bundle id and App ID come from `qnet-device-attest::app`, and so does the Apple
/// root that signs receipts: one source for the node and the oracle.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Apple {
    /// The `.p8` key with DeviceCheck enabled and its key id.
    pub key: PathBuf,
    pub key_id: String,
    #[serde(default = "d_dc")]
    pub devicecheck_url: String,
    #[serde(default = "d_dc_dev")]
    pub devicecheck_dev_url: String,
    #[serde(default = "d_aa")]
    pub attest_url: String,
    #[serde(default = "d_aa_dev")]
    pub attest_dev_url: String,
}

fn d_integrity() -> String {
    "https://playintegrity.googleapis.com".into()
}

/// The package and its signing-certificate digests come from `qnet-device-attest::app`.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Google {
    /// Developer-managed classic keys from the Play Console, each a base64 text file.
    pub decryption_key: PathBuf,
    pub verification_key: PathBuf,
    /// Service account JSON limited to the Play Integrity scope (device recall writes).
    #[serde(default)]
    pub service_account: Option<PathBuf>,
    #[serde(default = "d_integrity")]
    pub integrity_url: String,
}

fn d_crl() -> String {
    "https://android.googleapis.com/attestation/status".into()
}
fn d_chain() -> String {
    "1337".into()
}
fn d_log_days() -> u64 {
    7
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(deny_unknown_fields, default)]
pub struct LeaseConfig {
    /// Set once the device tests show vendor tokens are produced in background wakes (7 d + 3 d leases);
    /// otherwise 14 d + 7 d on every platform.
    pub background_tokens: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct AlertConfig {
    /// Executable called as `command <kind> <message> <host>`.
    pub command: Option<PathBuf>,
    pub min_interval_secs: u64,
}

impl Default for AlertConfig {
    fn default() -> Self {
        AlertConfig { command: None, min_interval_secs: 1800 }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct Quota {
    /// Play Integrity token decodes per day the project is granted; alert at half.
    pub play_daily: u64,
    /// Tokens per hour that fail their binding (wrong nonce, replay, wrong package) before the
    /// quota-burn alert.
    pub bad_tokens_hourly: u64,
}

impl Default for Quota {
    fn default() -> Self {
        Quota { play_daily: 10_000, bad_tokens_hourly: 100 }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct Server {
    pub workers: usize,
    pub queue: usize,
    pub max_body: usize,
}

impl Default for Server {
    fn default() -> Self {
        Server { workers: 32, queue: 256, max_body: 256 * 1024 }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Replica {
    /// `https://host:port` of the primary.
    pub primary_url: String,
    /// The standby's client certificate and key, and the CA of the primary's server certificate.
    pub cert: PathBuf,
    pub key: PathBuf,
    pub server_ca: PathBuf,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub network: Network,
    #[serde(default = "d_chain")]
    pub chain_id: String,
    #[serde(default)]
    pub role: Role,
    pub listen: String,
    pub data_dir: PathBuf,
    pub tls: Tls,
    pub clients: Vec<Client>,
    pub secrets: Secrets,
    #[serde(default)]
    pub apple: Option<Apple>,
    #[serde(default)]
    pub google: Option<Google>,
    #[serde(default = "d_crl")]
    pub crl_url: String,
    #[serde(default)]
    pub lease: LeaseConfig,
    #[serde(default)]
    pub gates: Gates,
    #[serde(default)]
    pub limits: LimitParams,
    #[serde(default)]
    pub alerts: AlertConfig,
    #[serde(default)]
    pub quota: Quota,
    #[serde(default)]
    pub server: Server,
    #[serde(default)]
    pub replica: Option<Replica>,
    #[serde(default = "d_log_days")]
    pub replica_log_days: u64,
}

fn norm_hex(s: &str) -> String {
    s.chars().filter(|c| *c != ':').collect::<String>().to_ascii_lowercase()
}

impl Config {
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
        let mut c: Config = serde_json::from_str(&text).map_err(|e| format!("config: {}", e))?;
        c.normalize();
        c.validate()?;
        Ok(c)
    }

    fn normalize(&mut self) {
        for cl in &mut self.clients {
            cl.sha256 = norm_hex(&cl.sha256);
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.chain_id.is_empty() || !self.chain_id.bytes().all(|b| b.is_ascii_digit()) {
            return Err("chain_id must be the decimal network id".into());
        }
        for cl in &self.clients {
            if !is_hex64(&cl.sha256) || cl.name.is_empty() {
                return Err(format!("client {:?}: sha256 must be 64 hex characters", cl.name));
            }
        }
        let genesis = self.clients.iter().filter(|c| c.role == ClientRole::Genesis).count();
        if genesis == 0 {
            return Err("at least one genesis client certificate must be listed".into());
        }
        let mut seen = std::collections::HashSet::new();
        if !self.clients.iter().all(|c| seen.insert(c.sha256.clone())) {
            return Err("a client certificate is listed twice".into());
        }
        if self.role == Role::Standby && self.replica.is_none() {
            return Err("a standby needs the replica section".into());
        }
        if self.apple.as_ref().map(|a| a.key_id.trim().is_empty()).unwrap_or(false) {
            return Err("apple.key_id must be set".into());
        }
        for url in self.urls() {
            if !url.starts_with("https://") {
                return Err(format!("{} must be https", url));
            }
        }
        if self.replica_log_days == 0 {
            return Err("replica_log_days must be at least 1".into());
        }
        Ok(())
    }

    fn urls(&self) -> Vec<&str> {
        let mut v = vec![self.crl_url.as_str()];
        if let Some(a) = &self.apple {
            v.extend([&a.devicecheck_url, &a.devicecheck_dev_url, &a.attest_url, &a.attest_dev_url].map(|s| s.as_str()));
        }
        if let Some(g) = &self.google {
            v.push(&g.integrity_url);
        }
        if let Some(r) = &self.replica {
            v.push(&r.primary_url);
        }
        v
    }
}


/// Reads a text file holding base64 (a Play Console key).
pub fn load_b64_file(path: &Path) -> Result<Vec<u8>, String> {
    let t = std::fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    crate::messages::b64_decode(&t).ok_or_else(|| format!("{} is not base64", path.display()))
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn sample_json() -> serde_json::Value {
        serde_json::json!({
            "network": "testnet",
            "listen": "0.0.0.0:8740",
            "data_dir": "/var/lib/qnet-oracle",
            "tls": {"cert": "/etc/qnet-oracle/tls/server.crt", "key": "/etc/qnet-oracle/tls/server.key",
                    "client_ca": "/etc/qnet-oracle/tls/ca.crt"},
            "clients": [{"name": "genesis-001", "role": "genesis", "sha256": "AB".repeat(32)}],
            "secrets": {"oracle_key": "/etc/qnet-oracle/secrets/oracle.key",
                        "evidence_key": "/etc/qnet-oracle/secrets/evidence.key"},
        })
    }

    #[test]
    fn defaults_and_normalisation() {
        let mut c: Config = serde_json::from_value(sample_json()).unwrap();
        c.normalize();
        c.validate().unwrap();
        assert_eq!(c.chain_id, "1337");
        assert_eq!(c.role, Role::Primary);
        assert_eq!(c.clients[0].sha256, "ab".repeat(32));
        assert!(!c.gates.enforce, "gates start log-only");
        assert!(!c.lease.background_tokens);
        assert_eq!(c.crl_url, "https://android.googleapis.com/attestation/status");
    }

    #[test]
    fn the_example_config_matches_the_schema() {
        let mut v: serde_json::Value = serde_json::from_str(include_str!("../oracle.example.json")).unwrap();
        for (i, c) in v["clients"].as_array_mut().unwrap().iter_mut().enumerate() {
            c["sha256"] = serde_json::json!(format!("{:02x}", i).repeat(32));
        }
        let mut c: Config = serde_json::from_value(v).unwrap();
        c.normalize();
        c.validate().unwrap();
        assert_eq!(c.apple.as_ref().unwrap().devicecheck_url, "https://api.devicecheck.apple.com");
        assert_eq!(c.google.as_ref().unwrap().integrity_url, "https://playintegrity.googleapis.com");
    }

    #[test]
    fn unknown_fields_and_bad_values_are_refused() {
        let mut j = sample_json();
        j["surprise"] = serde_json::json!(1);
        assert!(serde_json::from_value::<Config>(j).is_err());
        let mut j = sample_json();
        j["role"] = serde_json::json!("standby");
        let c: Config = serde_json::from_value(j).unwrap();
        assert!(c.validate().is_err(), "a standby needs its primary");
        let mut j = sample_json();
        j["apple"] = serde_json::json!({"key": "/k.p8", "key_id": " "});
        let c: Config = serde_json::from_value(j).unwrap();
        assert!(c.validate().is_err(), "the DeviceCheck key id is required");
        let mut j = sample_json();
        j["crl_url"] = serde_json::json!("http://plain");
        let c: Config = serde_json::from_value(j).unwrap();
        assert!(c.validate().is_err());
    }
}
