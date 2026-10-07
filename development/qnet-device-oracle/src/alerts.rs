//! Operator alerts: a local command and/or a webhook, at most once per kind per interval. Alert texts
//! carry counts and service names only, never a token, a node's evidence or an address.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::upstream::{HttpClient, HttpRequest, Method};

pub struct Alerts {
    command: Option<PathBuf>,
    webhook: Option<String>,
    http: Option<Arc<dyn HttpClient>>,
    min_interval: u64,
    host: String,
    last: Mutex<HashMap<String, u64>>,
    /// Every raised alert, for tests and the health view.
    pub raised: Mutex<Vec<(u64, String)>>,
}

impl Alerts {
    pub fn new(
        command: Option<PathBuf>,
        webhook: Option<String>,
        http: Option<Arc<dyn HttpClient>>,
        min_interval: u64,
        host: String,
    ) -> Self {
        Alerts { command, webhook, http, min_interval, host, last: Mutex::new(HashMap::new()), raised: Mutex::new(Vec::new()) }
    }

    /// Raises `kind` unless it was raised within the interval; returns whether it went out.
    pub fn raise(&self, kind: &str, message: &str, now: u64) -> bool {
        {
            let mut last = self.last.lock();
            if let Some(&t) = last.get(kind) {
                if now < t + self.min_interval {
                    return false;
                }
            }
            last.insert(kind.to_string(), now);
        }
        if crate::log::is_warn() {
            println!("[WARN][ALERT] {} {}", kind, message);
        }
        {
            let mut r = self.raised.lock();
            r.push((now, kind.to_string()));
            let excess = r.len().saturating_sub(200);
            r.drain(..excess);
        }
        let (cmd, hook, http) = (self.command.clone(), self.webhook.clone(), self.http.clone());
        let (kind, message, host) = (kind.to_string(), message.to_string(), self.host.clone());
        if cmd.is_none() && hook.is_none() {
            return true;
        }
        std::thread::spawn(move || {
            if let Some(cmd) = cmd {
                run_command(&cmd, &kind, &message, &host);
            }
            if let (Some(url), Some(http)) = (hook, http) {
                let body = serde_json::json!({"kind": kind, "message": message, "host": host, "ts": now});
                let req = HttpRequest {
                    method: Method::Post,
                    url,
                    headers: vec![("content-type", "application/json".into())],
                    body: body.to_string().into_bytes(),
                };
                if let Err(e) = http.send(&req) {
                    if crate::log::is_warn() {
                        println!("[WARN][ALERT] webhook_failed err={}", e);
                    }
                }
            }
        });
        true
    }
}

fn run_command(cmd: &PathBuf, kind: &str, message: &str, host: &str) {
    let child = Command::new(cmd)
        .arg(kind)
        .arg(message)
        .arg(host)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        if crate::log::is_warn() {
            println!("[WARN][ALERT] command_failed_to_start");
        }
        return;
    };
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if start.elapsed() < Duration::from_secs(15) => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                if crate::log::is_warn() {
                    println!("[WARN][ALERT] command_timed_out");
                }
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_kind_is_rate_limited_on_its_own() {
        let a = Alerts::new(None, None, None, 1800, "h".into());
        assert!(a.raise("vendor_outage", "devicecheck", 1000));
        assert!(!a.raise("vendor_outage", "devicecheck", 1500));
        assert!(a.raise("quota_burn", "x", 1500));
        assert!(a.raise("vendor_outage", "devicecheck", 2800));
        assert_eq!(a.raised.lock().len(), 3);
    }
}
