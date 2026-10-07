//! Startup: loads the configuration and secret files, builds the service and runs the server, the
//! revocation-list fetcher, maintenance and, on a standby, the replication follower.

use std::net::TcpListener;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use crate::alerts::Alerts;
use crate::config::{load_b64_file, Config, Role};
use crate::evidence::Sealer;
use crate::lease::Params;
use crate::replica::Follower;
use crate::server::{tls_config, Server};
use crate::service::{Oracle, Settings, Vendors};
use crate::signer::Signer;
use crate::store::Store;
use crate::types::Network;
use crate::upstream::appattest::{AppAttestData, AppleReceipts};
use crate::upstream::devicecheck::DeviceCheck;
use crate::upstream::jwt::{Es256Jwt, ServiceAccount};
use crate::upstream::playintegrity::PlayIntegrity;
use crate::upstream::{HttpClient, ReqwestHttp};
use qnet_device_attest::app;
use qnet_device_attest::play::PlayPolicy;

const MAINTENANCE_EVERY: Duration = Duration::from_secs(600);

/// Secret files must be readable by the oracle user only; on mainnet anything looser stops the start.
fn check_secret(path: &Path, network: Network) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path).map_err(|e| format!("{}: {}", path.display(), e))?.permissions().mode();
        if mode & 0o077 != 0 {
            let msg = format!("{} is readable by others (mode {:o}); expected 0400", path.display(), mode & 0o777);
            if network == Network::Mainnet {
                return Err(msg);
            }
            if crate::log::is_warn() {
                println!("[WARN][BOOT] {}", msg);
            }
        }
    }
    let _ = (path, network);
    Ok(())
}

/// One maintenance pass. A standby only trims its log: a purge it committed itself would take a sequence
/// number the primary's next entry needs, and the primary's own purges reach it through that log.
fn maintenance(o: &Oracle, role: Role) {
    match role {
        Role::Primary => o.maintain(),
        Role::Standby => o.trim_replication_log(),
    }
}

fn read_secret(path: &Path, network: Network) -> Result<Vec<u8>, String> {
    check_secret(path, network)?;
    std::fs::read(path).map_err(|e| format!("read {}: {}", path.display(), e))
}

/// The private keys of the oracle's connections, beside the service secrets `build_oracle` loads: the TLS
/// server key (whoever reads it can stand in for the oracle before the genesis nodes and receive the
/// vendor tokens they forward) and a standby's replication client key (it fetches the whole database).
fn transport_secrets(cfg: &Config) -> Vec<&Path> {
    let mut v = vec![cfg.tls.key.as_path()];
    if let (Role::Standby, Some(r)) = (cfg.role, &cfg.replica) {
        v.push(r.key.as_path());
    }
    v
}

pub fn build_oracle(cfg: &Config) -> Result<Oracle, String> {
    let net = cfg.network;
    let http: Arc<dyn HttpClient> = Arc::new(ReqwestHttp::new(Duration::from_secs(10))?);
    check_secret(&cfg.secrets.oracle_key, net)?;
    let signer = Signer::load(&cfg.secrets.oracle_key)?;
    let sealer = Sealer::from_bytes(&read_secret(&cfg.secrets.evidence_key, net)?)?;
    std::fs::create_dir_all(&cfg.data_dir).map_err(|e| format!("{}: {}", cfg.data_dir.display(), e))?;
    let store = Arc::new(Store::open(&cfg.data_dir.join("db"))?);

    let (devicecheck, appattest) = match &cfg.apple {
        Some(a) => {
            let pem = String::from_utf8(read_secret(&a.key, net)?).map_err(|_| "the Apple key is not text")?;
            let jwt = Arc::new(Es256Jwt::from_p8(&pem, &a.key_id, app::IOS_TEAM_ID)?);
            (
                Some(DeviceCheck::new(http.clone(), jwt.clone(), &a.devicecheck_url, &a.devicecheck_dev_url)),
                Some(AppAttestData::new(
                    http.clone(),
                    jwt,
                    &a.attest_url,
                    &a.attest_dev_url,
                    app::IOS_APP_ID,
                    Arc::new(AppleReceipts),
                )),
            )
        }
        None => (None, None),
    };
    let play = match &cfg.google {
        Some(g) => {
            check_secret(&g.decryption_key, net)?;
            let account = match &g.service_account {
                Some(p) => Some(ServiceAccount::from_json(
                    &String::from_utf8(read_secret(p, net)?).map_err(|_| "service account file is not text")?,
                )?),
                None => None,
            };
            let policy = match net {
                Network::Mainnet => PlayPolicy::mainnet(),
                Network::Testnet => PlayPolicy::testnet(),
            };
            Some(PlayIntegrity::new(
                http.clone(),
                load_b64_file(&g.decryption_key)?,
                &load_b64_file(&g.verification_key)?,
                policy,
                &g.integrity_url,
                account,
            )?)
        }
        None => None,
    };
    let webhook = match &cfg.secrets.alert_webhook {
        Some(p) => Some(String::from_utf8_lossy(&read_secret(p, net)?).trim().to_string()),
        None => None,
    };
    let host = std::env::var("HOSTNAME").unwrap_or_else(|_| "oracle".into());
    let alerts = Arc::new(Alerts::new(cfg.alerts.command.clone(), webhook, Some(http.clone()), cfg.alerts.min_interval_secs, host));
    let settings = Settings {
        network: net,
        chain_id: cfg.chain_id.clone(),
        quota: cfg.quota.clone(),
        crl_url: cfg.crl_url.clone(),
        log_keep: cfg.replica_log_days * 86_400,
    };
    Ok(Oracle::new(
        settings,
        Params::new(cfg.lease.background_tokens),
        cfg.gates.clone(),
        cfg.limits.clone(),
        store,
        signer,
        sealer,
        Vendors { devicecheck, appattest, play, http },
        alerts,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_from_a_config_and_its_secret_files() {
        let d = tempfile::tempdir().unwrap();
        let p = |f: &str| d.path().join(f);
        Signer::generate().save_new(&p("oracle.key")).unwrap();
        std::fs::write(p("evidence.key"), [5u8; 32]).unwrap();
        let tm = crate::upstream::playintegrity::tests::TokenMaker::new();
        std::fs::write(p("play_decryption.key"), crate::messages::b64_encode(&tm.decrypt_key)).unwrap();
        std::fs::write(p("play_verification.key"), crate::messages::b64_encode(&tm.spki)).unwrap();
        let mut v = crate::config::tests::sample_json();
        v["data_dir"] = serde_json::json!(p("data"));
        v["secrets"] = serde_json::json!({"oracle_key": p("oracle.key"), "evidence_key": p("evidence.key")});
        v["google"] = serde_json::json!({"decryption_key": p("play_decryption.key"), "verification_key": p("play_verification.key")});
        let cfg: Config = serde_json::from_value(v).unwrap();
        let o = build_oracle(&cfg).unwrap();
        assert!(o.vendors.play.is_some() && o.vendors.devicecheck.is_none());
        assert_eq!(o.vendors.play.as_ref().unwrap().policy.package, app::ANDROID_PACKAGE);
        assert!(o.vendors.play.as_ref().unwrap().policy.allow_test, "testnet accepts our own test builds");
        drop(o);
        let mut bad = cfg.clone();
        bad.secrets.evidence_key = p("missing.key");
        assert!(build_oracle(&bad).is_err());
    }

    #[test]
    fn the_tls_key_and_a_standbys_replica_key_are_checked_as_secrets() {
        let mut v = crate::config::tests::sample_json();
        v["role"] = serde_json::json!("standby");
        v["replica"] = serde_json::json!({"primary_url": "https://10.0.0.1:8740", "cert": "/etc/qnet-oracle/tls/replica.crt",
                                         "key": "/etc/qnet-oracle/tls/replica.key", "server_ca": "/etc/qnet-oracle/tls/ca.crt"});
        let cfg: Config = serde_json::from_value(v).unwrap();
        let paths = transport_secrets(&cfg);
        assert!(paths.contains(&Path::new("/etc/qnet-oracle/tls/server.key")));
        assert!(paths.contains(&Path::new("/etc/qnet-oracle/tls/replica.key")));
        let mut primary = cfg.clone();
        primary.role = Role::Primary;
        assert_eq!(transport_secrets(&primary), vec![Path::new("/etc/qnet-oracle/tls/server.key")]);
    }

    #[test]
    fn a_standby_trims_its_replicated_log_and_commits_nothing_of_its_own() {
        use crate::store::{Cf, LogEntry, WriteOp};
        use crate::testkit::{Opts, H, T0};
        const DAY: u64 = 86_400;
        let h = H::new(Opts::default());
        let s = &h.o.store;
        s.finish_sync(0).unwrap();
        // The primary's entries: two older than the 7-day window, one inside it; the second carries an
        // expired replay entry that only the primary's purge may delete.
        let expired = h.now() - 1;
        let entries = [
            LogEntry { seq: 1, ts: T0 - 9 * DAY, ops: vec![WriteOp::Put(Cf::Lease, b"n1".to_vec(), vec![1])] },
            LogEntry {
                seq: 2,
                ts: T0 - 8 * DAY,
                ops: vec![
                    WriteOp::Put(Cf::Replay, b"tok".to_vec(), bincode::serialize(&expired).unwrap()),
                    WriteOp::Put(Cf::ReplayExp, [&expired.to_be_bytes()[..], b"tok"].concat(), vec![]),
                ],
            },
            LogEntry { seq: 3, ts: T0 - DAY, ops: vec![WriteOp::Put(Cf::Lease, b"n2".to_vec(), vec![2])] },
        ];
        for e in &entries {
            s.apply_replica(e).unwrap();
        }
        maintenance(&h.o, Role::Standby);
        assert_eq!(s.first_log_seq(), Some(3), "entries older than the window are trimmed");
        assert_eq!(s.seq(), 3, "the standby commits nothing of its own");
        assert!(s.get_raw(Cf::Replay, b"tok").unwrap().is_some(), "the purge is the primary's");
        s.apply_replica(&LogEntry { seq: 4, ts: T0, ops: vec![WriteOp::Del(Cf::Replay, b"tok".to_vec())] }).unwrap();
        assert!(s.get_raw(Cf::Replay, b"tok").unwrap().is_none());

        // Promoted, the same database trims as a primary does, after its own purges.
        h.at(T0 + 8 * DAY);
        maintenance(&h.o, Role::Primary);
        assert_eq!(s.first_log_seq(), Some(s.seq()), "only the newest entry is kept");
    }

    #[cfg(unix)]
    #[test]
    fn a_readable_tls_key_stops_a_mainnet_start() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let key = d.path().join("server.key");
        std::fs::write(&key, b"key").unwrap();
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(check_secret(&key, Network::Mainnet).is_err());
        assert!(check_secret(&key, Network::Testnet).is_ok(), "testnet warns only");
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o400)).unwrap();
        assert!(check_secret(&key, Network::Mainnet).is_ok());
    }
}

pub fn run(cfg: Config) -> Result<(), String> {
    for p in transport_secrets(&cfg) {
        check_secret(p, cfg.network)?;
    }
    let oracle = Arc::new(build_oracle(&cfg)?);
    let tls = tls_config(&cfg.tls.cert, &cfg.tls.key, &cfg.tls.client_ca)?;
    let listener = TcpListener::bind(&cfg.listen).map_err(|e| format!("listen {}: {}", cfg.listen, e))?;
    match cfg.role {
        Role::Primary => {
            // A promoted standby serves only a complete copy; a new primary starts on an empty database.
            oracle.store.claim_primary()?;
            let o = oracle.clone();
            std::thread::spawn(move || loop {
                let next = o.refresh_crl();
                std::thread::sleep(Duration::from_secs(next));
            });
        }
        Role::Standby => {
            let r = cfg.replica.as_ref().ok_or("a standby needs the replica section")?;
            let follower = Follower::new(r, oracle.store.clone(), oracle.alerts.clone())?;
            std::thread::spawn(move || follower.run());
        }
    }
    let (o, role) = (oracle.clone(), cfg.role);
    std::thread::spawn(move || loop {
        maintenance(&o, role);
        std::thread::sleep(MAINTENANCE_EVERY);
    });
    if crate::log::is_warn() {
        println!(
            "[WARN][BOOT] started role={:?} network={:?} listen={} oracle_key_sha3={}",
            cfg.role,
            cfg.network,
            cfg.listen,
            hex::encode(crate::messages::sha3_256(oracle.signer.public_key()))
        );
    }
    let server = Arc::new(Server::new(oracle, tls, &cfg.clients, cfg.role, cfg.server.max_body));
    server.run(listener, cfg.server.workers, cfg.server.queue);
    Ok(())
}
