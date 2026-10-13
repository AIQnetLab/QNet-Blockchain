//! The super node's public RPC side (N2): its public IPv4, the 443 probe, the certificate schedule,
//! the ServeCert, and the automatic commit of its wallet-plane endpoint through the existing
//! NodeReactivation transaction (a valid transaction under today's rules whose apply touches only the
//! endpoint rows). Super nodes only, never a genesis identity, never with QNET_HIDE_IP.
//!
//! Every value from another node here is a hint: an address is acted on only when two genesis
//! answers agree, and issuance by the CA is the actual proof that 443 reaches this node. Genesis
//! being down or busy never takes an address, a serving certificate, its renewal or the lapse rule
//! away: only a new agreement moves the address, and only new endpoint commits wait for one.

use super::*;
use crate::rpc::acme::{self, CertManager, Step};
use crate::rpc::node_serve::{self, ServeStatus, ServingKey, SignedServeCert};
use crate::rpc::wallet_plane::{self, WALLET_CERTS};
use once_cell::sync::Lazy;
use rand::Rng;
use serde_json::Value;
use std::net::{IpAddr, Ipv4Addr};

const TICK: Duration = Duration::from_secs(30);
/// The public address is re-evaluated about this often (plus or minus a quarter, drawn each time, so
/// a fleet restarted together drifts apart instead of asking genesis in step).
const IP_REFRESH_SECS: u64 = 30 * 60;
/// A genesis agreement licenses a serving commit for this long: one refresh that finds genesis busy
/// does not hold a commit back, a stale view of the egress does.
const AGREEMENT_FRESH_SECS: u64 = 3 * IP_REFRESH_SECS;
/// At most one automatic commit per node per this many macroblocks.
pub(crate) const COMMIT_EVERY_MACROBLOCKS: u64 = 100;
/// A committed `https://X` with no valid certificate for this long goes back to `http://X:8001`.
pub(crate) const LAPSE_SECS: u64 = 48 * 3600;
/// A probe certificate stays armed this long: up to five genesis nodes, each asked by address and by
/// name (at most ~15 s with the name's own plain retry), each with a connect-back of at most 2 s.
const PROBE_ARM_TTL: Duration = Duration::from_secs(120);
const COMMIT_FILE: &str = "endpoint_commit.json";

/// The resolved public address, shared with the endpoint resolver (`self_public_api_endpoint`).
#[derive(Debug, Clone, Default)]
pub(crate) struct PublicAddress {
    /// The address the node acts on: the configured one, else the last one two genesis nodes agreed
    /// on (or, before any answer, the one its valid certificate names). Sticky: no or too few answers
    /// keep it; only two answers agreeing on another address move it.
    pub(crate) ip: Option<Ipv4Addr>,
    /// The address two genesis whoami answers last agreed on, and when: a serving commit needs it
    /// equal to `ip` and fresh (`AGREEMENT_FRESH_SECS`).
    pub(crate) genesis_agreed: Option<Ipv4Addr>,
    pub(crate) agreed_at: u64,
}

impl PublicAddress {
    /// The agreement, while it is fresh enough to commit on.
    pub(crate) fn fresh_agreement(&self, now: u64) -> Option<Ipv4Addr> {
        self.genesis_agreed.filter(|_| now < self.agreed_at.saturating_add(AGREEMENT_FRESH_SECS))
    }
}

pub(crate) static PUBLIC_ADDRESS: Lazy<parking_lot::RwLock<PublicAddress>> = Lazy::new(|| parking_lot::RwLock::new(PublicAddress::default()));

/// `secs` plus or minus a quarter, uniformly.
fn jittered(secs: u64) -> u64 {
    rand::thread_rng().gen_range(secs - secs / 4..=secs + secs / 4)
}

/// The operator's configured address (QNET_PUBLIC_IP, else EXTERNAL_IP, else HOST_IP), as written.
pub(crate) fn configured_public_ip() -> Option<String> {
    ["QNET_PUBLIC_IP", "EXTERNAL_IP", "HOST_IP"].iter()
        .find_map(|v| std::env::var(v).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
}

/// `https://X` while this node serves the wallet plane: a valid certificate for X is installed and X
/// is its resolved public address.
pub(crate) fn serving_endpoint(now: u64) -> Option<String> {
    let ip = PUBLIC_ADDRESS.read().ip?;
    (WALLET_CERTS.valid_ip(now) == Some(ip)).then(|| format!("https://{}", ip))
}

/// Why an address cannot be the node's public endpoint, or None when it can: a public unicast IPv4
/// that today's on-chain validator also accepts as `https://X`.
pub(crate) fn unusable_reason(ip: Ipv4Addr) -> Option<&'static str> {
    if !node_serve::is_public_unicast_v4(ip) {
        return Some("not_public_unicast");
    }
    if qnet_state::transaction::validate_public_api_endpoint(&format!("https://{}", ip)).is_err() {
        // The validator matches private ranges by substring (a gated fix): such an address stays
        // undiscoverable until then rather than commit a value every block would refuse.
        return Some("refused_by_validator");
    }
    None
}

// ─── Genesis whoami ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Whoami {
    pub(crate) ip: IpAddr,
    /// The 443 probe's result; None when no probe was made.
    pub(crate) tls443: Option<bool>,
    /// The genesis declined to probe because it was reached through a door that hides this node's
    /// address (`"probe": "caller_not_socket"`), as opposed to an older binary that probes nothing.
    pub(crate) probe_refused: bool,
}

fn parse_whoami(v: &Value) -> Option<Whoami> {
    let ip: IpAddr = v["ip"].as_str()?.parse().ok()?;
    Some(Whoami { ip, tls443: v["tls443"].as_bool(), probe_refused: v["probe"].as_str() == Some("caller_not_socket") })
}

fn plain_client() -> &'static reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(5)).connect_timeout(Duration::from_secs(3)).build().unwrap_or_default())
}

fn is_public_v4(ip: IpAddr) -> bool {
    matches!(ip, IpAddr::V4(v4) if node_serve::is_public_unicast_v4(v4))
}

/// How a genesis node is reached: its HTTPS name (through its terminator) or its plain port by address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Door {
    Name,
    Address,
}

/// One door's reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DoorReply {
    Answer(Whoami),
    /// Busy (429, 5xx), unreachable, timed out or garbled: no verdict from it this time.
    Busy,
    /// Any other refusal (404 from a binary without the route): this genesis has nothing to say.
    Unsupported,
}

/// A whoami reply by its HTTP status and body.
pub(crate) fn door_reply(status: u16, body: Option<&Value>) -> DoorReply {
    match status {
        200..=299 => body.and_then(parse_whoami).map_or(DoorReply::Busy, DoorReply::Answer),
        429 | 500..=599 => DoorReply::Busy,
        _ => DoorReply::Unsupported,
    }
}

async fn ask_door(door: Door, genesis_ip: &str, path: &str) -> DoorReply {
    let sent = match door {
        Door::Name => crate::rpc::genesis_internal_call(genesis_ip, path, |c, url| c.get(url)).await,
        Door::Address => plain_client().get(format!("http://{}:8001{}", genesis_ip, path)).send().await,
    };
    let Ok(r) = sent else { return DoorReply::Busy };
    let status = r.status().as_u16();
    let body = if r.status().is_success() { r.json::<Value>().await.ok() } else { None };
    door_reply(status, body.as_ref())
}

/// One genesis node's say: its view of this node's public address (only a public IPv4 counts: any
/// other is that genesis's own proxy), and whether it gave no probe verdict while one was asked.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct GenesisSay {
    pub(crate) answer: Option<Whoami>,
    pub(crate) busy: bool,
}

/// Whether a reply ends a genesis node's say: a public address with a verdict, without a probe asked,
/// or from an older binary that probes nothing. A refusal to probe from that door asks the other one.
fn final_reply(probe: bool, reply: &DoorReply) -> bool {
    matches!(reply, DoorReply::Answer(w) if is_public_v4(w.ip) && !(probe && w.tls443.is_none() && w.probe_refused))
}

/// Fold one genesis node's door replies, in the order asked, into its say.
pub(crate) fn genesis_say(probe: bool, replies: impl IntoIterator<Item = DoorReply>) -> GenesisSay {
    let mut say = GenesisSay::default();
    for reply in replies {
        let last = final_reply(probe, &reply);
        match reply {
            DoorReply::Answer(w) if is_public_v4(w.ip) => {
                // Without a verdict its view of the address still counts.
                say = GenesisSay { answer: Some(w), busy: !last };
                if last {
                    return say;
                }
            }
            DoorReply::Answer(_) | DoorReply::Busy => say.busy = true,
            DoorReply::Unsupported => {}
        }
    }
    say
}

/// One genesis whoami. The address is asked over the name first (TLS) and by address when the name's
/// terminator hides the caller. A probe asks the plain port first: a node connects back only to the
/// address its own socket gave it, which behind the terminator it does not have.
async fn genesis_whoami(genesis_ip: &str, marker: Option<&str>) -> GenesisSay {
    let path = match marker {
        Some(m) => format!("/api/v1/whoami?probe=443&marker={}", m),
        None => "/api/v1/whoami".to_string(),
    };
    let doors = if marker.is_some() { [Door::Address, Door::Name] } else { [Door::Name, Door::Address] };
    let mut replies = Vec::with_capacity(2);
    for door in doors {
        let reply = ask_door(door, genesis_ip, &path).await;
        let last = final_reply(marker.is_some(), &reply);
        replies.push(reply);
        if last {
            break;
        }
    }
    genesis_say(marker.is_some(), replies)
}

/// One round of genesis answers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Round {
    pub(crate) answers: Vec<Whoami>,
    /// Genesis nodes that gave no verdict (busy, rate-limited, unreachable, or not able to probe).
    pub(crate) busy: usize,
}

impl Round {
    /// Enough said: two answers agree on an address and, for a probe, one saw this process on 443 or
    /// two saw it not.
    pub(crate) fn settled(&self, probe: bool) -> bool {
        agreed_ipv4(&self.answers).is_some()
            && (!probe
                || self.answers.iter().any(|a| a.tls443 == Some(true))
                || self.answers.iter().filter(|a| a.tls443.is_some()).count() >= 2)
    }
}

/// All five genesis nodes, in random order, until the round is settled: a busy or absent genesis is
/// replaced by the next instead of failing the round.
async fn genesis_answers(marker: Option<&str>) -> Round {
    use rand::seq::SliceRandom;
    let mut ips: Vec<&str> = crate::genesis_constants::GENESIS_NODE_IPS.iter().map(|(ip, _)| *ip).collect();
    ips.shuffle(&mut rand::thread_rng());
    let mut round = Round::default();
    for ip in ips {
        let say = genesis_whoami(ip, marker).await;
        round.busy += say.busy as usize;
        round.answers.extend(say.answer);
        if round.settled(marker.is_some()) {
            break;
        }
    }
    round
}

/// The IPv4 two answers agree on.
pub(crate) fn agreed_ipv4(answers: &[Whoami]) -> Option<Ipv4Addr> {
    answers.iter().enumerate().find_map(|(i, a)| match a.ip {
        IpAddr::V4(v4) if answers[i + 1..].iter().any(|b| b.ip == a.ip) => Some(v4),
        _ => None,
    })
}

/// The public address from the configuration, the genesis answers and the address held so far.
/// Ok(ip, agreed) or Err(reason). Without a configured address, an agreement sets it; without one the
/// held address stays (genesis down or busy is no reason to stop serving), and with neither there is
/// none.
pub(crate) fn resolve_public_ip(configured: Option<&str>, answers: &[Whoami], held: Option<Ipv4Addr>) -> Result<(Ipv4Addr, Option<Ipv4Addr>), String> {
    let agreed = agreed_ipv4(answers);
    let ip = match configured {
        Some(c) => {
            let ip: Ipv4Addr = c.parse().map_err(|_| "configured_not_ipv4".to_string())?;
            if let Some(seen) = agreed.filter(|a| *a != ip) {
                if is_warn() {
                    println!("[WARN][WALLETRPC] public_ip_env_differs env={} seen={}", ip, seen);
                }
            }
            ip
        }
        None => agreed.or(held).ok_or_else(|| "no_genesis_agreement".to_string())?,
    };
    if let Some(reason) = unusable_reason(ip) {
        return Err(reason.to_string());
    }
    Ok((ip, agreed))
}

/// The 443 probe's verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Probe {
    /// A genesis saw this process's marker on host 443 at `ip`.
    Reachable,
    /// Genesis probed and 443 at `ip` is not this process.
    Unreachable,
    /// No genesis gave a verdict because each was busy, rate-limited, unreachable or unable to probe
    /// from the door it was reached by: ask again in minutes.
    Busy,
    /// Every genesis that answered runs a binary without the probe.
    NoAnswer,
}

pub(crate) fn probe_verdict(ip: Ipv4Addr, round: &Round) -> Probe {
    let with_probe: Vec<&Whoami> = round.answers.iter().filter(|a| a.tls443.is_some()).collect();
    if with_probe.iter().any(|a| a.ip == IpAddr::V4(ip) && a.tls443 == Some(true)) {
        Probe::Reachable
    } else if !with_probe.is_empty() {
        Probe::Unreachable
    } else if round.busy > 0 {
        Probe::Busy
    } else {
        Probe::NoAnswer
    }
}

/// Probe host 443 through genesis with a fresh marker armed on the plane. Err: the marker could not be
/// armed, so no probe was asked for.
async fn probe_443(ip: Ipv4Addr) -> Result<(Probe, Round), String> {
    let marker = hex::encode(rand::random::<[u8; 16]>());
    WALLET_CERTS.arm_probe(&marker, PROBE_ARM_TTL)?;
    let round = genesis_answers(Some(&marker)).await;
    WALLET_CERTS.disarm_probe(&marker);
    Ok((probe_verdict(ip, &round), round))
}

// ─── Endpoint commit ────────────────────────────────────────────────────────────────────────────

/// Everything the commit rule looks at.
#[derive(Debug, Clone)]
pub(crate) struct CommitInputs {
    /// This node's committed endpoint (its persisted `nep_` row).
    pub(crate) committed: Option<String>,
    pub(crate) ip: Ipv4Addr,
    /// A valid certificate for `ip` is installed: issuance proved 443 reaches this node at `ip`.
    pub(crate) cert_valid_for_ip: bool,
    /// Two genesis answers recently equal this: the TCP egress the peer IP gate will see.
    pub(crate) genesis_agreed: Option<Ipv4Addr>,
    pub(crate) registered: bool,
    /// The latest `not_after` of any certificate this node held (0: none).
    pub(crate) last_valid_until: u64,
    /// The certificate schedule has had its say since this process started: an order ran, a probe
    /// found 443 unreachable, or the persisted backoff shows the last attempts failed. Until then a
    /// node restarted long after its certificate expired is not lapsed: it may serve within minutes.
    pub(crate) issuance_tried: bool,
    pub(crate) now: u64,
    pub(crate) macroblock: u64,
    pub(crate) last_commit_macroblock: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CommitReason {
    Serving,
    Lapsed,
}

impl CommitReason {
    pub(crate) fn name(self) -> &'static str {
        match self {
            CommitReason::Serving => "serving",
            CommitReason::Lapsed => "lapsed",
        }
    }
}

/// The endpoint to commit now, if any. Serving: `https://X` once issuance, two genesis answers and the
/// node's registration all agree, and the committed value differs. Lapse: a committed `https://X`, X
/// being this node's own resolved address, with no valid certificate for 48 h, once this process tried
/// to get one, goes back to `http://X:8001` (same address, so the peer binding is unchanged). A
/// committed address that is not this node's (it moved) is left to the operator: an automatic commit
/// there would re-announce the old address and take the reactivation slot the operator's move needs. A
/// node that does not serve never changes its endpoint by itself. At most one commit per 100 macroblocks.
pub(crate) fn endpoint_commit(i: &CommitInputs) -> Option<(String, CommitReason)> {
    if !i.registered {
        return None;
    }
    if i.last_commit_macroblock.map_or(false, |last| i.macroblock < last.saturating_add(COMMIT_EVERY_MACROBLOCKS)) {
        return None;
    }
    let committed = i.committed.as_deref().unwrap_or("");
    if i.cert_valid_for_ip && i.genesis_agreed == Some(i.ip) {
        let https = format!("https://{}", i.ip);
        return (committed != https).then_some((https, CommitReason::Serving));
    }
    let held_ip = node_serve::parse_https_ipv4_endpoint(committed)?;
    if held_ip == i.ip && !i.cert_valid_for_ip && i.issuance_tried && i.now >= i.last_valid_until.saturating_add(LAPSE_SECS) {
        return Some((format!("http://{}:8001", held_ip), CommitReason::Lapsed));
    }
    None
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CommitRecord {
    last_commit_macroblock: Option<u64>,
    /// The latest not_after of any certificate held, so a lapse is measured across restarts.
    last_valid_until: u64,
}

// ─── The task ───────────────────────────────────────────────────────────────────────────────────

/// Start the public RPC task for a super node that serves wallets (the wallet plane itself is opened
/// by `start_rpc_server` under the same condition).
pub(crate) fn start(node: BlockchainNode) {
    match wallet_plane::plane_off_reason(node.get_node_type(), &node.get_node_id()) {
        None => {
            tokio::spawn(run(Arc::new(node)));
        }
        Some("hide_ip") => warn_if_hidden_node_still_serves(&node),
        Some(_) => {}
    }
}

/// Under QNET_HIDE_IP no task runs, so an `https://X` committed while the node served stays on chain
/// (a reactivation sent under it leaves the endpoint as it is) and wallets keep trying a closed port.
/// Say so at start, with what fixes it.
fn warn_if_hidden_node_still_serves(node: &BlockchainNode) {
    let committed = node.get_storage().load_node_endpoint(&node.get_node_id()).ok().flatten();
    if let Some(ip) = committed.as_deref().and_then(node_serve::parse_https_ipv4_endpoint) {
        if is_warn() {
            println!("[WARN][WALLETRPC] hidden_node_endpoint_still_https endpoint=https://{} action=reactivate api_endpoint=http://{}:8001", ip, ip);
        }
    }
}

struct Task {
    node: Arc<BlockchainNode>,
    dir: std::path::PathBuf,
    certs: CertManager,
    next_ip_check: u64,
    serve_key: Option<Arc<ServingKey>>,
    serve_cert: Option<SignedServeCert>,
    record: CommitRecord,
    warned_no_wallet_key: bool,
    /// See `CommitInputs::issuance_tried`.
    issuance_tried: bool,
}

async fn run(node: Arc<BlockchainNode>) {
    let dir = acme::wallet_tls_dir();
    let certs = CertManager::open(dir.clone(), Arc::clone(&WALLET_CERTS));
    let now = wallet_plane::unix_now();
    let record = std::fs::read(dir.join(COMMIT_FILE)).ok()
        .and_then(|b| serde_json::from_slice::<CommitRecord>(&b).ok()).unwrap_or_default();
    let serve_cert = node_serve::load_serve_cert(&dir, now);
    let seeded = {
        let mut a = PUBLIC_ADDRESS.write();
        a.ip = seed_address(a.ip, configured_public_ip().as_deref(), WALLET_CERTS.valid_ip(now));
        a.ip
    };
    let issuance_tried = certs.state().failing(now);
    let mut task = Task { node, dir, certs, next_ip_check: 0, serve_key: None, serve_cert, record, warned_no_wallet_key: false, issuance_tried };
    if is_info() {
        println!("[INFO][WALLETRPC] public_rpc_task_started dir={}", task.dir.display());
    }
    // Serve the held certificate before the first genesis round: that round can take a minute, and a
    // wallet told `no_certificate` in it would leave this node alone for a day.
    if let Some(ip) = seeded {
        let registered = task.registered();
        task.update_serving(ip, registered, now);
    }
    loop {
        task.tick().await;
        tokio::time::sleep(TICK).await;
    }
}

/// The address to start from, before genesis has answered. A configured address is the one (the
/// refresh only reports a genesis view that differs). Otherwise a valid installed certificate names
/// the address the CA reached this node at within its lifetime: serve on it, so a restart while
/// genesis is down or busy keeps serving.
pub(crate) fn seed_address(held: Option<Ipv4Addr>, configured: Option<&str>, cert_ip: Option<Ipv4Addr>) -> Option<Ipv4Addr> {
    if held.is_some() {
        return held;
    }
    match configured {
        Some(c) => c.parse::<Ipv4Addr>().ok().filter(|ip| unusable_reason(*ip).is_none()),
        None => cert_ip.filter(|ip| unusable_reason(*ip).is_none()),
    }
}

impl Task {
    async fn tick(&mut self) {
        let now = wallet_plane::unix_now();
        if now >= self.next_ip_check {
            self.next_ip_check = now + jittered(IP_REFRESH_SECS);
            self.refresh_address(now).await;
        }
        let Some(ip) = PUBLIC_ADDRESS.read().ip else {
            node_serve::set_serve_status(ServeStatus::NoCertificate);
            return;
        };
        match self.certs.plan(ip, now) {
            Step::Wait(_) => {}
            Step::Precheck => self.precheck(ip, now).await,
            Step::Issue { replaces } => {
                // The failure is logged and backed off by the manager.
                let _ = self.certs.issue(ip, replaces).await;
                self.issuance_tried = true;
            }
            Step::PollRenewalInfo => self.certs.poll_renewal_info(now).await,
        }
        self.certs.warn_if_expiring(now);
        if let Some(f) = self.certs.facts() {
            if f.not_after > self.record.last_valid_until {
                self.record.last_valid_until = f.not_after;
                self.save_record();
            }
        }
        let registered = self.registered();
        self.update_serving(ip, registered, now);
        self.maybe_commit(ip, registered, now).await;
    }

    async fn refresh_address(&mut self, now: u64) {
        let round = genesis_answers(None).await;
        let configured = configured_public_ip();
        let held = PUBLIC_ADDRESS.read().ip;
        match resolve_public_ip(configured.as_deref(), &round.answers, held) {
            Ok((ip, agreed)) => {
                let mut a = PUBLIC_ADDRESS.write();
                if held.map_or(false, |h| h != ip) && is_info() {
                    println!("[INFO][WALLETRPC] public_ip_changed from={} to={}", held.map(|h| h.to_string()).unwrap_or_default(), ip);
                }
                a.ip = Some(ip);
                if let Some(g) = agreed {
                    a.genesis_agreed = Some(g);
                    a.agreed_at = now;
                } else if configured.is_none() && is_info() {
                    // The held address stays; only new endpoint commits wait for an agreement.
                    println!("[INFO][WALLETRPC] public_ip_kept ip={} reason=no_genesis_agreement answers={} busy={}", ip, round.answers.len(), round.busy);
                }
            }
            Err(reason) => {
                if reason == "no_genesis_agreement" {
                    // Nothing configured, nothing held, nothing agreed: there is no address yet.
                    if is_info() {
                        println!("[INFO][WALLETRPC] public_rpc_off reason=no_public_ip answers={} busy={}", round.answers.len(), round.busy);
                    }
                } else {
                    // A configured address, or one two genesis nodes agree on, that cannot be served.
                    *PUBLIC_ADDRESS.write() = PublicAddress::default();
                    if is_warn() {
                        println!("[WARN][WALLETRPC] public_ip_unusable reason={}", reason);
                    }
                }
            }
        }
    }

    async fn precheck(&mut self, ip: Ipv4Addr, now: u64) {
        let (verdict, round) = match probe_443(ip).await {
            Ok(r) => r,
            Err(e) => {
                // A local fault, not a verdict: soon again, like a busy genesis.
                let wait = self.certs.on_precheck_busy(now);
                if is_warn() {
                    println!("[WARN][WALLETTLS] acme_failed stage={} reason=probe_arm:{} retry_in={}s", acme::Stage::Precheck.name(), e, wait);
                }
                return;
            }
        };
        // The probe's answers also refresh the agreement the commit rule needs.
        if let Some(agreed) = agreed_ipv4(&round.answers) {
            let mut a = PUBLIC_ADDRESS.write();
            a.genesis_agreed = Some(agreed);
            a.agreed_at = now;
        }
        let (ok, reason) = match verdict {
            Probe::Reachable => (Some(true), ""),
            // Every genesis runs a binary without the probe: a configured address orders anyway, under
            // the same backoff; an unconfigured one waits for genesis to probe it.
            Probe::NoAnswer if configured_public_ip().is_some() => (Some(true), ""),
            Probe::NoAnswer => (Some(false), "genesis_without_probe"),
            Probe::Unreachable => (Some(false), "port_443_unreachable"),
            // Nobody could tell: neither permission to order nor a 6 h verdict.
            Probe::Busy => (None, "genesis_busy"),
        };
        let wait = match ok {
            Some(ok) => self.certs.on_precheck(ok, now),
            None => self.certs.on_precheck_busy(now),
        };
        // A definite "no" is the schedule's say for this process: no order can follow it for hours.
        if ok == Some(false) {
            self.issuance_tried = true;
        }
        if ok != Some(true) && is_info() {
            println!("[INFO][WALLETRPC] public_rpc_off reason={} probe={:?} busy={} retry_in={}s", reason, verdict, round.busy, wait);
        }
    }

    fn registered(&self) -> bool {
        let id = self.node.get_node_id();
        matches!(self.node.get_storage().load_node_registration(&id), Ok(Some(_)))
    }

    /// Keep the serve-proof route's state current: the TLS certificate, the registration, the
    /// serving key (30-day rotation) and the ServeCert (re-issued every 72 h, on an IP change and on
    /// a key rotation).
    fn update_serving(&mut self, ip: Ipv4Addr, registered: bool, now: u64) {
        if WALLET_CERTS.valid_ip(now) != Some(ip) {
            node_serve::set_serve_status(ServeStatus::NoCertificate);
            return;
        }
        if !registered {
            node_serve::set_serve_status(ServeStatus::NotRegistered);
            return;
        }
        let key_due = self.serve_key.as_ref().map_or(true, |k| now >= k.created_at.saturating_add(node_serve::SERVE_KEY_ROTATE_SECS));
        if key_due {
            self.serve_key = Some(ServingKey::load_or_rotate(&self.dir, now));
        }
        let key = Arc::clone(self.serve_key.as_ref().expect("serving key set above"));
        if node_serve::serve_cert_due(self.serve_cert.as_ref(), &self.node.get_node_id(), ip, &key, now) {
            // Wiped when it goes out of scope, right after the one signature.
            let Some(mnemonic) = load_wallet_seed("QNET_WALLET_SEED").map(zeroize::Zeroizing::new) else {
                if !self.warned_no_wallet_key && is_warn() {
                    println!("[WARN][WALLETRPC] serve_cert_unavailable reason=no_wallet_seed");
                }
                self.warned_no_wallet_key = true;
                node_serve::set_serve_status(ServeStatus::NoWalletKey);
                return;
            };
            // seq equals issued_at and strictly increases across issues.
            let issued_at = self.serve_cert.as_ref().map_or(now, |c| now.max(c.cert.issued_at + 1));
            match node_serve::issue_serve_cert(&self.node.get_node_id(), ip, &key, &mnemonic, issued_at) {
                Ok(c) => {
                    node_serve::save_serve_cert(&self.dir, &c);
                    if is_info() {
                        println!("[INFO][WALLETRPC] serve_cert_issued ip={} not_after={} cert_hash={}", ip, c.cert.not_after, hex::encode(&c.hash[..8]));
                    }
                    self.serve_cert = Some(c);
                    self.warned_no_wallet_key = false;
                }
                Err(e) => {
                    if !self.warned_no_wallet_key && is_warn() {
                        println!("[WARN][WALLETRPC] serve_cert_unavailable reason={}", e);
                    }
                    self.warned_no_wallet_key = true;
                    node_serve::set_serve_status(ServeStatus::NoWalletKey);
                    return;
                }
            }
        }
        let cert = self.serve_cert.clone().expect("serve cert set above");
        node_serve::set_serve_status(ServeStatus::Ready { cert, key });
    }

    async fn maybe_commit(&mut self, ip: Ipv4Addr, registered: bool, now: u64) {
        let storage = self.node.get_storage();
        let node_id = self.node.get_node_id();
        let macroblock = storage.get_latest_macroblock_index().unwrap_or(0);
        let inputs = CommitInputs {
            committed: storage.load_node_endpoint(&node_id).ok().flatten(),
            ip,
            cert_valid_for_ip: WALLET_CERTS.valid_ip(now) == Some(ip),
            genesis_agreed: PUBLIC_ADDRESS.read().fresh_agreement(now),
            registered,
            last_valid_until: self.record.last_valid_until,
            issuance_tried: self.issuance_tried,
            now,
            macroblock,
            last_commit_macroblock: self.record.last_commit_macroblock,
        };
        let Some((to, reason)) = endpoint_commit(&inputs) else { return };
        let to = BlockchainNode::endpoint_or_empty(to);
        if to.is_empty() || macroblock == 0 {
            return;
        }
        let height = local_height();
        let mb_hash = storage.get_latest_macroblock_hash().map(hex::encode).unwrap_or_default();
        // The window is spent whatever the outcome: a refused or unincluded commit retries at the next.
        self.record.last_commit_macroblock = Some(macroblock);
        self.save_record();
        match self.node.submit_self_reactivation(&node_id, height, &mb_hash, macroblock, &to).await {
            Ok(_) => if is_info() {
                println!("[INFO][WALLETRPC] endpoint_commit from={} to={} reason={}",
                         inputs.committed.as_deref().unwrap_or("none"), to, reason.name());
            },
            Err(e) => if is_warn() {
                println!("[WARN][WALLETRPC] endpoint_commit_failed to={} reason={} err={}", to, reason.name(), e);
            },
        }
    }

    fn save_record(&self) {
        if let Ok(b) = serde_json::to_vec(&self.record) {
            if let Err(e) = acme::write_private(&self.dir, COMMIT_FILE, &b) {
                if is_warn() {
                    println!("[WARN][WALLETRPC] commit_record_save_failed err={}", e);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::wallet_plane::{certified_key, Installed};

    const X: Ipv4Addr = Ipv4Addr::new(44, 1, 2, 3);
    const Y: Ipv4Addr = Ipv4Addr::new(44, 9, 9, 9);
    const T: u64 = 1_800_000_000;

    fn base() -> CommitInputs {
        CommitInputs {
            committed: None, ip: X, cert_valid_for_ip: true, genesis_agreed: Some(X), registered: true,
            last_valid_until: T + 86_400, issuance_tried: true, now: T, macroblock: 5_000, last_commit_macroblock: None,
        }
    }

    fn with(f: impl FnOnce(&mut CommitInputs)) -> Option<(String, CommitReason)> {
        let mut i = base();
        f(&mut i);
        endpoint_commit(&i)
    }

    fn who(ip: &str, tls: Option<bool>) -> Whoami {
        Whoami { ip: ip.parse().unwrap(), tls443: tls, probe_refused: false }
    }

    fn round(answers: &[Whoami], busy: usize) -> Round {
        Round { answers: answers.to_vec(), busy }
    }

    #[test]
    fn endpoint_commit_rules() {
        let https = Some(("https://44.1.2.3".to_string(), CommitReason::Serving));
        // Serving with the three guards: empty, plain-form, other-IP and other-scheme rows all commit https://X.
        assert_eq!(with(|_| {}), https);
        for row in ["http://44.1.2.3:8001", "https://44.9.9.9", "http://44.9.9.9:8001", "https://44.1.2.3:443"] {
            assert_eq!(with(|i| i.committed = Some(row.into())), https, "{}", row);
        }
        assert_eq!(with(|i| i.committed = Some("https://44.1.2.3".into())), None, "already committed");
        // Each guard missing: nothing.
        assert_eq!(with(|i| i.cert_valid_for_ip = false), None, "issuance has not proven 443");
        assert_eq!(with(|i| i.genesis_agreed = None), None, "two genesis answers have not agreed");
        assert_eq!(with(|i| i.genesis_agreed = Some(Y)), None, "genesis sees another egress");
        assert_eq!(with(|i| i.registered = false), None);
        // A node that does not serve never changes its endpoint by itself.
        assert_eq!(with(|i| { i.cert_valid_for_ip = false; i.committed = Some("http://44.1.2.3:8001".into()); }), None);
        assert_eq!(with(|i| { i.cert_valid_for_ip = false; i.committed = None; i.last_valid_until = 0; }), None);
        // At most one commit per 100 macroblocks.
        assert_eq!(with(|i| i.last_commit_macroblock = Some(4_901)), None);
        assert_eq!(with(|i| i.last_commit_macroblock = Some(4_900)), https);
        // Lapse: a committed https://X with no valid certificate for 48 h goes back to http://X:8001.
        let lapsed = |now: u64, last: u64| with(|i| {
            i.committed = Some("https://44.1.2.3".into());
            i.cert_valid_for_ip = false;
            i.now = now;
            i.last_valid_until = last;
        });
        assert_eq!(lapsed(T + LAPSE_SECS - 1, T), None);
        assert_eq!(lapsed(T + LAPSE_SECS, T), Some(("http://44.1.2.3:8001".to_string(), CommitReason::Lapsed)));
        // Restarted long after the certificate expired: no lapse before this process tried to get one
        // (it may serve a minute later), and none while the commit window from an earlier one runs.
        assert_eq!(with(|i| {
            i.committed = Some("https://44.1.2.3".into());
            i.cert_valid_for_ip = false;
            i.now = T + 10 * 86_400;
            i.last_valid_until = T;
            i.issuance_tried = false;
        }), None, "the schedule has not had its say since the start");
        let mut st = acme::TlsState::default();
        assert!(!st.failing(T), "a fresh schedule has not failed");
        st.backoff_step = 1;
        assert!(st.failing(T), "failed attempts back it off");
        let mut st = acme::TlsState { precheck_next: T + 3600, ..Default::default() };
        assert!(st.failing(T), "the last probe found 443 unreachable");
        st.precheck_busy_step = 1;
        assert!(!st.failing(T), "busy genesis gave no verdict");
        st.precheck_ok_at = Some(T);
        st.precheck_busy_step = 0;
        assert!(!st.failing(T), "the last probe passed");
        // A committed https://Y that is not this node's address (it moved to X): never re-committed by
        // the node, so the operator's reactivation for X keeps its slot; with or without a certificate,
        // a long-expired one or none at all (a move without the wallet_tls directory).
        for (cert, agreed, last) in [(true, None, T), (false, None, T), (false, Some(X), 0), (false, None, 0)] {
            assert_eq!(with(|i| {
                i.committed = Some("https://44.9.9.9".into());
                i.cert_valid_for_ip = cert;
                i.genesis_agreed = agreed;
                i.now = T + 3 * 86_400;
                i.last_valid_until = last;
            }), None, "cert={} agreed={:?} last={}", cert, agreed, last);
        }
        // Still serving its own committed address: nothing to lapse.
        assert_eq!(with(|i| {
            i.committed = Some("https://44.1.2.3".into());
            i.genesis_agreed = None;
            i.now = T + 3 * 86_400;
            i.last_valid_until = T;
        }), None);
        assert_eq!(lapsed(T + LAPSE_SECS, T).map(|(_, r)| r.name()), Some("lapsed"));
        assert_eq!(CommitReason::Serving.name(), "serving");
    }

    #[test]
    fn public_address_needs_configuration_or_genesis_agreement() {
        // Two genesis answers agree.
        assert_eq!(resolve_public_ip(None, &[who("44.1.2.3", None), who("44.1.2.3", None)], None), Ok((X, Some(X))));
        assert_eq!(agreed_ipv4(&[who("44.1.2.4", None), who("44.1.2.3", None), who("44.1.2.3", None)]), Some(X));
        assert_eq!(resolve_public_ip(None, &[who("44.1.2.3", None), who("44.1.2.4", None)], None), Err("no_genesis_agreement".into()));
        assert_eq!(resolve_public_ip(None, &[who("44.1.2.3", None)], None), Err("no_genesis_agreement".into()));
        assert_eq!(resolve_public_ip(None, &[who("2001:db8::1", None), who("2001:db8::1", None)], None), Err("no_genesis_agreement".into()));
        // The configured address wins (a differing genesis view is only logged).
        assert_eq!(resolve_public_ip(Some("44.1.2.3"), &[who("44.9.9.9", None), who("44.9.9.9", None)], None), Ok((X, Some(Y))));
        assert_eq!(resolve_public_ip(Some("44.1.2.3"), &[], Some(Y)), Ok((X, None)));
        assert_eq!(resolve_public_ip(Some("node.example.test"), &[], None), Err("configured_not_ipv4".into()));
        // The strict range check, and today's validator (which refuses 45.10.20.30 by substring).
        assert_eq!(resolve_public_ip(None, &[who("10.0.0.5", None), who("10.0.0.5", None)], None), Err("not_public_unicast".into()));
        assert_eq!(resolve_public_ip(Some("203.0.113.7"), &[], None), Err("not_public_unicast".into()));
        assert_eq!(resolve_public_ip(Some("45.10.20.30"), &[], None), Err("refused_by_validator".into()));
        assert_eq!(unusable_reason(X), None);
        // Sticky: genesis down, busy or split keeps the held address (and records no new agreement);
        // only two answers agreeing on another address move it.
        for answers in [vec![], vec![who("44.1.2.4", None)], vec![who("44.1.2.4", None), who("44.1.2.5", None)]] {
            assert_eq!(resolve_public_ip(None, &answers, Some(X)), Ok((X, None)), "{:?}", answers);
        }
        assert_eq!(resolve_public_ip(None, &[who("44.9.9.9", None), who("44.9.9.9", None)], Some(X)), Ok((Y, Some(Y))));
        assert_eq!(resolve_public_ip(None, &[who("45.10.20.30", None), who("45.10.20.30", None)], Some(X)), Err("refused_by_validator".into()),
                   "an agreed address that cannot be served replaces the held one with none");
        // Before any answer: the configured address, else a valid certificate's.
        assert_eq!(seed_address(None, None, Some(X)), Some(X));
        assert_eq!(seed_address(Some(Y), None, Some(X)), Some(Y), "a resolved address is kept");
        assert_eq!(seed_address(None, Some("44.9.9.9"), Some(X)), Some(Y), "the configured address wins");
        assert_eq!(seed_address(None, Some("node.example.test"), Some(X)), None, "a configured name is no address");
        assert_eq!(seed_address(None, Some("45.10.20.30"), Some(X)), None, "nor one the validator refuses");
        assert_eq!(seed_address(None, None, Some("45.10.20.30".parse().unwrap())), None);
        assert_eq!(seed_address(None, None, None), None);
        // A serving commit needs a fresh agreement; an old one holds commits back, nothing else.
        let a = PublicAddress { ip: Some(X), genesis_agreed: Some(X), agreed_at: T };
        assert_eq!(a.fresh_agreement(T + AGREEMENT_FRESH_SECS - 1), Some(X));
        assert_eq!(a.fresh_agreement(T + AGREEMENT_FRESH_SECS), None);
        for _ in 0..200 {
            let j = jittered(IP_REFRESH_SECS);
            assert!((IP_REFRESH_SECS * 3 / 4..=IP_REFRESH_SECS * 5 / 4).contains(&j), "{}", j);
        }
    }

    #[test]
    fn the_443_probe_must_see_this_process() {
        assert_eq!(probe_verdict(X, &round(&[who("44.1.2.3", Some(true)), who("44.1.2.3", Some(true))], 0)), Probe::Reachable);
        assert_eq!(probe_verdict(X, &round(&[who("44.1.2.3", Some(false)), who("44.1.2.3", Some(true))], 3)), Probe::Reachable);
        assert_eq!(probe_verdict(X, &round(&[who("44.1.2.3", Some(false))], 0)), Probe::Unreachable, "another server answers 443");
        assert_eq!(probe_verdict(X, &round(&[who("44.9.9.9", Some(true))], 0)), Probe::Unreachable, "seen at another address");
        assert_eq!(probe_verdict(X, &round(&[who("44.1.2.3", None), who("44.1.2.3", None)], 0)), Probe::NoAnswer, "an older genesis answers no probe");
        assert_eq!(probe_verdict(X, &round(&[], 0)), Probe::NoAnswer);
        // Busy, rate-limited or unreachable genesis is no verdict: neither "not reachable" nor "no probe".
        assert_eq!(probe_verdict(X, &round(&[], 5)), Probe::Busy);
        assert_eq!(probe_verdict(X, &round(&[who("44.1.2.3", None)], 1)), Probe::Busy);
    }

    #[test]
    fn genesis_replies_tell_busy_from_unsupported() {
        use serde_json::json;
        let ok = |v: Value| door_reply(200, Some(&v));
        assert_eq!(ok(json!({"ip": "44.1.2.3"})), DoorReply::Answer(who("44.1.2.3", None)));
        assert_eq!(ok(json!({"ip": "44.1.2.3", "probe": "caller_not_socket"})),
                   DoorReply::Answer(Whoami { ip: "44.1.2.3".parse().unwrap(), tls443: None, probe_refused: true }));
        assert_eq!(ok(json!({"ip": "44.1.2.3", "tcp443": true, "tls443": true})), DoorReply::Answer(who("44.1.2.3", Some(true))));
        assert_eq!(ok(json!({"nope": 1})), DoorReply::Busy, "a garbled answer is no verdict");
        assert_eq!(door_reply(200, None), DoorReply::Busy);
        for s in [429, 500, 502, 503, 504] {
            assert_eq!(door_reply(s, None), DoorReply::Busy, "{}", s);
        }
        for s in [400, 403, 404] {
            assert_eq!(door_reply(s, None), DoorReply::Unsupported, "{}", s);
        }
        let probed = DoorReply::Answer(who("44.1.2.3", Some(true)));
        let refused = DoorReply::Answer(Whoami { ip: "44.1.2.3".parse().unwrap(), tls443: None, probe_refused: true });
        let old = DoorReply::Answer(who("44.1.2.3", None));
        let proxied = DoorReply::Answer(who("172.17.0.1", Some(false)));
        // A probe: the plain port's verdict ends it; a door that cannot probe leaves the address and "busy".
        assert_eq!(genesis_say(true, [probed.clone()]), GenesisSay { answer: Some(who("44.1.2.3", Some(true))), busy: false });
        assert_eq!(genesis_say(true, [DoorReply::Busy, refused.clone()]),
                   GenesisSay { answer: Some(Whoami { ip: "44.1.2.3".parse().unwrap(), tls443: None, probe_refused: true }), busy: true });
        assert_eq!(genesis_say(true, [DoorReply::Unsupported, DoorReply::Unsupported]), GenesisSay::default(), "an older binary");
        assert_eq!(genesis_say(true, [DoorReply::Unsupported, old.clone()]), GenesisSay { answer: Some(who("44.1.2.3", None)), busy: false });
        assert_eq!(genesis_say(true, [DoorReply::Busy, DoorReply::Busy]), GenesisSay { answer: None, busy: true });
        // An address that is not public is that genesis's own proxy: no verdict and no view of the address.
        assert_eq!(genesis_say(true, [proxied.clone(), DoorReply::Busy]), GenesisSay { answer: None, busy: true });
        assert_eq!(genesis_say(false, [proxied, old.clone()]), GenesisSay { answer: Some(who("44.1.2.3", None)), busy: false });
        assert!(final_reply(true, &probed) && final_reply(false, &refused) && !final_reply(true, &refused) && final_reply(true, &old));
        // A round ends once two agree (and, for a probe, once one saw this process or two saw it not).
        assert!(!round(&[who("44.1.2.3", None)], 0).settled(false));
        assert!(round(&[who("44.1.2.3", None), who("44.1.2.3", None)], 0).settled(false));
        assert!(!round(&[who("44.1.2.3", None), who("44.1.2.3", None)], 0).settled(true), "two older binaries: ask the rest");
        assert!(!round(&[who("44.1.2.3", Some(false)), who("44.1.2.3", None)], 0).settled(true), "one negative is not enough");
        assert!(round(&[who("44.1.2.3", Some(false)), who("44.1.2.3", Some(false))], 0).settled(true));
        assert!(round(&[who("44.1.2.3", Some(true)), who("44.1.2.3", None)], 0).settled(true));
    }

    #[test]
    fn self_endpoint_guard_and_https_form() {
        // The validator's verdict is applied before anything is signed: an IP it refuses announces "".
        assert_eq!(BlockchainNode::endpoint_or_empty("http://45.10.20.30:8001".into()), "");
        assert_eq!(BlockchainNode::endpoint_or_empty("https://45.10.20.30".into()), "");
        assert_eq!(BlockchainNode::endpoint_or_empty("http://44.1.2.3:8001".into()), "http://44.1.2.3:8001");
        assert_eq!(BlockchainNode::endpoint_or_empty(String::new()), "");
        // Serving (a valid certificate for the resolved address) announces https://X.
        let now = crate::rpc::wallet_plane::unix_now();
        assert_eq!(serving_endpoint(now), None, "no address resolved yet");
        *PUBLIC_ADDRESS.write() = PublicAddress { ip: Some(X), genesis_agreed: Some(X), agreed_at: now };
        assert_eq!(serving_endpoint(now), None, "no certificate yet");
        let cert = rcgen::generate_simple_self_signed(vec!["unused.test".to_string()]).unwrap();
        let key = certified_key(vec![cert.serialize_der().unwrap()], &cert.serialize_private_key_der()).unwrap();
        WALLET_CERTS.install(Installed { key: Arc::clone(&key), ip: Y, not_before: now - 60, not_after: now + 3600 });
        assert_eq!(serving_endpoint(now), None, "a certificate for another address");
        WALLET_CERTS.install(Installed { key, ip: X, not_before: now - 60, not_after: now + 3600 });
        assert_eq!(serving_endpoint(now).as_deref(), Some("https://44.1.2.3"));
        assert_eq!(serving_endpoint(now + 3600), None, "expired");
        if std::env::var("QNET_HIDE_IP").is_err() {
            assert_eq!(BlockchainNode::self_public_api_endpoint(NodeType::Super), "https://44.1.2.3");
        }
        assert_eq!(BlockchainNode::self_public_api_endpoint(NodeType::Light), "");
        *PUBLIC_ADDRESS.write() = PublicAddress::default();
        // Registration and reactivation both announce through this one resolver.
        let src = crate::node::node_sources();
        assert!(src.matches("self_public_api_endpoint(").count() >= 2);
        let rpc = include_str!("../rpc/registration_api.rs");
        assert!(rpc.contains("blockchain.submit_self_reactivation("), "the operator route uses the shared submitter");
        assert!(include_str!("public_rpc.rs").contains("self.node.submit_self_reactivation("), "and so does the automatic commit");
        let hide = &src[src.find("pub(crate) fn self_public_api_endpoint").unwrap()..];
        assert!(hide[..400].contains("QNET_HIDE_IP"), "the opt-out announces nothing");
    }

    #[test]
    fn reactivation_apply_changes_only_endpoint_rows() {
        // The state: an automatic commit moves no balance, no account and no root.
        let sm = qnet_state::State::new();
        let mut acct = qnet_state::Account::new("eon_public_rpc_test".to_string());
        acct.balance = 77;
        sm.restore_accounts(vec![(acct.address.clone(), acct)]).unwrap();
        let node_id = "super_node_00112233445566aa";
        let before = (sm.get_state_root(), sm.get_account("eon_public_rpc_test").map(|a| a.balance), sm.get_account(node_id).is_some());
        let tx = BlockchainNode::create_node_reactivation_tx(node_id, 100, &"ab".repeat(32), 7, "https://44.1.2.3");
        sm.apply_transaction(&tx).unwrap();
        let after = (sm.get_state_root(), sm.get_account("eon_public_rpc_test").map(|a| a.balance), sm.get_account(node_id).is_some());
        assert_eq!(before, after, "state root, balances and accounts unchanged");
        // The registry: only the node's `nep_` row and the RAM endpoint map change; registry_root does not.
        let dir = std::env::temp_dir().join(format!("qnet-react-rows-{}-{}", std::process::id(), rand::random::<u64>()));
        let storage = crate::storage::Storage::new(dir.to_str().unwrap()).unwrap();
        let cf = storage.registry_cf_for_test();
        storage.put_registry_row_for_test(&cf, format!("node_{}", node_id).as_bytes(), br#"{"node_type":"super","wallet":"w","reputation":70,"reg_height":5,"burn":"b","vrf_pk_sha3":"","reg_index":0}"#);
        storage.put_registry_row_for_test(&cf, format!("srtr_{}", node_id).as_bytes(), b"row");
        let rows = |s: &crate::storage::Storage| s.registry_rows_for_test();
        let root_before = storage.compute_registry_root(1_000);
        let rows_before = rows(&storage);
        let cache = DashMap::new();
        BlockchainNode::cache_node_registrations_from_transactions_with_dashmap(&storage, &[tx], &cache);
        let rows_after = rows(&storage);
        let changed: Vec<String> = rows_after.iter().filter(|(k, v)| rows_before.get(*k) != Some(*v)).map(|(k, _)| k.clone()).collect();
        assert_eq!(changed, vec![format!("nep_{}", node_id)]);
        assert_eq!(rows_before.len() + 1, rows_after.len());
        assert_eq!(storage.compute_registry_root(1_000), root_before);
        assert_eq!(crate::genesis_constants::get_node_endpoint_ip(node_id).as_deref(), Some("44.1.2.3"));
        drop(storage);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn serving_starts_before_the_first_genesis_round() {
        // A restart serves its held certificate at once: the serve-proof state is set before the first
        // tick, whose genesis round can take a minute (a `no_certificate` then costs a day of wallets).
        let src = include_str!("public_rpc.rs").replace("\r\n", "\n");
        let run = &src[src.find("async fn run(node: Arc<BlockchainNode>)").unwrap()..];
        let run = &run[..run.find("\n}\n").unwrap()];
        assert!(run.find("task.update_serving(ip, registered, now)").unwrap() < run.find("task.tick().await").unwrap());
        let tick = &src[src.find("    async fn tick(&mut self)").unwrap()..];
        assert!(tick.find("self.refresh_address(now).await").unwrap() < tick.find("self.update_serving(ip, registered, now)").unwrap(),
                "later ticks refresh first, as before");
    }

    #[test]
    fn entrypoint_never_widens_the_public_rpc_keys() {
        // The image's start widens the data volume's modes; the keys are tightened first and left out.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Dockerfile.production");
        let df = std::fs::read_to_string(path).unwrap().replace("\r\n", "\n");
        let tighten = df.find("chmod -R go-rwx \"$DATA_DIR/wallet_tls\"").expect("the keys are tightened");
        let wide = df.find("-exec chmod 755 {} +").expect("the wide pass");
        assert!(tighten < wide, "tightened before the wide pass");
        assert!(df[..wide].ends_with("find \"$DATA_DIR\" -path \"$DATA_DIR/wallet_tls\" -prune -o "), "the wide pass skips them");
        assert!(!df.contains("chmod -R 755"), "no recursive pass over the keys");
    }

    /// A bash to run the installer with: the system's on Unix; Git's on Windows (never the WSL
    /// launcher, whose paths differ). None skips the run (the text checks still apply).
    fn installer_bash() -> Option<std::path::PathBuf> {
        if cfg!(windows) {
            ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files/Git/usr/bin/bash.exe"].iter()
                .map(std::path::PathBuf::from).find(|p| p.is_file())
        } else {
            Some(std::path::PathBuf::from("bash"))
        }
    }

    #[test]
    fn installer_dry_run_publishes_443_unless_opted_out() {
        let script_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/install-super-node.sh");
        let text = std::fs::read_to_string(&script_path).unwrap();
        for needle in ["-p 0.0.0.0:443:8443", "--no-public-rpc)", "Publishing\"", "ufw allow 443/tcp", "--add-port=443/tcp",
                       "port 443 is in use", "https://$PUBLIC_IP/healthz", "-p 0.0.0.0:8001:8001", "own_node_holds_443", "genesis_public_ip", "-p 9876:9876", "-p 9877:9877", "-p 10876:10876/udp"] {
            assert!(text.contains(needle), "the installer has {}", needle);
        }
        assert!(text.contains("accepts that authority's subscriber terms"), "the subscriber-terms notice");
        let Some(bash) = installer_bash() else {
            eprintln!("installer dry run skipped: no bash");
            return;
        };
        // Its address check is the node's own range rule: a genesis answer naming a proxy, a private or
        // a reserved address, or a non-canonical form, is no public address.
        let text_lf = text.replace("\r\n", "\n");
        let func = &text_lf[text_lf.find("is_public_ipv4() {").unwrap()..];
        let func = &func[..func.find("\n}\n").unwrap() + 2];
        let cases = [("44.1.2.3", true), ("8.8.8.8", true), ("172.32.0.1", true), ("10.0.0.1", false), ("172.17.0.1", false),
                     ("100.64.0.1", false), ("127.0.0.1", false), ("169.254.1.1", false), ("192.168.0.1", false), ("192.0.2.1", false),
                     ("198.18.0.1", false), ("198.51.100.1", false), ("203.0.113.7", false), ("224.0.0.1", false), ("044.1.2.3", false),
                     ("256.1.1.1", false), ("1.2.3", false), ("", false)];
        let mut script = format!("{}\n", func);
        for (ip, _) in cases {
            script.push_str(&format!("is_public_ipv4 '{}' && echo '{}=1' || echo '{}=0'\n", ip, ip, ip));
        }
        if let Ok(out) = std::process::Command::new(&bash).arg("-c").arg(&script).output() {
            let out = String::from_utf8_lossy(&out.stdout).to_string();
            for (ip, public) in cases {
                assert!(out.lines().any(|l| l == format!("{}={}", ip, public as u8)), "{} public={}: {}", ip, public, out);
            }
        }
        // Another container's 443 mapping is found before the running node is removed (it has no host
        // socket without the runtime's proxy); this node's own mapping and other ports are not it.
        let func = &text_lf[text_lf.find("other_container_holds_443() {").unwrap()..];
        let func = &func[..func.find("\n}\n").unwrap() + 2];
        let ps_cases = [
            ("qnet-super-node 0.0.0.0:443->8443/tcp|web 0.0.0.0:8080->80/tcp, 0.0.0.0:4430->443/tcp", false),
            ("qnet-super-node 0.0.0.0:443->8443/tcp|proxy 0.0.0.0:443->443/tcp, :::443->443/tcp", true),
            ("", false),
        ];
        for (ps, held) in ps_cases {
            let script = format!(
                "NODE_NAME=qnet-super-node\ndocker() {{ [ \"$1\" = ps ] && printf '%s' '{}' | tr '|' '\\n'; }}\n{}\nother_container_holds_443 && echo held || echo free\n",
                ps, func);
            if let Ok(out) = std::process::Command::new(&bash).arg("-c").arg(&script).output() {
                let out = String::from_utf8_lossy(&out.stdout).to_string();
                assert_eq!(out.trim(), if held { "held" } else { "free" }, "{}", ps);
            }
        }
        let other = text_lf.find("if [ \"$PUBLIC_RPC\" = 1 ] && other_container_holds_443; then").unwrap();
        assert!(other < text_lf.find("docker stop \"$NODE_NAME\"").unwrap(), "asked before the node is removed");
        assert!(text_lf.contains("docker run \"${RUN_ARGS[@]}\" \"${VOLUME_ARGS[@]}\" || err"), "a failed start with 443 retries without it");
        let tmp = std::env::temp_dir().join(format!("qnet-installer-{}-{}", std::process::id(), rand::random::<u64>()));
        std::fs::create_dir_all(&tmp).unwrap();
        let seed = tmp.join("seed");
        std::fs::write(&seed, "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about").unwrap();
        let fwd = |p: &std::path::Path| p.to_string_lossy().replace('\\', "/");
        let run = |args: &[&str], env: &[(&str, String)]| -> Option<(bool, String)> {
            let mut c = std::process::Command::new(&bash);
            c.arg(fwd(&script_path)).args(args)
                .env("QNET_ACTIVATION_CODE", "QNET-SAAAAA-BBBBBB-CCCCCC")
                .env("QNET_BURN_TX_HASH", "burnsig")
                .env("QNET_BURN_AMOUNT", "1500")
                .env("QNET_WALLET_SEED_FILE", fwd(&seed))
                .env("QNET_DATA_DIR", fwd(&tmp.join("data")))
                .env_remove("QNET_HIDE_IP")
                .env_remove("QNET_WALLET_SEED");
            for (k, v) in env {
                c.env(k, v);
            }
            let out = c.output().ok()?;
            Some((out.status.success(), format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))))
        };
        let Some((ok, out)) = run(&["--dry-run"], &[]) else {
            eprintln!("installer dry run skipped: bash did not start");
            return;
        };
        assert!(ok, "{}", out);
        for p in ["-p 0.0.0.0:8001:8001", "-p 9876:9876", "-p 9877:9877", "-p 10876:10876/udp"] {
            assert!(out.contains(p), "{}: {}", p, out);
        }
        if out.contains("port 443 is in use") {
            // This machine already listens on 443: the installer runs without the mapping, as it should.
            assert!(out.contains("dry run: public_rpc=0") && !out.contains("443:8443"), "{}", out);
        } else {
            assert!(out.contains("dry run: public_rpc=1") && out.contains("-p 0.0.0.0:443:8443"), "{}", out);
            assert!(out.contains("Publishing") && out.contains("subscriber terms"), "the notice is printed: {}", out);
        }
        let (ok, out) = run(&["--dry-run", "--no-public-rpc"], &[]).unwrap();
        assert!(ok && out.contains("dry run: public_rpc=0") && !out.contains("443:8443") && !out.contains("subscriber terms"), "{}", out);
        let (ok, out) = run(&["--dry-run"], &[("QNET_HIDE_IP", "1".to_string())]).unwrap();
        assert!(ok && out.contains("public_rpc=0") && out.contains("-e QNET_HIDE_IP=1") && !out.contains("443:8443"), "{}", out);
        let (ok, out) = run(&["--dry-run", "--bogus"], &[]).unwrap();
        assert!(!ok && out.contains("unknown option"), "{}", out);
        // A dry run writes nothing, not even the phrase file.
        let (ok, _) = run(&["--dry-run"], &[("QNET_WALLET_SEED", "word ".repeat(12)), ("QNET_WALLET_SEED_FILE", String::new())]).unwrap();
        assert!(ok);
        assert!(!tmp.join("qnet_seed").exists() && !tmp.join("data").exists());
        let _ = std::fs::remove_dir_all(tmp);
    }
}
