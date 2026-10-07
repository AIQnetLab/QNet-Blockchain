//! The device layer's routes (Phase A, A1-A6, A9-A11): the device challenge, the enrolment step of
//! `/light-node/bind`, the genesis-only internal routes of the attestor round (`node_attestDevice`), the
//! record sync and its pull-heal, the lease refresh, the 30-day key rotation and the release that goes with
//! "Stop on this device". And what each genesis runs beside them (A14-A16): the oracle's availability, its
//! revocation snapshot and the per-epoch pause of the chains it names, the daily recheck of gate-held
//! records, the cross-owner bitmap monitor. RPC and P2P policy only; no block rule reads any of it.
//!
//! Refresh, rotation and release go to the genesis that issued their challenge. A refresh's outcome and a
//! release are state changes this genesis signs and sends to the other four; a rotation is a new statement
//! of four over the new key, the binding's sequence kept.
//!
//! Enrolment at the ingress (the challenge's issuer), in order: the stamp, the per-address limit (spent
//! only by evidence that verifies), the public evidence and the local records (before any vendor call),
//! the oracle's lease claim, this node's
//! own attestor, the other four, and - at four signatures - the record here and at every genesis. The app
//! waits 15 s; a step still running after `BIND_DEVICE_BUDGET` keeps running, the binding is taken with a
//! provisional `check_pending` record, and the final statement replaces it when it comes.
//!
//! Wire forms: `docs/protocols/light-node-messages.md` sections 5 to 8.

use super::*;
use crate::light_binding::{self as lb, Refusal};
use crate::light_device::attest::{self, AttestRequest, Env};
use crate::light_device::evidence::{self, DeviceBlock, VerifiedDevice, Verifier};
use crate::light_device::messages::{self, LeaseStatement, StatementFields};
use crate::light_device::oracle::{self, ClaimAnswer, ClaimInput, OracleApi};
use crate::light_device::record::{DeviceRecord, StateChange};
use crate::light_device::statement::{self, GenesisSet, LeaseProof, OraclePins, StatementBundle};
use crate::light_device::store::{self, Applied};
use crate::light_device::{self as ld, DeviceReason, DeviceRefusal, DeviceState, Op, Platform, Purpose, StepRefusal, Trust};

/// How long `/bind` waits for the device step before it answers with a provisional record: under the
/// app's 15 s, with room for the binding's own writes.
pub(crate) const BIND_DEVICE_BUDGET: std::time::Duration = std::time::Duration::from_secs(12);
/// How long a statement's collection may run in all (the lease inside it is good for ten minutes).
const QUORUM_BUDGET: std::time::Duration = std::time::Duration::from_secs(60);
/// One attestor's answer.
const ATTEST_CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

const ATTEST_PATH: &str = "/api/v1/internal/light-device-attest";
const SYNC_PATH: &str = "/api/v1/internal/light-device-sync";

/// Enrolments one client address may start per hour (R6); counted only for messages carrying a stamp
/// this genesis issued and device evidence that verifies.
static ENROL_ADDR_LIMIT: KeyedLimiter = KeyedLimiter::new(ld::ENROL_PER_ADDR_PER_HOUR, 3600);
/// Attestor requests one ingress genesis may make per minute.
static ATTEST_INGRESS_LIMIT: KeyedLimiter = KeyedLimiter::new(600, 60);
/// The answer each device message got, for as long as its challenge lives.
pub(super) static DEVICE_ANSWERS: ld::stamp::Answers = ld::stamp::Answers::new(50_000);

// ---- A1: the device challenge ----

/// `GET /api/v1/light-node/device-challenge?node_id=N&purpose=P`. Only the five genesis carry the device
/// layer, and only while they serve it (`device_layer_served`: the shared serve epoch, the pinned oracle key,
/// the oracle configured); any other node answers `not_served` and the app asks the next shard owner.
pub(super) async fn handle_device_challenge(
    params: HashMap<String, String>,
    remote_addr: Option<std::net::SocketAddr>,
) -> Result<impl Reply, Rejection> {
    if check_api_rate_limit(remote_addr, "light_device_challenge").is_err() {
        return Ok(warp::reply::json(&Refusal::RateLimited.to_json()));
    }
    let node = params.get("node_id").map(|s| s.as_str()).unwrap_or("");
    let purpose = params.get("purpose").and_then(|p| Purpose::parse(p));
    let (true, Some(purpose)) = (messages::is_device_node_id(node), purpose) else {
        return Ok(warp::reply::json(&Refusal::BadRequest.to_json()));
    };
    let Some(issuer) = ld::serving_genesis_id() else {
        return Ok(warp::reply::json(&json!({ "success": false, "reason": "not_served", "error": "This node does not serve the device layer" })));
    };
    Ok(warp::reply::json(&ld::stamp::issue(&issuer, node, purpose, ld::now_secs()).to_json()))
}

// ---- A2: the device block of /bind ----

/// A device block the ingress checked alone: stamp, limits, public evidence, its own records. Its `Debug`
/// shows no token and no evidence.
#[derive(Clone)]
pub(crate) struct PreparedDevice {
    pub(crate) node_id: String,
    pub(crate) wallet: String,
    pub(crate) identity_pk: String,
    pub(crate) ping_pk: String,
    /// The wallet key's v2 delegation of the binding (hex).
    pub(crate) delegation_sig: String,
    pub(crate) seq: u64,
    pub(crate) raw_block: serde_json::Value,
    pub(crate) block: DeviceBlock,
    pub(crate) device: VerifiedDevice,
    pub(crate) preimage: String,
    pub(crate) rebind_from: Option<String>,
    pub(crate) key_node: Option<String>,
    /// The vendor token: DeviceCheck on iOS, Play Integrity on Android; None when the device's vendor
    /// call failed (owner decision (a): the binding is taken, the device waits in `check_pending`).
    pub(crate) token: Option<String>,
    pub(crate) registered: bool,
    pub(crate) client_ip: Option<String>,
    /// This very device already holds a final statement with a lease for this node at this sequence: a
    /// re-send, nothing to do again.
    pub(crate) held: Option<DeviceRecord>,
}

impl std::fmt::Debug for PreparedDevice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedDevice").field("node_id", &self.node_id).field("seq", &self.seq)
            .field("platform", &self.device.platform).field("prov", &self.device.prov).field("fresh", &self.device.fresh)
            .field("rebind_from", &self.rebind_from).field("token", &self.token.is_some()).field("held", &self.held.is_some())
            .finish_non_exhaustive()
    }
}

impl PreparedDevice {
    pub(crate) fn reference(&self) -> String {
        messages::reference(&self.block.nonce_bytes(), &self.device.device_tag())
    }

    fn op(&self) -> Op {
        if self.rebind_from.is_some() { Op::Rebind } else { Op::Enrol }
    }

    /// The ingress's record while the step is still running.
    fn provisional(&self, own_id: &str, now: u64, epoch: u64) -> DeviceRecord {
        DeviceRecord {
            node_id: self.node_id.clone(),
            platform: self.device.platform,
            hw_pub: hex::encode(self.device.hw_pub),
            hw_key: self.device.hw_key(),
            key_id: hex::encode(self.device.key_id()),
            device_tag: hex::encode(self.device.device_tag()),
            prov: self.device.prov,
            trust: self.device.trust,
            op: self.op(),
            seq: self.seq,
            issued_epoch: epoch,
            effective_epoch: epoch + 1,
            state: DeviceState::CheckPending,
            state_seq: 0,
            until_epoch: 0,
            reason: "pending".into(),
            lease: None,
            lease_valid_until: 0,
            refresh_at: 0,
            rotation_due_epoch: epoch + ld::ROTATION_PERIOD_EPOCHS,
            last_counter: self.device.counter as u64,
            att_key: self.device.att_key.clone(),
            certs_issued: self.device.certs_issued,
            serials: self.device.serials.clone(),
            stmt_hash: String::new(),
            ingress: own_id.to_string(),
            nonce: self.block.nonce.clone(),
            rebind_from: self.rebind_from.clone(),
            provisional: true,
            created_at: now,
            updated_at: now,
            last_change: None,
        }
    }
}

/// File a refusal this genesis issued for a device whose evidence it verified, so support can answer an
/// appeal quoting its reference (the oracle's `POST /v1/refusal` seals the public evidence for 90 days).
/// Only the refusals a person may overturn; fire and forget.
fn file_refusal(oracle: Option<&'static dyn OracleApi>, node: &str, block: &DeviceBlock, device: &VerifiedDevice, r: &StepRefusal) {
    let StepRefusal::Device(d) = r else { return; };
    if !matches!(d.reason, DeviceReason::KeyInUse | DeviceReason::SlotPaused | DeviceReason::AppUnrecognized) { return; }
    let (Some(o), Ok(handle)) = (oracle, tokio::runtime::Handle::try_current()) else { return; };
    let body = json!({ "node_id": node, "platform": device.platform.as_str(), "hw_pub": hex::encode(device.hw_pub),
                       "nonce": block.nonce, "reason": d.reason.as_str(), "evidence": block.evidence_json() });
    handle.spawn(async move {
        if let Err(oracle::OracleError::Unavailable(why)) = o.post("/v1/refusal", body, oracle::BACKGROUND_CALL_TIMEOUT).await {
            if crate::node::is_debug() {
                println!("[DBG][DEVICE] refusal_not_filed reason={}", why);
            }
        }
    });
}

fn with_reference(r: StepRefusal, reference: &str) -> StepRefusal {
    match r {
        StepRefusal::Device(mut d) => {
            if d.reference.is_none() { d.reference = Some(reference.to_string()); }
            StepRefusal::Device(d)
        }
        other => other,
    }
}

/// Everything the ingress checks alone, before it spends the node's budget or calls the oracle. None when
/// the request carries no device block (an installed app: legacy replies count until the enforcement
/// epoch, so honest old clients keep working).
#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_bind_device(
    storage: &crate::storage::Storage,
    req: &LightNodeBindRequest,
    registered: bool,
    issuer: Option<&str>,
    verifier: &Verifier,
    remote_addr: Option<std::net::SocketAddr>,
    now: u64,
    epoch: u64,
) -> Result<Option<PreparedDevice>, StepRefusal> {
    let Some(raw) = req.device.as_ref() else {
        if epoch >= ld::LIGHT_DEVICE_ENFORCE_EPOCH { return Err(StepRefusal::device(DeviceReason::Unsupported)); }
        return Ok(None);
    };
    // A node that issues no challenges cannot check a stamp: the app asks the next owner for one.
    let Some(issuer) = issuer else { return Err(StepRefusal::device(DeviceReason::Stale)); };
    let block = evidence::parse_block(raw).map_err(StepRefusal::device)?;
    if !ld::stamp::verify(issuer, &req.node_id, Purpose::Enrol, &block.nonce, &block.stamp, now) {
        return Err(StepRefusal::device(DeviceReason::Stale));
    }
    // The address's budget: an address over it is refused before the evidence is read, and only an
    // enrolment whose device evidence verifies spends it, so junk evidence from behind a shared carrier
    // address cannot lock the honest phones there out.
    let meter = remote_addr.map(|a| a.ip()).filter(|ip| !is_ip_whitelisted(*ip)).map(lookup_meter_key);
    if let Some(key) = &meter {
        if let Err(wait) = ENROL_ADDR_LIMIT.check(key, now) {
            return Err(DeviceRefusal::retry(DeviceReason::RateLimited, wait).into());
        }
    }
    let env = Env { storage, verifier, genesis: GenesisSet::production(), pins: OraclePins::production(), now, epoch,
                    mainnet: verifier.policies.mainnet };
    let (device, preimage, rebind_from) = attest::check_device(&env, &req.node_id, &req.wallet_address, &req.identity_pubkey,
                                                               &req.ping_pubkey, req.seq, &block)?;
    if let Some(key) = &meter {
        if !ENROL_ADDR_LIMIT.allows(key, now) {
            return Err(DeviceRefusal::retry(DeviceReason::RateLimited, ENROL_ADDR_LIMIT.check(key, now).err().unwrap_or(60)).into());
        }
    }
    let reference = messages::reference(&block.nonce_bytes(), &device.device_tag());
    let refused = |r: StepRefusal| {
        let r = with_reference(r, &reference);
        file_refusal(oracle::configured(), &req.node_id, &block, &device, &r);
        r
    };
    if env.mainnet && device.trust == Trust::Test {
        return Err(refused(StepRefusal::device(DeviceReason::AppUnrecognized)));
    }
    let op = if rebind_from.is_some() { Op::Rebind } else { Op::Enrol };
    attest::admit(&env, &req.node_id, req.seq, &device, rebind_from.as_deref(), op).map_err(refused)?;
    let token = match block.platform { Platform::Ios => req.dc_token.clone(), Platform::Android => req.pi_token.clone() }
        .filter(|t| oracle::token_shape_ok(t));
    let key_node = if device.fresh { None } else {
        rebind_from.clone().or_else(|| storage.device_key_entry(&device.hw_key()).map(|e| e.node_id))
            .or_else(|| storage.device_known_key(&hex::encode(device.key_id())).map(|k| k.node_id))
    };
    let held = storage.device_record(&req.node_id)
        .filter(|r| !r.provisional && r.hw_key == device.hw_key() && r.seq == req.seq && r.lease.is_some());
    Ok(Some(PreparedDevice {
        node_id: req.node_id.clone(),
        wallet: req.wallet_address.clone(),
        identity_pk: req.identity_pubkey.clone(),
        ping_pk: req.ping_pubkey.clone(),
        delegation_sig: req.delegation_cert.clone(),
        seq: req.seq,
        raw_block: raw.clone(),
        block,
        device,
        preimage,
        rebind_from,
        key_node,
        token,
        registered,
        client_ip: remote_addr.map(|a| a.ip()).filter(|ip| !ip.is_unspecified()).map(|ip| ip.to_string()),
        held,
    }))
}

/// What the device step at the ingress reads and calls. Built from the running node in production;
/// tests pass their own attestors, oracle and keys.
#[derive(Clone)]
pub(crate) struct DeviceCtx {
    pub(crate) storage: Arc<crate::storage::Storage>,
    pub(crate) own_id: String,
    /// This genesis's raw signature (hex) over a statement.
    pub(crate) sign: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    /// Ask another genesis's attestor.
    pub(crate) ask: Arc<dyn Fn(String, AttestRequest) -> futures::future::BoxFuture<'static, Option<Value>> + Send + Sync>,
    /// Pull a node's record from the genesis at an address (node id, address); true when it recorded one.
    pub(crate) pull: Option<Arc<dyn Fn(String, String) -> futures::future::BoxFuture<'static, bool> + Send + Sync>>,
    pub(crate) oracle: Option<&'static dyn OracleApi>,
    pub(crate) verifier: &'static Verifier,
    pub(crate) genesis: &'static GenesisSet,
    pub(crate) pins: &'static OraclePins,
    pub(crate) epoch: u64,
    pub(crate) mainnet: bool,
    /// Send final statements to the other genesis.
    pub(crate) distribute: bool,
}

impl DeviceCtx {
    /// The running genesis's context; None on a node that is not one of the five.
    pub(crate) fn of(blockchain: &Arc<BlockchainNode>) -> Option<DeviceCtx> {
        let own_id = ld::own_genesis_id()?;
        let bc = blockchain.clone();
        let storage = blockchain.get_storage();
        let pull_storage = storage.clone();
        let mainnet = ld::is_mainnet();
        Some(DeviceCtx {
            storage,
            own_id,
            sign: Arc::new(move |m: &str| bc.sign_device_message(m).map(|(_, s)| s)),
            ask: Arc::new(|member: String, req: AttestRequest| Box::pin(ask_attestor(member, req))),
            pull: Some(Arc::new(move |node: String, ip: String| {
                let s = pull_storage.clone();
                Box::pin(async move { pull_device_record(&s, GenesisSet::production(), mainnet, &node, &ip).await })
            })),
            oracle: oracle::configured(),
            verifier: Verifier::production(),
            genesis: GenesisSet::production(),
            pins: OraclePins::production(),
            epoch: ld::current_epoch(),
            mainnet,
            distribute: true,
        })
    }

    fn env<'a>(&'a self, now: u64) -> Env<'a> {
        Env { storage: &self.storage, verifier: self.verifier, genesis: self.genesis, pins: self.pins, now, epoch: self.epoch,
              mainnet: self.mainnet }
    }
}

async fn ask_attestor(member: String, req: AttestRequest) -> Option<Value> {
    let ip = crate::genesis_constants::genesis_ip_for_node_id(&member)?;
    let resp = genesis_internal_call_tls(ip, ATTEST_PATH, |c, url| c.post(url).json(&req).timeout(ATTEST_CALL_TIMEOUT)).await.ok()?;
    resp.json().await.ok()
}

/// How the device step ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DeviceOutcome {
    /// The statement is final: recorded here and sent to the other genesis.
    Final(Box<DeviceRecord>),
    /// Refused: nothing written, the binding not taken.
    Refused(StepRefusal),
}

/// The lease the oracle signed, when it verifies here: under the pinned key, for this node and device,
/// fresh.
fn usable_lease(ctx: &DeviceCtx, c: &ClaimAnswer, node: &str, tag: &[u8; 32], now: u64) -> Option<LeaseStatement> {
    if !ctx.pins.verify(&c.lease_statement, &c.oracle_sig, ctx.epoch) { return None; }
    let l = LeaseStatement::parse(&c.lease_statement)?;
    let fresh = l.issued_at <= now + ld::CLOCK_SKEW_SECS && now.saturating_sub(l.issued_at) <= ld::LEASE_MAX_AGE_SECS;
    (l.node == node && &l.device_tag == tag && fresh).then_some(l)
}

/// The oracle's lease, the statement, the attestor round and the record, for a prepared device block.
pub(crate) async fn commit_device(ctx: DeviceCtx, p: PreparedDevice, oracle_timeout: std::time::Duration,
                                  quorum_budget: std::time::Duration) -> DeviceOutcome {
    let now = ld::now_secs();
    let op = p.op();
    let tag = p.device.device_tag();
    let hw_key = p.device.hw_key();
    let reference = p.reference();
    let mut reason = String::new();
    let mut claim: Option<(ClaimAnswer, LeaseStatement)> = None;
    // Owner decision (b): the key served another node of this install whose binding a Stop (or a later
    // binding) released, but whose release never reached a genesis. That record ends before the claim, so
    // neither the attestors nor the oracle hold the key for it any more.
    if let Some(prev) = p.key_node.as_deref().filter(|n| *n != p.node_id && p.rebind_from.as_deref() != Some(*n)) {
        release_stale_holder(&ctx, prev, &hw_key, oracle_timeout).await;
    }
    match (&p.token, ctx.oracle) {
        (None, _) => reason = "token_missing".into(),
        (Some(_), None) => reason = "service_unavailable".into(),
        // No pinned oracle key: no lease could verify here, and the oracle would commit a claim nobody uses.
        (Some(_), Some(_)) if ctx.pins.keys.is_empty() => reason = "service_unavailable".into(),
        (Some(token), Some(o)) => {
            let body = oracle::claim_body(&ClaimInput {
                node_id: &p.node_id, platform: p.device.platform, op, preimage: &p.preimage, hw_pub: &p.device.hw_pub,
                prov: p.device.prov, trust: p.device.trust,
                key_new: p.device.fresh && ctx.storage.device_key_entry(&hw_key).is_none(),
                att_key: p.device.att_key.as_deref(), certs_issued: p.device.certs_issued, att_key_multi: false,
                receipt: p.device.receipt.as_deref(), token, client_ip: p.client_ip.clone(), evidence: p.block.evidence_json(),
            });
            match o.post("/v1/claim", body, oracle_timeout).await {
                Ok(v) => match oracle::read_claim(&v).and_then(|c| usable_lease(&ctx, &c, &p.node_id, &tag, now).map(|l| (c, l))) {
                    Some(c) => claim = Some(c),
                    None => {
                        reason = "lease_unverified".into();
                        if crate::node::is_warn() {
                            println!("[WARN][DEVICE] lease_unverified node={} ref={} (is the oracle key pinned?)", p.node_id, reference);
                        }
                    }
                },
                Err(e) => match e.refusal(now) {
                    Some(r) => return DeviceOutcome::Refused(with_reference(r.into(), &reference)),
                    None => reason = "service_unavailable".into(),
                },
            }
        }
    }
    let lease = claim.as_ref().map(|(_, l)| l.clone());
    if let Some(g) = gate_reason(lease.as_ref()) { reason = g; }
    let mut state = statement::derive_state(lease.as_ref(), op, p.registered);
    if state == DeviceState::Active && claim.as_ref().map_or(false, |(c, _)| c.suspect) { state = DeviceState::Suspect; }
    let fields = StatementFields {
        node: p.node_id.clone(), device_tag: tag, hw_key: hw_key.clone(), platform: p.device.platform, prov: p.device.prov,
        trust: p.device.trust, op, issued_epoch: ctx.epoch, effective_epoch: statement::effective_epoch(lease.as_ref(), op, ctx.epoch),
        state, lease_hash: claim.as_ref().map_or_else(messages::no_lease_hash, |(c, _)| messages::lease_hash(&c.lease_statement, &c.oracle_sig)),
    };
    let req = AttestRequest {
        ingress: ctx.own_id.clone(),
        requested_at: now,
        statement: fields.preimage(),
        wallet: p.wallet.clone(),
        identity_pubkey: p.identity_pk.clone(),
        ping_pubkey: p.ping_pk.clone(),
        delegation_sig: p.delegation_sig.clone(),
        seq: p.seq,
        device: p.raw_block.clone(),
        hw_pub: hex::encode(p.device.hw_pub),
        lease: claim.as_ref().map(|(c, _)| LeaseProof {
            statement: c.lease_statement.clone(), oracle_sig: hex::encode(&c.oracle_sig),
            lease_valid_until: c.lease_valid_until, refresh_at: c.refresh_at,
        }),
        pi_jws: claim.as_ref().and_then(|(c, _)| c.pi_jws.clone()),
        key_node: p.key_node.clone(),
        rotate: None,
    };
    let tail = BundleTail { device: p.device.clone(), rebind_from: p.rebind_from.clone(), nonce: p.block.nonce.clone(), reason };
    attest_and_record(&ctx, req, tail, &p.block, quorum_budget, &reference).await
}

/// What a final statement's bundle carries beside the request.
struct BundleTail {
    device: VerifiedDevice,
    rebind_from: Option<String>,
    nonce: String,
    reason: String,
}

/// A proposed statement's round, from this node's own attestor to the record: signed here with the same
/// checks every other attestor runs, three more signatures collected, the final statement recorded and sent
/// to the other genesis.
async fn attest_and_record(ctx: &DeviceCtx, req: AttestRequest, tail: BundleTail, block: &DeviceBlock,
                           quorum_budget: std::time::Duration, reference: &str) -> DeviceOutcome {
    let now = ld::now_secs();
    let node = StatementFields::parse(&req.statement).map(|f| f.node).unwrap_or_default();
    let own_sig = {
        let env = ctx.env(now);
        match attest::verify_request(&env, &req).and_then(|c| attest::reserve(&env, &c)) {
            Ok(()) => (ctx.sign)(&req.statement),
            Err(r) => {
                let r = with_reference(r, reference);
                file_refusal(ctx.oracle, &node, block, &tail.device, &r);
                return DeviceOutcome::Refused(r);
            }
        }
    };
    if own_sig.is_none() {
        println!("[WARN][DEVICE] statement_not_signed node={} reason=no_pinned_consensus_key", node);
        return DeviceOutcome::Refused(DeviceRefusal::retry(DeviceReason::Stale, 600).into());
    }
    let ask = ctx.ask.clone();
    let asked = req.clone();
    let collected = attest::collect(&req.statement, ctx.genesis, &ctx.own_id, own_sig,
                                    move |m| ask(m, asked.clone()), quorum_budget).await;
    if !collected.is_final() {
        if crate::node::is_info() {
            println!("[INFO][DEVICE] statement_not_final node={} signatures={} refusals={} ref={}", node,
                     collected.sigs.len(), collected.refusals.len(), reference);
        }
        let r = collected.refusal().filter(|_| collected.impossible(ctx.genesis.members.len()))
            .unwrap_or_else(|| DeviceRefusal::retry(DeviceReason::Stale, 60).into());
        let r = with_reference(r, reference);
        file_refusal(ctx.oracle, &node, block, &tail.device, &r);
        return DeviceOutcome::Refused(r);
    }
    let bundle = StatementBundle {
        statement: req.statement.clone(),
        lease: req.lease.clone(),
        sigs: collected.sigs,
        hw_pub: req.hw_pub.clone(),
        seq: req.seq,
        att_key: tail.device.att_key.clone(),
        certs_issued: tail.device.certs_issued,
        serials: tail.device.serials.clone(),
        counter: tail.device.counter as u64,
        rebind_from: tail.rebind_from,
        ingress: ctx.own_id.clone(),
        nonce: tail.nonce,
        reason: tail.reason,
    };
    match store::apply_final(&ctx.storage, &bundle, Some(&ctx.own_id), ctx.genesis, ctx.mainnet, now, ctx.epoch) {
        Ok(Applied::Recorded(r)) => {
            if crate::node::is_info() {
                println!("[INFO][DEVICE] statement_final node={} platform={} prov={} op={} state={} ref={}", r.node_id,
                         r.platform.as_str(), r.prov.as_str(), r.op.as_str(), r.state.as_str(), reference);
            }
            if ctx.distribute { distribute_bundle(bundle); }
            DeviceOutcome::Final(r)
        }
        Ok(Applied::Same) => match ctx.storage.device_record(&node) {
            Some(r) => DeviceOutcome::Final(Box::new(r)),
            None => DeviceOutcome::Refused(DeviceRefusal::retry(DeviceReason::Stale, 60).into()),
        },
        Ok(Applied::Older) => DeviceOutcome::Refused(StepRefusal::Binding(Refusal::StaleSeq)),
        Err(e) => {
            println!("[WARN][DEVICE] statement_not_recorded node={} reason={}", node, e);
            DeviceOutcome::Refused(DeviceRefusal::retry(DeviceReason::Stale, 60).into())
        }
    }
}

/// How the device step looked when `/bind` answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StepAnswer {
    Final(Box<DeviceRecord>),
    /// Still running: the binding is taken with this provisional record.
    Waiting(Box<DeviceRecord>),
    Refused(StepRefusal),
}

/// Run the device step for `/bind` within `budget`. The step itself keeps running after the budget;
/// when it later ends in a refusal, the provisional record keeps waiting with the reason.
pub(crate) async fn run_device_step(ctx: DeviceCtx, p: PreparedDevice, budget: std::time::Duration) -> StepAnswer {
    let now = ld::now_secs();
    let provisional = p.provisional(&ctx.own_id, now, ctx.epoch);
    let (storage, task_storage) = (ctx.storage.clone(), ctx.storage.clone());
    let (node, nonce) = (p.node_id.clone(), p.block.nonce.clone());
    // The oracle gets the time its README asks (a claim can make three vendor round trips): past the
    // answer's budget the binding is taken with the provisional record, and the lease comes after.
    let mut task = tokio::spawn(async move {
        let out = commit_device(ctx, p, oracle::CLAIM_TIMEOUT, QUORUM_BUDGET).await;
        if let DeviceOutcome::Refused(r) = &out {
            store::note_provisional(&task_storage, &node, &nonce, r.as_str(), ld::now_secs());
        }
        out
    });
    match tokio::time::timeout(budget, &mut task).await {
        Ok(Ok(DeviceOutcome::Final(r))) => StepAnswer::Final(r),
        Ok(Ok(DeviceOutcome::Refused(r))) => StepAnswer::Refused(r),
        Ok(Err(_)) => StepAnswer::Refused(DeviceRefusal::retry(DeviceReason::Stale, 60).into()),
        Err(_) => {
            store::write_provisional(&storage, &provisional);
            StepAnswer::Waiting(Box::new(provisional))
        }
    }
}

// ---- A3: the attestor round (node_attestDevice) ----

/// What this genesis's attestor answers a request: the signature, or the stated refusal. A request resting on
/// a record this node lacks or holds behind the ingress's (a statement that never reached it: the known key's,
/// or for a rotation the one it rotates from, `attest::rotation_rests_on`) is retried once after pulling that
/// record from the ingress.
pub(crate) async fn attest_answer(ctx: &DeviceCtx, req: &AttestRequest) -> Value {
    let now = ld::now_secs();
    let mut checked = { let env = ctx.env(now); attest::verify_request(&env, req) };
    let healable = match &checked {
        Err(StepRefusal::Device(d)) => d.reason == DeviceReason::NotGenuine
            // A rotation from a record here without a lease: a statement with the vendor token never came.
            || (req.rotate.is_some() && d.reason == DeviceReason::Stale),
        // A rotation from a record here at another sequence or key (`check_rotation`).
        Err(StepRefusal::Binding(Refusal::StaleSeq)) => req.rotate.is_some(),
        _ => false,
    };
    if let (true, Some(key_node)) = (healable, &req.key_node) {
        // The record the request rests on: the one holding the known key (for a rebind the live record it
        // leaves), or for a rotation the one it rotates from. A record here that is it already is not healed
        // by a pull (the refusal is the request's).
        let rebind = req.device.get("rebind_from").is_some();
        let missing = ctx.storage.device_record(key_node).map_or(true, |r| match &req.rotate {
            Some(rot) => !attest::rotation_rests_on(&r, &rot.old_key, req.seq),
            None => r.provisional || r.hw_pub != req.hw_pub || (rebind && !r.live()),
        });
        let ip = crate::genesis_constants::genesis_ip_for_node_id(&req.ingress);
        if let (true, Some(pull), Some(ip)) = (missing, &ctx.pull, ip) {
            if pull(key_node.clone(), ip.to_string()).await {
                let env = ctx.env(now);
                checked = attest::verify_request(&env, req);
            }
        }
    }
    let signed = checked.and_then(|c| {
        let env = ctx.env(now);
        attest::reserve(&env, &c)
    }).and_then(|()| (ctx.sign)(&req.statement).ok_or_else(|| DeviceRefusal::retry(DeviceReason::Stale, 600).into()));
    match signed {
        Ok(sig) => attest::signed_answer(&ctx.own_id, &sig),
        Err(r) => {
            if crate::node::is_info() {
                println!("[INFO][DEVICE] attest_refused ingress={} reason={}", req.ingress, r.as_str());
            }
            json!({ "success": false, "reason": r.as_str() })
        }
    }
}

/// `POST /api/v1/internal/light-device-attest`: the other genesis nodes only, each for itself (the ingress
/// the request names must be the caller).
pub(super) async fn handle_internal_device_attest(
    remote_addr: Option<std::net::SocketAddr>,
    req: AttestRequest,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    let caller = remote_addr.map(|a| a.ip().to_string()).unwrap_or_default();
    let named = crate::genesis_constants::genesis_ip_for_node_id(&req.ingress);
    if !is_genesis_peer_ip(&caller) || named != Some(caller.as_str()) {
        return Ok(warp::reply::with_status(warp::reply::json(&json!({"success": false, "reason": "unauthorized"})),
                                           warp::http::StatusCode::FORBIDDEN));
    }
    if !ATTEST_INGRESS_LIMIT.allows(&req.ingress, ld::now_secs()) {
        return Ok(warp::reply::with_status(warp::reply::json(&Refusal::RateLimited.to_json()), warp::http::StatusCode::OK));
    }
    let Some(ctx) = DeviceCtx::of(&blockchain) else {
        return Ok(warp::reply::with_status(warp::reply::json(&json!({"success": false, "reason": "not_attestor"})),
                                           warp::http::StatusCode::OK));
    };
    Ok(warp::reply::with_status(warp::reply::json(&attest_answer(&ctx, &req).await), warp::http::StatusCode::OK))
}

// ---- A6: the record sync and its pull-heal ----

/// What a genesis sends another: a final statement's bundle, or a signed state change.
#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
pub(crate) struct DeviceSync {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) bundle: Option<StatementBundle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) change: Option<StateChange>,
}

/// Apply what a peer sent: every signature re-verified here, nothing taken on the sender's word.
pub(crate) fn apply_sync(storage: &crate::storage::Storage, genesis: &GenesisSet, mainnet: bool, s: &DeviceSync,
                         own_id: Option<&str>, now: u64, epoch: u64) -> Result<&'static str, &'static str> {
    let mut outcome = "nothing";
    if let Some(b) = &s.bundle {
        outcome = match store::apply_final(storage, b, own_id, genesis, mainnet, now, epoch)? {
            Applied::Recorded(_) => "recorded",
            Applied::Same => "same",
            Applied::Older => "older",
        };
    }
    if let Some(c) = &s.change {
        outcome = match store::apply_change(storage, c, genesis, now, epoch)? {
            true => "changed",
            // A change of a statement this node never recorded (it missed a re-link, a rotation, an enrolment
            // with the token): the sender's route pulls it (`handle_internal_device_sync`).
            false if store::names_unknown_statement(storage, c) => "unknown_statement",
            false => "not_newer",
        };
    }
    Ok(outcome)
}

/// Pull `node`'s record from the genesis at `ip` that just sent a change of a statement this node lacks
/// (`apply_sync` answered `unknown_statement` or `no_record`): once per (node, statement) per ten minutes,
/// a few at a time. The sender's resends and the statement's own stop after an hour; without this a genesis
/// down longer never learns the statement from later changes, and refuses the node's rotations.
fn pull_for_unknown_statement(storage: Arc<crate::storage::Storage>, node: String, stmt_hash: String, ip: String) {
    fn recent() -> &'static dashmap::DashMap<(String, String), u64> {
        static M: std::sync::OnceLock<dashmap::DashMap<(String, String), u64>> = std::sync::OnceLock::new();
        M.get_or_init(dashmap::DashMap::new)
    }
    fn permits() -> &'static Arc<tokio::sync::Semaphore> {
        static S: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
        S.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(8)))
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else { return; };
    let now = ld::now_secs();
    if recent().len() > 65_536 { recent().clear(); }
    let key = (node.clone(), stmt_hash);
    if recent().get(&key).map_or(false, |at| now.saturating_sub(*at) < 600) { return; }
    let Ok(permit) = permits().clone().try_acquire_owned() else { return; };
    recent().insert(key, now);
    handle.spawn(async move {
        let _permit = permit;
        pull_device_record(&storage, GenesisSet::production(), ld::is_mainnet(), &node, &ip).await;
    });
}

/// `POST /api/v1/internal/light-device-sync`: the other genesis nodes only.
pub(super) async fn handle_internal_device_sync(
    remote_addr: Option<std::net::SocketAddr>,
    body: DeviceSync,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    let caller = remote_addr.map(|a| a.ip().to_string()).unwrap_or_default();
    if !is_genesis_peer_ip(&caller) {
        return Ok(warp::reply::with_status(warp::reply::json(&json!({"success": false, "reason": "unauthorized"})),
                                           warp::http::StatusCode::FORBIDDEN));
    }
    let storage = blockchain.get_storage();
    let own = ld::own_genesis_id();
    let outcome = apply_sync(&storage, GenesisSet::production(), ld::is_mainnet(), &body, own.as_deref(), ld::now_secs(), ld::current_epoch());
    if let (Ok("unknown_statement") | Err("no_record"), Some(c)) = (&outcome, &body.change) {
        pull_for_unknown_statement(storage.clone(), c.node_id.clone(), c.stmt_hash.clone(), caller.clone());
    }
    match outcome {
        Ok(o) => Ok(warp::reply::with_status(warp::reply::json(&json!({"success": true, "applied": o})), warp::http::StatusCode::OK)),
        Err(e) => {
            if crate::node::is_warn() {
                println!("[WARN][DEVICE] device_sync_refused from={} reason={}", caller, e);
            }
            Ok(warp::reply::with_status(warp::reply::json(&json!({"success": false, "reason": e})), warp::http::StatusCode::BAD_REQUEST))
        }
    }
}

/// `GET /api/v1/internal/light-device-get?node_id=N`: a node's record with its signed last change, the
/// statement's ingress and, at that ingress, the statement's full proof. The other genesis nodes only.
pub(super) async fn handle_internal_device_get(
    remote_addr: Option<std::net::SocketAddr>,
    params: HashMap<String, String>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    let caller = remote_addr.map(|a| a.ip().to_string()).unwrap_or_default();
    if !is_genesis_peer_ip(&caller) {
        return Ok(warp::reply::with_status(warp::reply::json(&json!({"success": false, "reason": "unauthorized"})),
                                           warp::http::StatusCode::FORBIDDEN));
    }
    let node = params.get("node_id").map(|s| s.as_str()).unwrap_or("");
    let storage = blockchain.get_storage();
    Ok(warp::reply::with_status(warp::reply::json(&device_get_answer(&storage, node)), warp::http::StatusCode::OK))
}

/// A node's record as a genesis serves it to another: its signed last change, its statement hash, the
/// genesis that took the statement (`ingress`, the only one keeping its full proof) and, at that genesis,
/// the proof itself.
pub(crate) fn device_get_answer(storage: &crate::storage::Storage, node: &str) -> Value {
    match storage.device_record(node).filter(|r| !r.provisional) {
        Some(r) => json!({ "success": true, "change": r.last_change, "stmt_hash": r.stmt_hash, "ingress": r.ingress,
                           "bundle": storage.device_bundle(node) }),
        None => json!({ "success": false, "reason": "not_found" }),
    }
}

/// Apply what a genesis served for a node (`device_get_answer`): the bundle, then the signed last change,
/// each re-verified here. True when something new was recorded.
fn apply_get_answer(storage: &crate::storage::Storage, genesis: &GenesisSet, mainnet: bool, v: &Value, own: Option<&str>,
                    now: u64, epoch: u64) -> bool {
    let bundle: Option<StatementBundle> = v.get("bundle").cloned().and_then(|b| serde_json::from_value(b).ok());
    let change: Option<StateChange> = v.get("change").cloned().and_then(|c| serde_json::from_value(c).ok());
    let mut got = false;
    if bundle.is_some() {
        let only = DeviceSync { bundle, change: None };
        got |= matches!(apply_sync(storage, genesis, mainnet, &only, own, now, epoch), Ok("recorded"));
    }
    if change.is_some() {
        let only = DeviceSync { bundle: None, change };
        got |= matches!(apply_sync(storage, genesis, mainnet, &only, own, now, epoch), Ok("changed"));
    }
    got
}

/// The genesis to ask for the statement's proof when the answer `v` carries none and this node lacks the
/// record it names: the statement's ingress, which alone keeps it, unless that is this node or the one just
/// asked.
fn proof_holder(storage: &crate::storage::Storage, node: &str, v: &Value, asked: &str, own: Option<&str>) -> Option<String> {
    if v["success"].as_bool() != Some(true) || !v["bundle"].is_null() { return None; }
    let stmt = v["stmt_hash"].as_str().filter(|s| !s.is_empty())?;
    if storage.device_record(node).map_or(false, |r| !r.provisional && r.stmt_hash == stmt) { return None; }
    let ingress = v["ingress"].as_str().filter(|i| Some(*i) != own && *i != asked)?;
    Some(ingress.to_string())
}

/// Pull a node's record from the genesis `from` and apply what verifies. A genesis other than the
/// statement's ingress keeps no proof: its answer names the ingress, which is asked next, and the first
/// answer's change is applied again once the record is there (it may be newer than the ingress's). `fetch`
/// asks a genesis by its id for its answer. True when something new was recorded.
pub(crate) async fn pull_device_record_via<F, Fut>(storage: &crate::storage::Storage, genesis: &GenesisSet, mainnet: bool,
                                                   own: Option<&str>, node: &str, from: &str, fetch: F) -> bool
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Option<Value>>,
{
    if !messages::is_device_node_id(node) { return false; }
    let Some(v) = fetch(from.to_string()).await else { return false; };
    let now = ld::now_secs();
    let epoch = ld::current_epoch();
    let mut got = apply_get_answer(storage, genesis, mainnet, &v, own, now, epoch);
    let mut source = from.to_string();
    if let Some(holder) = proof_holder(storage, node, &v, from, own) {
        if let Some(w) = fetch(holder.clone()).await {
            if apply_get_answer(storage, genesis, mainnet, &w, own, now, epoch) {
                got = true;
                source = holder;
                got |= apply_get_answer(storage, genesis, mainnet, &json!({ "change": v["change"] }), own, now, epoch);
            }
        }
    }
    if crate::node::is_info() {
        println!("[INFO][DEVICE] device_record_pulled node={} from={} recorded={}", node, source, got);
    }
    got
}

/// `pull_device_record_via` over the genesis-only internal route, starting at the genesis at `from_ip`.
pub(crate) async fn pull_device_record(storage: &crate::storage::Storage, genesis: &GenesisSet, mainnet: bool,
                                       node: &str, from_ip: &str) -> bool {
    let Some(from) = crate::genesis_constants::GENESIS_NODE_IPS.iter().find(|(ip, _)| *ip == from_ip)
        .map(|(_, id)| format!("genesis_node_{}", id)) else { return false; };
    let path = format!("/api/v1/internal/light-device-get?node_id={}", node);
    let own = ld::own_genesis_id();
    pull_device_record_via(storage, genesis, mainnet, own.as_deref(), node, &from, |id: String| {
        let path = path.clone();
        async move {
            let ip = crate::genesis_constants::genesis_ip_for_node_id(&id)?;
            let r = genesis_internal_call_tls(ip, &path, |c, url| c.get(url)).await.ok().filter(|r| r.status().is_success())?;
            r.json::<Value>().await.ok()
        }
    }).await
}

/// When a genesis that missed a statement or a change is asked again: soon (a restart), then across a
/// rolling upgrade of the five. Past these the delivery waits in the persisted outbox (`resend_outbox`).
const DISTRIBUTE_RETRY_SECS: [u64; 3] = [15, 120, 600];
/// How often the outbox is sent again, and how long a delivery nobody takes is kept.
pub(crate) const OUTBOX_RESEND_SECS: u64 = 600;
pub(crate) const OUTBOX_KEEP_SECS: u64 = 7 * 86_400;

/// The outbox row of a delivery: (node, kind) of its bundle ("b") or change ("c").
fn outbox_slot(body: &DeviceSync) -> Option<(String, &'static str)> {
    if let Some(b) = &body.bundle {
        return messages::StatementFields::parse(&b.statement).map(|f| (f.node, "b"));
    }
    body.change.as_ref().map(|c| (c.node_id.clone(), "c"))
}

/// Send `body` to every other genesis, again on `DISTRIBUTE_RETRY_SECS` to those that did not take it. A
/// genesis that has not taken it at once gets it queued in the persisted outbox, which is sent again until it
/// does, across restarts: a pause or an end missed past the last resend was never learned, because only a
/// refusal triggers a pull and a genesis behind in the lenient direction refuses nothing (ND-5).
fn distribute(body: DeviceSync, what: &'static str) {
    let Ok(handle) = tokio::runtime::Handle::try_current() else { return; };
    let storage = crate::node::try_get_storage().cloned();
    handle.spawn(async move {
        let our_ip = our_genesis_ip();
        let mut missed: Vec<&str> = crate::genesis_constants::GENESIS_NODE_IPS.iter().map(|(ip, _)| *ip)
            .filter(|ip| *ip != our_ip).collect();
        let queued_at = ld::now_secs();
        let slot = outbox_slot(&body);
        let value = serde_json::to_value(&body).unwrap_or_default();
        for (round, wait) in std::iter::once(0).chain(DISTRIBUTE_RETRY_SECS).enumerate() {
            if missed.is_empty() { break; }
            if wait > 0 { tokio::time::sleep(std::time::Duration::from_secs(wait)).await; }
            let mut still = Vec::new();
            for ip in missed {
                let ok = genesis_internal_call_tls(ip, SYNC_PATH, |c, url| c.post(url).json(&body)).await
                    .map_or(false, |r| r.status().is_success());
                if let (Some(s), Some((node, kind))) = (storage.as_ref(), slot.as_ref()) {
                    let key = format!("o:{}:{}:{}", ip, node, kind);
                    if ok && round > 0 {
                        s.device_outbox_done(&key, queued_at);
                    } else if !ok && round == 0 {
                        let _ = s.device_outbox_put(ip, node, kind, &value, queued_at);
                    }
                }
                if !ok { still.push(ip); }
            }
            missed = still;
        }
        if crate::node::is_warn() {
            for ip in missed {
                println!("[WARN][DEVICE] device_sync_queued ip={} what={}", ip, what);
            }
        }
    });
}

/// Send every queued delivery again (`distribute`), dropping each one its genesis took and each one older
/// than `OUTBOX_KEEP_SECS`. `send` posts a body to a genesis address and says whether it was taken.
pub(crate) async fn resend_outbox<F, Fut>(storage: &crate::storage::Storage, now: u64, send: F) -> (usize, usize)
where
    F: Fn(String, Value) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let (mut taken, mut dropped) = (0, 0);
    for (key, ip, at, body) in storage.device_outbox(2_000) {
        if now.saturating_sub(at) > OUTBOX_KEEP_SECS {
            storage.device_outbox_done(&key, at);
            dropped += 1;
            continue;
        }
        if send(ip, body).await {
            storage.device_outbox_done(&key, at);
            taken += 1;
        }
    }
    (taken, dropped)
}

pub(crate) fn distribute_bundle(bundle: StatementBundle) {
    distribute(DeviceSync { bundle: Some(bundle), change: None }, "statement");
}

pub(crate) fn distribute_change(change: StateChange) {
    distribute(DeviceSync { bundle: None, change: Some(change) }, "state_change");
}

/// A state change this genesis causes on the record `r` (a refresh's outcome, a release, a pause): signed
/// with its consensus key, applied here and sent to the other genesis. `lease_window` is the lease a
/// refresh renewed (valid until, refresh at). None when this node cannot sign or the record moved on.
pub(crate) fn cause_change(ctx: &DeviceCtx, r: &DeviceRecord, state: DeviceState, until_epoch: u64, reason: &str,
                           lease_window: Option<(u64, u64)>) -> Option<StateChange> {
    let mut c = StateChange::of(r, state, until_epoch, reason, &ctx.own_id);
    if let Some((valid_until, refresh_at)) = lease_window {
        c.lease_valid_until = Some(valid_until);
        c.refresh_at = Some(refresh_at);
    }
    c.sig = (ctx.sign)(&c.preimage())?;
    match store::apply_change(&ctx.storage, &c, ctx.genesis, ld::now_secs(), ctx.epoch) {
        Ok(true) => {
            if crate::node::is_info() {
                println!("[INFO][DEVICE] state_changed node={} state={} state_seq={} until_epoch={} reason={}", c.node_id,
                         c.state.as_str(), c.state_seq, c.until_epoch, c.reason);
            }
            if ctx.distribute { distribute_change(c.clone()); }
            Some(c)
        }
        _ => None,
    }
}

/// The epoch a timed pause the record runs ends in, or 0: an end of the record keeps it (a Stop does not end
/// a pause). A revocation has no epoch: a new enrolment's chain meets the list.
fn running_pause(r: &DeviceRecord, epoch: u64) -> u64 {
    if r.state == DeviceState::Paused { r.pause_until(epoch) } else { 0 }
}

/// A refusal of the device routes that carries the record's pause.
fn paused_refusal(r: &DeviceRecord) -> StepRefusal {
    StepRefusal::Device(r.pause_refusal())
}

/// Why a statement's device waits in `check_pending` when its lease names a multiplicity gate over its
/// bound (its ingress then rechecks it daily).
fn gate_reason(lease: Option<&LeaseStatement>) -> Option<String> {
    lease.map(|l| l.gate).filter(|g| g.is_high()).map(|g| g.as_str().to_string())
}

/// The answer of a device message whose stamp this genesis issued, kept for as long as its challenge lives,
/// or the stamp's refusal (never kept: a request with a stamp that does not verify must not decide the
/// answer the real one gets).
fn stamped(ctx: &DeviceCtx, node: &str, purpose: Purpose, nonce: &str, stamp: &str, now: u64) -> Result<(), Value> {
    let ok = messages::nonce32(nonce).is_some() && !stamp.is_empty() && stamp.len() <= 512
        && ld::stamp::verify(&ctx.own_id, node, purpose, nonce, stamp, now);
    if ok { Ok(()) } else { Err(StepRefusal::device(DeviceReason::Stale).to_json()) }
}

fn not_served() -> Value {
    json!({ "success": false, "reason": "not_served", "error": "Only genesis nodes serve the device layer" })
}

// ---- owner decision (b): a key a released binding still holds ----

/// End the record of `prev`, which this install's key `hw_key` served, when that binding was released here
/// (a Stop withdrew it, or a later binding replaced it) and its own release never came; and tell the oracle
/// to forget the key for it (idempotent there). The oracle takes the release message from a genesis; the
/// device's evidence for the new binding has just been verified.
async fn release_stale_holder(ctx: &DeviceCtx, prev: &str, hw_key: &str, timeout: std::time::Duration) {
    let Some(r) = ctx.storage.device_record(prev).filter(|r| !r.provisional && r.hw_key == hw_key) else { return; };
    if r.live() && !attest::binding_released(&ctx.storage, &r) { return; }
    // A pause holds the device it paused: nothing is released while it runs (`attest::admit` refuses the
    // new binding with that pause, and the oracle keeps its hold).
    if r.paused_at(ctx.epoch) || r.pause_until(ctx.epoch) > 0 { return; }
    if r.live() {
        cause_change(ctx, &r, DeviceState::Ended, running_pause(&r, ctx.epoch), "released", None);
    }
    if let Some(o) = ctx.oracle {
        let nonce = {
            use rand::RngCore;
            let mut n = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut n);
            messages::b64url(&n)
        };
        let body = oracle::release_body(prev, r.platform, &messages::release_preimage(prev, r.seq, &nonce), None);
        if let Err(oracle::OracleError::Unavailable(why)) = o.post("/v1/release", body, timeout).await {
            if crate::node::is_warn() {
                println!("[WARN][DEVICE] stale_holder_release_failed node={} reason={}", prev, why);
            }
        }
    }
    if crate::node::is_info() {
        println!("[INFO][DEVICE] stale_holder_released node={}", prev);
    }
}

// ---- A9: the lease refresh ----

/// `POST /api/v1/light-node/device-refresh` (section 5.6); the same object rides in a ping reply as the
/// parameter `device_refresh`. `token`: DeviceCheck on iOS, Play Integrity on Android, null when the
/// device's vendor call failed.
#[derive(Default, Clone, serde::Deserialize)]
pub(crate) struct RefreshRequest {
    #[serde(default)] pub(crate) node_id: String,
    #[serde(default)] pub(crate) nonce: String,
    #[serde(default)] pub(crate) stamp: String,
    #[serde(default)] pub(crate) sig: String,
    #[serde(default)] pub(crate) token: Option<String>,
}

impl std::fmt::Debug for RefreshRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RefreshRequest").field("node_id", &self.node_id).field("token", &self.token.is_some()).finish_non_exhaustive()
    }
}

/// Refreshes one node may make per day: one per window, and the retries of its wakes inside it.
static REFRESH_NODE_LIMIT: KeyedLimiter = KeyedLimiter::new(24, 86_400);
/// Rotations one node may try per day (the app tries at most every six hours).
static ROTATE_NODE_LIMIT: KeyedLimiter = KeyedLimiter::new(8, 86_400);

/// A refresh checked here alone (its stamp already verified): the record and the device's signature
/// under its key, the counter above the last one taken.
pub(crate) fn prepare_refresh(storage: &crate::storage::Storage, verifier: &Verifier, req: &RefreshRequest)
    -> Result<(DeviceRecord, String, Option<u64>), StepRefusal>
{
    let sig = messages::b64url_decode(&req.sig).filter(|s| !s.is_empty() && s.len() <= 1024)
        .ok_or(StepRefusal::Binding(Refusal::BadRequest))?;
    if !storage.is_node_registration_onchain(&req.node_id) { return Err(StepRefusal::Binding(Refusal::NotRegistered)); }
    let rec = ld::ping::governing_record(storage, &req.node_id).filter(|r| r.live())
        .ok_or(StepRefusal::Binding(Refusal::StaleSeq))?;
    if rec.provisional { return Err(DeviceRefusal::retry(DeviceReason::Stale, 600).into()); }
    let hw_pub = rec.hw_pub_bytes().ok_or(StepRefusal::Binding(Refusal::StaleSeq))?;
    let preimage = messages::refresh_preimage(&req.node_id, &req.nonce);
    let counter = verifier.verify_known_key(rec.platform, &hw_pub, &sig, &preimage, store::last_counter(storage, &rec))
        .map_err(|e| if e.reason == DeviceReason::Stale { StepRefusal::device(DeviceReason::Stale) } else { StepRefusal::Binding(Refusal::BadSignature) })?;
    let counter = (rec.platform == Platform::Ios).then_some(counter as u64);
    Ok((rec, preimage, counter))
}

/// The refresh at the oracle and its outcome as a state change here and at every genesis. The record's
/// lease window moves to what the oracle keeps now; a pause the oracle states starts, and a running one is
/// never lifted.
pub(crate) async fn commit_refresh(ctx: &DeviceCtx, rec: DeviceRecord, preimage: String, counter: Option<u64>,
                                   token: Option<String>, timeout: std::time::Duration) -> Result<DeviceRecord, StepRefusal> {
    let now = ld::now_secs();
    // Only a statement's lease is renewed: a record without one never becomes creditable by a refresh.
    if rec.lease.is_none() { return Err(StepRefusal::device(DeviceReason::Stale)); }
    if let Some(c) = counter {
        if !store::take_counter(&ctx.storage, &rec.hw_key, c) { return Err(StepRefusal::device(DeviceReason::Stale)); }
    }
    let token = token.filter(|t| oracle::token_shape_ok(t)).ok_or_else(|| StepRefusal::from(DeviceRefusal::retry(DeviceReason::Stale, 600)))?;
    let o = ctx.oracle.ok_or_else(|| StepRefusal::from(DeviceRefusal::retry(DeviceReason::Stale, 600)))?;
    let body = oracle::refresh_body(&rec.node_id, rec.platform, &preimage, &token);
    let a = match o.post("/v1/refresh", body, timeout).await {
        Ok(v) => oracle::read_refresh(&v).ok_or_else(|| StepRefusal::from(DeviceRefusal::retry(DeviceReason::Stale, 600)))?,
        Err(e) => return Err(e.refusal(now).map(StepRefusal::from)
            .unwrap_or_else(|| DeviceRefusal::retry(DeviceReason::Stale, 600).into())),
    };
    // The change goes on the record as it is now, if it is still the same statement's.
    let cur = ctx.storage.device_record(&rec.node_id).filter(|r| r.stmt_hash == rec.stmt_hash && !r.provisional && r.live())
        .ok_or(StepRefusal::Binding(Refusal::StaleSeq))?;
    let running = running_pause(&cur, ctx.epoch);
    let (state, until, reason) = if a.state == DeviceState::Paused {
        let until = ld::epoch_at(a.paused_until, now, ctx.epoch).max(running);
        let reason = a.reason.clone().unwrap_or_else(|| if a.result == "hold" { "hold".into() } else { "two_strikes".into() });
        (DeviceState::Paused, until, reason)
    } else if running > 0 {
        (DeviceState::Paused, running, cur.reason.clone())
    } else {
        (a.state, 0, a.reason.clone().unwrap_or_else(|| "refresh_ok".into()))
    };
    let lease = (a.lease_valid_until > 0).then_some((a.lease_valid_until, a.refresh_at));
    if cause_change(ctx, &cur, state, until, &reason, lease).is_none() {
        return Err(DeviceRefusal::retry(DeviceReason::Stale, 60).into());
    }
    if crate::node::is_info() {
        println!("[INFO][DEVICE] refreshed node={} result={} state={}", rec.node_id, a.result, state.as_str());
    }
    ctx.storage.device_record(&rec.node_id).ok_or(StepRefusal::Binding(Refusal::StaleSeq))
}

/// What a device message's answer says about the record after it: `success` when the device counts now.
fn record_answer(ctx: &DeviceCtx, r: &DeviceRecord, now: u64) -> Value {
    let state = r.state_now(ctx.storage.is_node_registration_onchain(&r.node_id), ctx.epoch, now);
    let mut v = json!({ "success": state.counts(), "node_id": r.node_id, "device_state": state.as_str(),
                        "effective_epoch": r.effective_epoch, "rotation_due": r.rotation_due_epoch });
    if state == DeviceState::Paused {
        v = paused_refusal(r).to_json();
        v["device_state"] = state.as_str().into();
    } else if let Some(reference) = r.reference().filter(|_| !state.counts()) {
        v["ref"] = reference.into();
    }
    v
}

/// A refresh from its request to its answer.
pub(crate) async fn run_refresh(ctx: &DeviceCtx, req: &RefreshRequest, now: u64) -> Value {
    if !messages::is_device_node_id(&req.node_id) { return Refusal::BadRequest.to_json(); }
    if let Some(a) = DEVICE_ANSWERS.get(&req.node_id, &req.nonce, now) { return a; }
    if let Err(v) = stamped(ctx, &req.node_id, Purpose::Refresh, &req.nonce, &req.stamp, now) { return v; }
    let answer = match prepare_refresh(&ctx.storage, ctx.verifier, req) {
        Err(r) => r.to_json(),
        // A pause holds the record (the oracle's lease says the same): nothing to renew, and a refresh never
        // lifts it. A revocation's pause waits for a new enrolment. A statement that carried no lease
        // (no token, the oracle out, a lease that did not verify) has nothing to renew either: the oracle
        // would refresh whatever it holds for the node, maybe a previous device's, and a key never claimed
        // there would count. It waits for an enrolment with the token (owner decision (a)).
        Ok((rec, _, _)) if rec.lease.is_none() || rec.paused_at(ctx.epoch)
            || rec.state_now(true, ctx.epoch, now) == DeviceState::Paused => record_answer(ctx, &rec, now),
        Ok(_) if !REFRESH_NODE_LIMIT.allows(&req.node_id, now) => Refusal::RateLimited.to_json(),
        Ok((rec, preimage, counter)) => match commit_refresh(ctx, rec, preimage, counter, req.token.clone(), oracle::BACKGROUND_CALL_TIMEOUT).await {
            Ok(r) => record_answer(ctx, &r, now),
            Err(r) => {
                if crate::node::is_info() {
                    println!("[INFO][DEVICE] refresh_refused node={} reason={}", req.node_id, r.as_str());
                }
                r.to_json()
            }
        },
    };
    DEVICE_ANSWERS.put(&req.node_id, &req.nonce, answer.clone(), now);
    answer
}

/// `POST /api/v1/light-node/device-refresh`, at the genesis that issued the refresh challenge.
pub(super) async fn handle_light_device_refresh(
    req: RefreshRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if check_api_rate_limit(remote_addr, "light_device_refresh").is_err() {
        return Ok(warp::reply::json(&Refusal::RateLimited.to_json()));
    }
    let Some(ctx) = DeviceCtx::of(&blockchain) else { return Ok(warp::reply::json(&not_served())); };
    Ok(warp::reply::json(&run_refresh(&ctx, &req, ld::now_secs()).await))
}

/// The `device_refresh` parameter of a verified ping reply (b64url of the refresh object): run in the
/// background at this genesis only, never relayed.
pub(crate) fn refresh_from_ping(blockchain: &Arc<BlockchainNode>, node_id: &str, param: &str) {
    let Some(req) = messages::b64url_decode(param).filter(|b| b.len() <= 24 * 1024)
        .and_then(|b| serde_json::from_slice::<RefreshRequest>(&b).ok()) else { return; };
    let (Some(ctx), Ok(handle)) = (DeviceCtx::of(blockchain), tokio::runtime::Handle::try_current()) else { return; };
    let req = RefreshRequest { node_id: node_id.to_string(), ..req };
    handle.spawn(async move {
        let _ = run_refresh(&ctx, &req, ld::now_secs()).await;
    });
}

// ---- A10: the key rotation (every 30 days) ----

/// `POST /api/v1/light-node/device-rotate` (section 5.4). Its `Debug` shows no token and no evidence.
#[derive(Default, Clone, serde::Deserialize)]
pub(crate) struct RotateRequest {
    #[serde(default)] pub(crate) node_id: String,
    #[serde(default)] pub(crate) seq: u64,
    /// hex(sha3(old hw_pub)).
    #[serde(default)] pub(crate) old_key: String,
    /// The new key's block of section 5.3 with the rotation challenge's nonce and stamp.
    #[serde(default)] pub(crate) device: Option<Value>,
    #[serde(default)] pub(crate) old_sig: String,
    #[serde(default)] pub(crate) dc_token: Option<String>,
    #[serde(default)] pub(crate) pi_token: Option<String>,
}

impl std::fmt::Debug for RotateRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RotateRequest").field("node_id", &self.node_id).field("seq", &self.seq)
            .field("device", &self.device.is_some()).finish_non_exhaustive()
    }
}

/// A rotation checked here alone (its stamp already verified): the binding, the record holding the old key,
/// the old key's signature and the new key's evidence over the rotation preimage, and the new key free.
#[derive(Clone)]
pub(crate) struct PreparedRotation {
    pub(crate) node_id: String,
    pub(crate) seq: u64,
    pub(crate) wallet: String,
    pub(crate) identity_pk: String,
    pub(crate) ping_pk: String,
    pub(crate) delegation_sig: String,
    pub(crate) raw_block: Value,
    pub(crate) block: DeviceBlock,
    pub(crate) device: VerifiedDevice,
    pub(crate) old: DeviceRecord,
    pub(crate) old_sig: String,
    pub(crate) preimage: String,
    pub(crate) token: Option<String>,
    pub(crate) registered: bool,
}

impl std::fmt::Debug for PreparedRotation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedRotation").field("node_id", &self.node_id).field("seq", &self.seq)
            .field("platform", &self.device.platform).field("token", &self.token.is_some()).finish_non_exhaustive()
    }
}

pub(crate) fn prepare_rotation(storage: &crate::storage::Storage, verifier: &Verifier, req: &RotateRequest, block: DeviceBlock,
                               now: u64, epoch: u64) -> Result<PreparedRotation, StepRefusal> {
    if req.seq == 0 || !messages::is_hex64(&req.old_key) || req.old_sig.is_empty() || req.old_sig.len() > 1400 {
        return Err(StepRefusal::Binding(Refusal::BadRequest));
    }
    if !storage.is_node_registration_onchain(&req.node_id) { return Err(StepRefusal::Binding(Refusal::NotRegistered)); }
    let row = storage.get_light_binding(&req.node_id).filter(|b| b.v2 && b.device_bound() && b.seq == req.seq)
        .ok_or(StepRefusal::Binding(Refusal::StaleSeq))?;
    let delegation_sig = match lb::parse_cert(&row.cert) {
        Some(lb::CertForm::V2 { seq, sig }) if seq == req.seq => sig.to_string(),
        _ => return Err(StepRefusal::Binding(Refusal::StaleSeq)),
    };
    let identity_pk = storage.resolve_light_identity_pk(&req.node_id, Some(&row.identity_pubkey))
        .filter(|k| row.identity_pubkey.is_empty() || k.eq_ignore_ascii_case(&row.identity_pubkey))
        .ok_or(StepRefusal::Binding(Refusal::IdentityMismatch))?;
    let wallet = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(&identity_pk)
        .ok_or(StepRefusal::Binding(Refusal::IdentityMismatch))?;
    let old = ld::ping::governing_record(storage, &req.node_id).filter(|r| !r.provisional && r.live())
        .ok_or(StepRefusal::Binding(Refusal::StaleSeq))?;
    if old.seq != req.seq || old.hw_key != req.old_key { return Err(StepRefusal::Binding(Refusal::StaleSeq)); }
    if old.paused_at(epoch) { return Err(paused_refusal(&old)); }
    if epoch < old.rotation_due_epoch {
        return Err(DeviceRefusal::retry(DeviceReason::RateLimited, (old.rotation_due_epoch - epoch) * ld::EPOCH_BLOCKS).into());
    }
    let env = Env { storage, verifier, genesis: GenesisSet::production(), pins: OraclePins::production(), now, epoch,
                    mainnet: verifier.policies.mainnet };
    let proof = attest::RotateProof { old_key: req.old_key.clone(), old_sig: req.old_sig.clone() };
    let pp_sha3 = lb::sha3_hex(&hex::decode(&row.ping_pubkey).map_err(|_| StepRefusal::Binding(Refusal::StaleSeq))?);
    let (preimage, _) = attest::check_rotation(&env, &req.node_id, req.seq, &pp_sha3, &proof, &block.nonce)?;
    let device = verifier.verify_new_key(&block, &preimage, now).map_err(|r| {
        if crate::node::is_info() {
            println!("[INFO][DEVICE] rotation_evidence_refused node={} platform={} reason={} code={}", req.node_id,
                     block.platform.as_str(), r.reason.as_str(), r.code);
        }
        StepRefusal::device(r.reason)
    })?;
    if device.platform != old.platform || device.platform != block.platform { return Err(StepRefusal::device(DeviceReason::NotGenuine)); }
    if device.hw_key() == old.hw_key { return Err(StepRefusal::Binding(Refusal::BadRequest)); }
    let reference = messages::reference(&block.nonce_bytes(), &device.device_tag());
    if env.mainnet && device.trust == Trust::Test {
        return Err(with_reference(StepRefusal::device(DeviceReason::AppUnrecognized), &reference));
    }
    attest::admit(&env, &req.node_id, req.seq, &device, None, Op::Rotate).map_err(|r| with_reference(r, &reference))?;
    let token = match device.platform { Platform::Ios => req.dc_token.clone(), Platform::Android => req.pi_token.clone() }
        .filter(|t| oracle::token_shape_ok(t));
    Ok(PreparedRotation {
        node_id: req.node_id.clone(), seq: req.seq, wallet, identity_pk, ping_pk: row.ping_pubkey.clone(), delegation_sig,
        raw_block: req.device.clone().unwrap_or(Value::Null), block, device, old, old_sig: req.old_sig.clone(), preimage, token,
        registered: true,
    })
}

/// The rotation at the oracle, the statement of four over the new key, and the record: the old key and its
/// attestation-key entry freed, `rotation_due` reset, the binding's sequence kept. A rotation never goes on
/// without the oracle's lease: the old key keeps counting until its hard limit, and the app tries again.
pub(crate) async fn commit_rotation(ctx: DeviceCtx, p: PreparedRotation, oracle_timeout: std::time::Duration,
                                    quorum_budget: std::time::Duration) -> DeviceOutcome {
    let now = ld::now_secs();
    let tag = p.device.device_tag();
    let reference = messages::reference(&p.block.nonce_bytes(), &tag);
    let later = || DeviceOutcome::Refused(with_reference(DeviceRefusal::retry(DeviceReason::Stale, 600).into(), &reference));
    let (Some(token), Some(o)) = (p.token.as_deref(), ctx.oracle) else { return later(); };
    // No pinned oracle key: the rotation's lease could not verify here.
    if ctx.pins.keys.is_empty() { return later(); }
    let body = oracle::rotate_body(&oracle::RotateInput {
        node_id: &p.node_id, platform: p.device.platform, preimage: &p.preimage, hw_pub: &p.device.hw_pub, prov: p.device.prov,
        trust: p.device.trust, att_key: p.device.att_key.as_deref(), certs_issued: p.device.certs_issued,
        receipt: p.device.receipt.as_deref(), token, evidence: p.block.evidence_json(),
    });
    let (c, lease) = match o.post("/v1/rotate", body, oracle_timeout).await {
        Ok(v) => match oracle::read_claim(&v).and_then(|c| usable_lease(&ctx, &c, &p.node_id, &tag, now).map(|l| (c, l))) {
            Some(x) => x,
            None => {
                if crate::node::is_warn() {
                    println!("[WARN][DEVICE] lease_unverified node={} ref={} op=rotate (is the oracle key pinned?)", p.node_id, reference);
                }
                return later();
            }
        },
        Err(e) => {
            let Some(r) = e.refusal(now) else { return later(); };
            // The hold flag the slot read found pauses the node here and at every genesis too.
            if let oracle::OracleError::Refused { reason: DeviceReason::SlotPaused, until, .. } = &e {
                if let Some(cur) = ctx.storage.device_record(&p.node_id).filter(|x| x.stmt_hash == p.old.stmt_hash) {
                    let until = until.map_or(ctx.epoch + 1, |t| ld::epoch_at(t, now, ctx.epoch)).max(running_pause(&cur, ctx.epoch));
                    cause_change(&ctx, &cur, DeviceState::Paused, until, "hold", None);
                }
            }
            return DeviceOutcome::Refused(with_reference(r.into(), &reference));
        }
    };
    let mut state = statement::derive_state(Some(&lease), Op::Rotate, p.registered);
    if state == DeviceState::Active && c.suspect { state = DeviceState::Suspect; }
    let fields = StatementFields {
        node: p.node_id.clone(), device_tag: tag, hw_key: p.device.hw_key(), platform: p.device.platform, prov: p.device.prov,
        trust: p.device.trust, op: Op::Rotate, issued_epoch: ctx.epoch,
        effective_epoch: statement::effective_epoch(Some(&lease), Op::Rotate, ctx.epoch), state,
        lease_hash: messages::lease_hash(&c.lease_statement, &c.oracle_sig),
    };
    let req = AttestRequest {
        ingress: ctx.own_id.clone(),
        requested_at: now,
        statement: fields.preimage(),
        wallet: p.wallet.clone(),
        identity_pubkey: p.identity_pk.clone(),
        ping_pubkey: p.ping_pk.clone(),
        delegation_sig: p.delegation_sig.clone(),
        seq: p.seq,
        device: p.raw_block.clone(),
        hw_pub: hex::encode(p.device.hw_pub),
        lease: Some(LeaseProof { statement: c.lease_statement.clone(), oracle_sig: hex::encode(&c.oracle_sig),
                                 lease_valid_until: c.lease_valid_until, refresh_at: c.refresh_at }),
        pi_jws: c.pi_jws.clone(),
        key_node: Some(p.node_id.clone()),
        rotate: Some(attest::RotateProof { old_key: p.old.hw_key.clone(), old_sig: p.old_sig.clone() }),
    };
    let tail = BundleTail { device: p.device.clone(), rebind_from: None, nonce: p.block.nonce.clone(),
                            reason: gate_reason(Some(&lease)).unwrap_or_default() };
    let out = attest_and_record(&ctx, req, tail, &p.block, quorum_budget, &reference).await;
    // A slot read that made the second strike: the new record is paused, as the oracle's is.
    if let (DeviceOutcome::Final(r), true) = (&out, c.paused) {
        cause_change(&ctx, r, DeviceState::Paused, ld::epoch_at(c.paused_until, now, ctx.epoch), "two_strikes", None);
        if let Some(r) = ctx.storage.device_record(&p.node_id) { return DeviceOutcome::Final(Box::new(r)); }
    }
    out
}

/// How long a rotation may run before its answer: past the app's wait (it then keeps the new key and
/// settles it from the public status's device tag), so an answer only ever states the outcome.
const ROTATE_BUDGET: std::time::Duration = std::time::Duration::from_secs(95);

/// A rotation from its request to its answer.
pub(crate) async fn run_rotation(ctx: &DeviceCtx, req: &RotateRequest, now: u64) -> Value {
    if !messages::is_device_node_id(&req.node_id) { return Refusal::BadRequest.to_json(); }
    let Some(raw) = req.device.as_ref() else { return Refusal::BadRequest.to_json(); };
    let block = match evidence::parse_rotation_block(raw) {
        Ok(b) => b,
        Err(r) => return StepRefusal::device(r).to_json(),
    };
    if let Some(a) = DEVICE_ANSWERS.get(&req.node_id, &block.nonce, now) { return a; }
    if let Err(v) = stamped(ctx, &req.node_id, Purpose::Rotate, &block.nonce, &block.stamp, now) { return v; }
    let nonce = block.nonce.clone();
    let answer = match prepare_rotation(&ctx.storage, ctx.verifier, req, block, now, ctx.epoch) {
        Err(r) => r.to_json(),
        Ok(_) if !ROTATE_NODE_LIMIT.allows(&req.node_id, now) => Refusal::RateLimited.to_json(),
        Ok(p) => {
            let task = tokio::spawn(commit_rotation(ctx.clone(), p, oracle::CLAIM_TIMEOUT, QUORUM_BUDGET));
            match tokio::time::timeout(ROTATE_BUDGET, task).await {
                Ok(Ok(DeviceOutcome::Final(r))) => rotation_answer(ctx, &r, now),
                Ok(Ok(DeviceOutcome::Refused(r))) => {
                    if crate::node::is_info() {
                        println!("[INFO][DEVICE] rotation_refused node={} reason={}", req.node_id, r.as_str());
                    }
                    r.to_json()
                }
                _ => DeviceRefusal::retry(DeviceReason::Stale, 600).to_json(),
            }
        }
    };
    DEVICE_ANSWERS.put(&req.node_id, &nonce, answer.clone(), now);
    answer
}

/// A rotation's answer: `success` says the network took the new key (the app then keeps it and drops the
/// old one), whatever state the record is in; the state is beside it.
fn rotation_answer(ctx: &DeviceCtx, r: &DeviceRecord, now: u64) -> Value {
    let state = r.state_now(ctx.storage.is_node_registration_onchain(&r.node_id), ctx.epoch, now);
    let mut v = json!({ "success": true, "node_id": r.node_id, "device_state": state.as_str(),
                        "effective_epoch": r.effective_epoch, "rotation_due": r.rotation_due_epoch });
    if let Some(until) = r.pause_refusal().paused_until.filter(|_| state == DeviceState::Paused) {
        v["paused_until"] = until.into();
    }
    if let Some(reference) = r.reference().filter(|_| !state.counts()) {
        v["ref"] = reference.into();
    }
    v
}

/// `POST /api/v1/light-node/device-rotate`, at the genesis that issued the rotation challenge.
pub(super) async fn handle_light_device_rotate(
    req: RotateRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if check_api_rate_limit(remote_addr, "light_device_rotate").is_err() {
        return Ok(warp::reply::json(&Refusal::RateLimited.to_json()));
    }
    let Some(ctx) = DeviceCtx::of(&blockchain) else { return Ok(warp::reply::json(&not_served())); };
    Ok(warp::reply::json(&run_rotation(&ctx, &req, ld::now_secs()).await))
}

// ---- A11: the release with "Stop on this device" ----

/// The unbind's `device_release` (section 5.7): the device's signature over the release message at the
/// binding's sequence, under a release stamp this genesis issued. The record ends here and at every genesis
/// (a running pause keeps its epoch, and its key stays held here until then), and the oracle keeps the node's
/// slot generation 30 days for a self-reclaim only; its release keeps whatever hold the device's slot carries.
/// A release that does not check out leaves the unbind as it is.
pub(crate) fn release_step(ctx: &DeviceCtx, node: &str, seq: u64, block: &Value, now: u64) -> Result<StateChange, StepRefusal> {
    let field = |k: &str| block.get(k).and_then(|x| x.as_str()).unwrap_or("");
    let (nonce, stamp) = (field("nonce"), field("stamp"));
    if stamped(ctx, node, Purpose::Release, nonce, stamp, now).is_err() { return Err(StepRefusal::device(DeviceReason::Stale)); }
    let sig = messages::b64url_decode(field("sig")).filter(|s| !s.is_empty() && s.len() <= 1024)
        .ok_or(StepRefusal::Binding(Refusal::BadRequest))?;
    let token = block.get("token").and_then(|t| t.as_str()).filter(|t| oracle::token_shape_ok(t)).map(|t| t.to_string());
    let rec = ctx.storage.device_record(node).filter(|r| !r.provisional && r.live() && r.seq == seq)
        .ok_or(StepRefusal::Binding(Refusal::StaleSeq))?;
    let hw_pub = rec.hw_pub_bytes().ok_or(StepRefusal::Binding(Refusal::StaleSeq))?;
    let preimage = messages::release_preimage(node, seq, nonce);
    let counter = ctx.verifier.verify_known_key(rec.platform, &hw_pub, &sig, &preimage, store::last_counter(&ctx.storage, &rec))
        .map_err(|e| if e.reason == DeviceReason::Stale { StepRefusal::device(DeviceReason::Stale) } else { StepRefusal::Binding(Refusal::BadSignature) })?;
    if rec.platform == Platform::Ios { store::take_counter(&ctx.storage, &rec.hw_key, counter as u64); }
    let change = cause_change(ctx, &rec, DeviceState::Ended, running_pause(&rec, ctx.epoch), "released", None)
        .ok_or_else(|| StepRefusal::from(DeviceRefusal::retry(DeviceReason::Stale, 60)))?;
    // Told also while a timed pause runs (section 5.7): the pause holds the device's key here to its epoch
    // (`attest::admit`), and the oracle's release leaves the slot's hold as it is.
    if let (Some(o), Ok(handle)) = (ctx.oracle, tokio::runtime::Handle::try_current()) {
        let body = oracle::release_body(node, rec.platform, &preimage, token.as_deref());
        let node = node.to_string();
        handle.spawn(async move {
            if let Err(oracle::OracleError::Unavailable(why)) = o.post("/v1/release", body, oracle::BACKGROUND_CALL_TIMEOUT).await {
                if crate::node::is_warn() {
                    println!("[WARN][DEVICE] release_not_filed node={} reason={}", node, why);
                }
            }
        });
    }
    Ok(change)
}

// ---- A14-A16: what each genesis runs beside the routes ----

/// The `fetched_at` of the revocation snapshot this genesis holds; 0 before the first.
static CRL_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Take a snapshot the oracle served: under the pinned oracle key, and only a newer one than this genesis
/// holds (a list never moves back). Every later enrolment's and rotation's chain meets it, and it is kept
/// for a restart. Ok(true) when taken.
pub(crate) fn adopt_crl(storage: &crate::storage::Storage, snap: &ld::crl::Snapshot, pins: &OraclePins, epoch: u64, now: u64)
    -> Result<bool, &'static str>
{
    use std::sync::atomic::Ordering::Relaxed;
    let list = ld::crl::verify(snap, pins, epoch, now)?;
    if snap.fetched_at <= CRL_AT.load(Relaxed) { return Ok(false); }
    let serials = list.len();
    evidence::set_revocation_list(list);
    CRL_AT.store(snap.fetched_at, Relaxed);
    if let Ok(v) = serde_json::to_value(snap) {
        if storage.device_put_crl(&v).is_err() && crate::node::is_warn() {
            println!("[WARN][DEVICE] crl_not_kept fetched_at={}", snap.fetched_at);
        }
    }
    if crate::node::is_info() {
        println!("[INFO][DEVICE] crl_taken fetched_at={} serials={}", snap.fetched_at, serials);
    }
    Ok(true)
}

/// Signed revocation pauses one check causes at most; the rest wait for the next check. Every genesis holding
/// the snapshot reads those records paused meanwhile (`record::Local`), so a batch certificate's revocation
/// never floods the internal sync.
const MAX_PAUSES_PER_CHECK: usize = 10_000;

/// Pause every live record whose stored chain the list names (`revoked`, no epoch: a new enrolment's chain
/// meets the list), here and at every genesis. The genesis that took a record's enrolment signs its change,
/// so each record gets one (any genesis does, for a record whose ingress is no genesis of this binary).
/// Returns how many records it paused.
pub(crate) fn pause_revoked(ctx: &DeviceCtx, list: &qnet_device_attest::revocation::RevocationList) -> usize {
    let mut paused = 0;
    for r in ld::crl::revoked_records(&ctx.storage, list, ctx.epoch) {
        if r.ingress != ctx.own_id && ctx.genesis.contains(&r.ingress) { continue; }
        if paused >= MAX_PAUSES_PER_CHECK { break; }
        if cause_change(ctx, &r, DeviceState::Paused, 0, ld::record::REVOKED, None).is_some() {
            paused += 1;
        }
    }
    paused
}

/// The daily recheck of records a multiplicity gate holds (`/v1/recheck`): asked by the genesis that took
/// the enrolment, or by any genesis once the record has not moved for two days (its ingress seems gone).
/// When the oracle lets the node go (`check_passed`), the record counts again here and at every genesis.
pub(crate) async fn recheck_held(ctx: &DeviceCtx, o: &'static dyn OracleApi, due: &mut HashMap<String, u64>, now: u64) -> usize {
    /// Oracle calls one pass makes at most; the rest are asked in the next pass, an hour later.
    const CALLS_PER_PASS: usize = 2_000;
    let nodes = {
        let s = ctx.storage.clone();
        tokio::task::spawn_blocking(move || {
            let mut all: Vec<String> = Vec::new();
            loop {
                let page = s.device_gate_held(all.last().map(|n| n.as_str()), 1_000);
                let last = page.len() < 1_000;
                all.extend(page);
                if last || all.len() >= 1_000_000 { break all; }
            }
        }).await.unwrap_or_default()
    };
    let held: std::collections::HashSet<&String> = nodes.iter().collect();
    due.retain(|n, _| held.contains(n));
    let (mut passed, mut calls) = (0, 0);
    for node in &nodes {
        if due.get(node).map_or(false, |t| *t > now) { continue; }
        if calls >= CALLS_PER_PASS { break; }
        let Some(r) = ctx.storage.device_record(node).filter(|r| !r.provisional && r.live()) else { continue; };
        if r.ingress != ctx.own_id && now < r.updated_at.saturating_add(2 * ld::RECHECK_SECS) {
            due.insert(node.clone(), r.updated_at.saturating_add(2 * ld::RECHECK_SECS));
            continue;
        }
        calls += 1;
        let next = match o.post("/v1/recheck", oracle::recheck_body(node), oracle::BACKGROUND_CALL_TIMEOUT).await {
            Ok(v) => match oracle::read_recheck(&v) {
                Some(a) if a.state.counts() && a.reason.as_deref() == Some("check_passed") => {
                    if cause_change(ctx, &r, a.state, 0, "check_passed", None).is_some() { passed += 1; }
                    now + ld::RECHECK_SECS
                }
                Some(a) => a.next_check_at.max(now + 3_600),
                None => now + 3_600,
            },
            Err(_) => now + 3_600,
        };
        due.insert(node.clone(), next);
    }
    passed
}

/// What the maintenance has done and when it runs next (Unix seconds, epochs).
#[derive(Default)]
struct Schedule {
    next_probe: u64,
    next_crl: u64,
    next_recheck: u64,
    next_stale_alert: u64,
    next_outbox: u64,
    crl_checked: Option<u64>,
    monitored: Option<u64>,
    recheck_due: HashMap<String, u64>,
}

/// Start the device layer's background work on one of the five genesis (a no-op elsewhere): the oracle's
/// availability probe (A18), its revocation snapshot and the per-epoch check of the stored chains (A14), the
/// daily recheck of gate-held records, and the cross-owner bitmap monitor (A16). Local and RPC only.
pub(crate) fn start_device_maintenance(blockchain: Arc<BlockchainNode>) {
    let Some(own) = ld::own_genesis_id() else { return; };
    let Ok(handle) = tokio::runtime::Handle::try_current() else { return; };
    let own_idx = own.strip_prefix("genesis_node_").and_then(|n| n.parse::<usize>().ok()).map(|n| n.saturating_sub(1));
    handle.spawn(async move {
        let storage = blockchain.get_storage();
        if let Some(snap) = storage.device_crl().and_then(|v| serde_json::from_value::<ld::crl::Snapshot>(v).ok()) {
            if let Err(e) = adopt_crl(&storage, &snap, OraclePins::production(), ld::current_epoch(), ld::now_secs()) {
                if crate::node::is_warn() { println!("[WARN][DEVICE] crl_kept_refused reason={}", e); }
            }
        }
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
        let mut m = Schedule::default();
        loop {
            tick.tick().await;
            maintenance_tick(&blockchain, own_idx, &mut m).await;
        }
    });
}

async fn maintenance_tick(blockchain: &Arc<BlockchainNode>, own_idx: Option<usize>, m: &mut Schedule) {
    use std::sync::atomic::Ordering::Relaxed;
    let Some(ctx) = DeviceCtx::of(blockchain) else { return; };
    let (now, epoch) = (ld::now_secs(), ctx.epoch);
    if let Some(o) = ctx.oracle {
        if now >= m.next_probe {
            m.next_probe = now + ld::ORACLE_PROBE_SECS;
            let _ = o.get("/v1/health", std::time::Duration::from_secs(10)).await;
        }
        if now >= m.next_crl {
            m.next_crl = now + ld::CRL_FETCH_SECS;
            match o.get("/v1/crl", oracle::BACKGROUND_CALL_TIMEOUT).await {
                Ok(v) => match serde_json::from_value::<ld::crl::Snapshot>(v).map_err(|_| "unreadable")
                    .and_then(|s| adopt_crl(&ctx.storage, &s, ctx.pins, epoch, now))
                {
                    Ok(true) => m.crl_checked = None,
                    Ok(false) => {}
                    Err(e) => if crate::node::is_warn() { println!("[WARN][DEVICE] crl_refused reason={}", e); },
                },
                Err(_) => m.next_crl = now + 900,
            }
        }
        if now >= m.next_recheck {
            m.next_recheck = now + 3_600;
            let passed = recheck_held(&ctx, o, &mut m.recheck_due, now).await;
            if passed > 0 && crate::node::is_info() {
                println!("[INFO][DEVICE] recheck_passed nodes={}", passed);
            }
        }
    }
    if now >= m.next_outbox {
        m.next_outbox = now + OUTBOX_RESEND_SECS;
        let (taken, dropped) = resend_outbox(&ctx.storage, now, |ip: String, body: Value| async move {
            genesis_internal_call_tls(&ip, SYNC_PATH, |c, url| c.post(url).json(&body)).await
                .map_or(false, |r| r.status().is_success())
        }).await;
        if (taken > 0 || dropped > 0) && crate::node::is_info() {
            println!("[INFO][DEVICE] device_outbox_resent taken={} dropped_stale={}", taken, dropped);
        }
    }
    let at = CRL_AT.load(Relaxed);
    if at > 0 && now.saturating_sub(at) > ld::CRL_MAX_AGE_SECS && now >= m.next_stale_alert {
        m.next_stale_alert = now + 3_600;
        if crate::node::is_warn() { println!("[WARN][ALERT] device_crl_stale age_secs={}", now - at); }
    }
    // Once an epoch, and at once after a newer snapshot: pause the records whose chain it names.
    if m.crl_checked != Some(epoch) {
        m.crl_checked = Some(epoch);
        let list = evidence::revocation_list();
        if !list.is_empty() {
            let c = ctx.clone();
            let paused = tokio::task::spawn_blocking(move || pause_revoked(&c, &list)).await.unwrap_or(0);
            if crate::node::is_info() {
                println!("[INFO][DEVICE] crl_check epoch={} paused={}", epoch, paused);
            }
        }
    }
    // The finished epoch's bitmaps, once its owners' rows are in (an eighth into the next epoch).
    let tip = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(Relaxed);
    if let (Some(own), true) = (own_idx, epoch > 0 && tip % ld::EPOCH_BLOCKS >= ld::EPOCH_BLOCKS / 8) {
        if m.monitored != Some(epoch - 1) {
            m.monitored = Some(epoch - 1);
            let (storage, p2p) = (ctx.storage.clone(), blockchain.get_unified_p2p());
            let done = epoch - 1;
            let found = tokio::task::spawn_blocking(move || {
                ld::monitor::check_epoch(&storage, own, done, || p2p.map(|p| p.get_light_eligible_for_epoch(done)).unwrap_or_default())
            }).await.unwrap_or_default();
            report_divergence(done, &found);
        }
    }
}

/// Log what the monitor found: every owner that set bits alone, and an alert past the threshold.
fn report_divergence(epoch: u64, found: &[ld::monitor::ShardFinding]) {
    if !crate::node::is_warn() { return; }
    for f in found {
        for s in &f.single {
            println!("[WARN][DEVICE] bitmap_single_owner epoch={} shard={} owner={} committed={} bits={} union={} sample={:?}",
                     epoch, f.shard, s.owner, s.committed, s.count, f.union, s.sample);
            if s.count > ld::monitor::alert_threshold(f.union) {
                println!("[WARN][ALERT] light_bitmap_divergence epoch={} shard={} owner={} bits={} union={}",
                         epoch, f.shard, s.owner, s.count, f.union);
            }
        }
        if f.single.is_empty() && crate::node::is_debug() {
            println!("[DBG][DEVICE] bitmap_owners_agree epoch={} shard={} union={}", epoch, f.shard, f.union);
        }
    }
}

#[cfg(test)]
#[path = "light_device_tests.rs"]
mod tests;
