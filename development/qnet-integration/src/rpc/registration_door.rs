//! The light registration submit door (`POST /api/v1/node-registration/submit`) and the attestor's view
//! of who asks it for a burn attestation (U5, U14, H9, H10):
//! - the checks a submit passes before any attestation round, each refusal with a stable `code`;
//! - the idempotent resubmit: a node whose registration the pool holds gets that hash again;
//! - first-sight Solana lookups metered per client address and per node at the door;
//! - committee callers told apart from everyone else at `node_attestBurn`.
//!
//! RPC admission policy only. Block validation judges a registration by its bytes
//! (`verify_burn_attestation_quorum`) and reads no consent age; nothing here changes what a block may
//! carry. Wire forms: `docs/protocols/light-node-messages.md` section 4 (consent, owner bind).

use super::*;
use crate::light_binding as lb;

// ---------------------------------------------------------------- refusal codes

/// The stable `code` of a submit refusal (unified plan section 3.4). The `error` text of each refusal
/// stays what it was, for clients that read the text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubmitCode {
    AlreadyRegistered,
    BehindChain,
    CommitteeUnavailable,
    QuorumPending,
    MempoolRejected,
    TimestampWindow,
    BadRequest,
    RateLimited,
    /// The wallet already has another node on chain (the `wallet_one_node` rule): one wallet, one node.
    WalletHasNode,
    /// A light owner bind in its v2 form (no time) that verifies, before the `wallet_one_node` gate makes the
    /// network accept it: sound, not accepted yet. The node lists `owner_bind_v2` once it does.
    BindV2Pending,
}

impl SubmitCode {
    #[cfg(test)]
    pub(crate) const ALL: [SubmitCode; 10] = [
        SubmitCode::AlreadyRegistered, SubmitCode::BehindChain, SubmitCode::CommitteeUnavailable,
        SubmitCode::QuorumPending, SubmitCode::MempoolRejected, SubmitCode::TimestampWindow,
        SubmitCode::BadRequest, SubmitCode::RateLimited, SubmitCode::WalletHasNode, SubmitCode::BindV2Pending,
    ];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            SubmitCode::AlreadyRegistered => "already_registered",
            SubmitCode::BehindChain => "behind_chain",
            SubmitCode::CommitteeUnavailable => "committee_unavailable",
            SubmitCode::QuorumPending => "quorum_pending",
            SubmitCode::MempoolRejected => "mempool_rejected",
            SubmitCode::TimestampWindow => "timestamp_window",
            SubmitCode::BadRequest => "bad_request",
            SubmitCode::RateLimited => "rate_limited",
            SubmitCode::WalletHasNode => "wallet_has_node",
            SubmitCode::BindV2Pending => "bind_v2_pending",
        }
    }

    /// A client sends the same registration again later for these; the others end the attempt.
    #[cfg(test)]
    pub(crate) fn retryable(self) -> bool {
        matches!(self, SubmitCode::BehindChain | SubmitCode::CommitteeUnavailable | SubmitCode::QuorumPending
            | SubmitCode::MempoolRejected | SubmitCode::RateLimited | SubmitCode::BindV2Pending)
    }
}

/// The text of the one-node refusal (`wallet_has_node`) at every door that answers it: the submit door and the
/// legacy light register route.
pub(crate) const WALLET_HAS_NODE_TEXT: &str = "This wallet already has a node on the QNet network: one wallet, one node";

/// A refused submit: its code, the reason the log names, and the answer (`success: false`, `code`,
/// `error`, and whatever figures the refusal carries).
#[derive(Debug, Clone)]
pub(crate) struct SubmitRefusal {
    pub(crate) code: SubmitCode,
    pub(crate) reason: &'static str,
    body: Value,
}

impl SubmitRefusal {
    pub(crate) fn new(code: SubmitCode, reason: &'static str, error: &str) -> Self {
        SubmitRefusal { code, reason, body: json!({ "success": false, "code": code.as_str(), "error": error }) }
    }

    /// The answer of a spent limit, in the form every rate-limited route gives, with the code.
    pub(crate) fn rate_limited(reason: &'static str, retry_after: u64) -> Self {
        let mut body = rate_limit_body(retry_after);
        body["code"] = json!(SubmitCode::RateLimited.as_str());
        SubmitRefusal { code: SubmitCode::RateLimited, reason, body }
    }

    pub(crate) fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.body[key] = value.into();
        self
    }

    pub(crate) fn body(&self) -> &Value {
        &self.body
    }

    pub(crate) fn log(&self, node_id: &str) {
        if crate::node::is_warn() {
            println!("[WARN][NODE-REG-CLIENT] reject node={} reason={} code={}", node_id, self.reason, self.code.as_str());
        }
    }
}

// ---------------------------------------------------------------- the checks before the committee

/// A submit that passed every check the door makes before it asks the committee: the registration in
/// its client form, built and signed exactly as block validation rebuilds it, and the burn it names.
#[derive(Debug, Clone)]
pub(crate) struct CheckedSubmit {
    pub(crate) reg_tx: qnet_state::Transaction,
    pub(crate) burn_tx: String,
    pub(crate) burn_amount: u64,
    pub(crate) burn_wallet: String,
    pub(crate) owner_sig: String,
}

/// Everything the door checks from the request alone, cheap first. Reads no state and no network, so a
/// request gets the same answer from every genesis at the same clock and gate. `bind_v2`: the owner bind may
/// take its form without a time (`owner_bind_v2_allowed` at the height the door judges for); without it a
/// v2 bind that verifies, on a submit that passes every other check here, is answered `bind_v2_pending`
/// (retry), never `bad_request`.
pub(crate) fn check_client_submit(req: &NodeRegistrationClientRequest, now: u64, bind_v2: bool) -> Result<CheckedSubmit, SubmitRefusal> {
    use SubmitCode::{BadRequest, BindV2Pending, TimestampWindow};
    // Only light nodes register from the client. A super registers itself (server-initiated, its own
    // consensus key in the body).
    if req.node_type != "light" {
        return Err(SubmitRefusal::new(BadRequest, "node_type_not_light",
            "Only light node self-registration is supported via this endpoint"));
    }
    if req.from != req.wallet_address {
        return Err(SubmitRefusal::new(BadRequest, "from_ne_wallet", "from and wallet_address must match"));
    }
    if let Err(e) = validate_eon_address_with_error(&req.from) {
        return Err(SubmitRefusal::new(BadRequest, "invalid_eon", "Invalid wallet address").with("details", e));
    }
    // H9: the node id is exactly the wallet's pseudonym, the rule block validation applies. The
    // suffix-only test this replaces let one burn mint a `light_<anything>_<suffix>` variant per
    // request, each a pool entry of its own that block validation then refuses.
    if !crate::node::BlockchainNode::registration_identity_bound(
        &req.node_id, &qnet_state::NodeType::Light, &req.wallet_address, &req.registration_proof)
    {
        return Err(SubmitRefusal::new(BadRequest, "node_id_not_pseudonym", "node_id is not the wallet-derived pseudonym"));
    }

    // Proof of ownership of the burning Solana wallet: its signature over the beneficiary, the consent's
    // proof and time, the wallet key's hash and the burn (burn_owner_bind_message, the string block
    // validation rebuilds), or with `bind_v2` the same fields without the time (burn_owner_bind_message_v2,
    // which the burner signs once, right after the burn is signed). Without it anyone could take a victim's
    // public burn_tx and commit their own key as the victim's attestation root.
    let (burn_wallet, owner_sig) = match (
        req.burn_wallet.as_deref().filter(|s| !s.is_empty()),
        req.owner_signature.as_deref().filter(|s| !s.is_empty()),
    ) {
        (Some(w), Some(s)) => (w, s),
        _ => return Err(SubmitRefusal::new(BadRequest, "burn_wallet_or_owner_sig_missing",
            "burn_wallet + owner_signature required (proof of wallet ownership)")),
    };
    let wire_pk = req.dilithium_public_key.as_deref().and_then(|h| hex::decode(h).ok()).unwrap_or_default();
    let burn_tx = req.burn_tx_hash.as_deref().unwrap_or("");
    let verify = |msg: String| crate::crypto::solana_derivation::verify_ed25519_signature(msg.as_bytes(), owner_sig, burn_wallet)
        .unwrap_or(false);
    let v1 = verify(qnet_state::Transaction::burn_owner_bind_message(
            &req.node_id, &req.wallet_address, &req.registration_proof, req.timestamp, &wire_pk, burn_tx));
    let v2 = !v1 && verify(qnet_state::Transaction::burn_owner_bind_message_v2(
            &req.node_id, &req.wallet_address, &req.registration_proof, &wire_pk, burn_tx));
    if !v1 && !v2 {
        return Err(SubmitRefusal::new(BadRequest, "owner_signature_invalid",
            "owner_signature invalid — not the burning wallet's owner"));
    }

    // The wallet (which determines the node id) derives from a credential the submitter controls: the
    // ML-DSA-65 key whose consent is checked below, or the burning Solana address.
    let native_bound = req.dilithium_public_key.as_deref()
        .and_then(crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey)
        .as_deref() == Some(req.wallet_address.as_str());
    let solana_bound = crate::crypto::solana_derivation::eon_from_solana_address(burn_wallet) == req.wallet_address;
    if !native_bound && !solana_bound {
        return Err(SubmitRefusal::new(BadRequest, "wallet_not_derived",
            "wallet_address not derived from dilithium_public_key or burn_wallet (ownership unproven)"));
    }

    // U5 (a): a v1 owner bind shares T with the consent. The cabinet signed it only when the user came back
    // to the page, so T may be up to a day old. Block validation reads no age.
    if !lb::consent_ts_in_window(req.timestamp, now) {
        return Err(SubmitRefusal::new(TimestampWindow, "timestamp_window",
            "Request timestamp too old or too far in future (a consent may be up to 24 h old and 5 min ahead)")
            .with("node_time", now));
    }

    // The registration in its client form, checked by the verifier the producer and block validation
    // use, so what the door admits is a subset of what a block may carry.
    let mut reg_tx = crate::node::BlockchainNode::create_node_registration_tx_with_timestamp(
        &req.node_id, qnet_state::NodeType::Light, &req.wallet_address, &req.registration_proof, "", Some(req.timestamp));
    reg_tx.data = Some(qnet_state::Transaction::client_registration_data(&req.node_id, &req.wallet_address, &req.registration_proof));
    // A malformed hex decodes to None, and the gate below refuses it: never a signature-less admission.
    if let Some(ref sig) = req.dilithium_signature { reg_tx.dilithium_signature = hex::decode(sig).ok(); }
    if let Some(ref pk) = req.dilithium_public_key { reg_tx.dilithium_public_key = hex::decode(pk).ok(); }
    // A native wallet's consent is mandatory. A Solana-derived wallet's is optional (the owner bind and
    // the burn quorum authorise it), but one that is present must verify, as the producer requires.
    let has_sig = reg_tx.dilithium_signature.as_deref().map_or(false, |s| !s.is_empty());
    if native_bound {
        if !has_sig || !crate::node::BlockchainNode::verify_node_lifecycle_dilithium(&reg_tx) {
            return Err(SubmitRefusal::new(BadRequest, "dilithium_sig_invalid",
                "native registration requires a valid ML-DSA-65 signature (pure-PQ)"));
        }
    } else if has_sig && !crate::node::BlockchainNode::verify_node_lifecycle_dilithium(&reg_tx) {
        return Err(SubmitRefusal::new(BadRequest, "dilithium_sig_invalid", "ML-DSA-65 signature verification failed"));
    }

    // The burn backs the registration. Burn attestation is required from height 0, so a registration
    // without one never lands; it is refused here instead of waiting in the pool, and a burn_tx that is
    // no Solana signature is refused before the committee is asked about it.
    let burn_ok = burn_tx.len() <= 100 && bs58::decode(burn_tx).into_vec().map(|v| v.len()) == Ok(64);
    let burn_amount = match req.burn_amount.filter(|a| *a > 0) {
        Some(a) if burn_ok => a,
        _ => return Err(SubmitRefusal::new(BadRequest, "burn_missing",
            "burn_tx_hash (a base58 Solana signature) and burn_amount are required")),
    };
    // The proof the consent signed commits to the burn: a swapped burn fails here.
    let proof = blake3::hash(format!("{}:{}:{}", burn_tx, req.node_id, req.wallet_address).as_bytes()).to_hex().to_string();
    if proof.get(..32) != Some(req.registration_proof.as_str()) {
        return Err(SubmitRefusal::new(BadRequest, "burn_proof_mismatch", "burn_tx_hash does not match the signed registration_proof"));
    }
    // Last, so a submit with a lasting fault is told so now: the burner's v2 bind is sound and the network
    // takes that form from the gate on. The client retries once a node lists `owner_bind_v2`; the burn is
    // not refused.
    if v2 && !bind_v2 {
        return Err(SubmitRefusal::new(BindV2Pending, "bind_v2_pending",
            "owner bind without a time is not accepted by the network yet; retry once nodes list owner_bind_v2"));
    }
    Ok(CheckedSubmit {
        reg_tx,
        burn_tx: burn_tx.to_string(),
        burn_amount,
        burn_wallet: burn_wallet.to_string(),
        owner_sig: owner_sig.to_string(),
    })
}

/// Embed the committee's attestations - the burn fields block validation re-verifies - and hash.
pub(crate) fn stamp_burn_attestation(c: &mut CheckedSubmit, attestors: Vec<(String, String)>, cost: u64, amount: u64, epoch: u64) {
    if let qnet_state::TransactionType::NodeRegistration {
        burn_tx, burn_wallet, burn_owner_sig, burn_amount, burn_cost, burn_attestors, attest_epoch, ..
    } = &mut c.reg_tx.tx_type {
        *burn_tx = c.burn_tx.clone();
        *burn_wallet = c.burn_wallet.clone();
        // The burner's authorization rides on chain: block validation checks it again.
        *burn_owner_sig = c.owner_sig.clone();
        // The committee-certified amount, what the counted attestors signed.
        *burn_amount = amount;
        *burn_cost = cost;
        *burn_attestors = attestors;
        *attest_epoch = epoch;
    }
    c.reg_tx.hash = c.reg_tx.calculate_hash();
}

// ---------------------------------------------------------------- idempotent resubmit (U5 b)

/// Attestations stay good for this many rotation epochs after the one they name: the verifier's
/// MAX_ATTEST_EPOCH_LAG (`verify_burn_attestation_quorum`), the edge the convergence driver re-arms at.
const ATTEST_EPOCH_LAG: u64 = 2;

/// The rotation epoch (90 blocks) the next block applies in, as the inclusion lane computes it.
pub(crate) fn next_apply_epoch() -> u64 {
    crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Acquire) / 90 + 1
}

/// The registration the pool holds for `node_id` while a block can still carry it: a resubmit for the
/// node gets this hash again, with no new attestation round. One whose attestations reached the re-arm
/// edge is not reused: the resubmit re-arms, and its registration replaces the old one (the pool keeps
/// one per node).
pub(crate) fn reusable_pending_registration(mempool: &qnet_mempool::SimpleMempool, node_id: &str, apply_epoch: u64) -> Option<String> {
    let hash = mempool.resident_registration(node_id)?;
    let tx: qnet_state::Transaction = bincode::deserialize(&mempool.get_binary_transaction(&hash)?).ok()?;
    match &tx.tx_type {
        qnet_state::TransactionType::NodeRegistration { node_id: n, burn_tx, attest_epoch, .. }
            if n == node_id && !burn_tx.is_empty() && *attest_epoch != 0
                && *attest_epoch <= apply_epoch.saturating_add(1)
                && apply_epoch < attest_epoch.saturating_add(ATTEST_EPOCH_LAG) => Some(hash),
        _ => None,
    }
}

/// The registration the pool holds for `node_id`, reusable or not. Status v2 reports it as
/// `registration_pending` / `pending_tx` (NODE-3), so the cabinet never offers a second burn while one
/// waits; the door logs the one a re-arm replaces.
pub(crate) fn pending_registration_tx(node_id: &str) -> Option<String> {
    crate::node::try_get_mempool()?.resident_registration(node_id)
}

/// A submit collecting attestations for a node. A second submit for the same node meanwhile waits for
/// the first instead of starting a round of its own; it then finds the first one's registration.
static SUBMIT_IN_FLIGHT: Lazy<DashMap<String, u64>> = Lazy::new(DashMap::new);
/// Past this a mark is taken to be a leak: a round takes seconds (a bounded fan-out of 30 s calls).
const SUBMIT_IN_FLIGHT_MAX_SECS: u64 = 180;

/// A submit for `node_id` is collecting attestations here now (status v2 reads it as a pending
/// registration, like one resident in the pool).
pub(crate) fn submit_in_flight(node_id: &str, now: u64) -> bool {
    SUBMIT_IN_FLIGHT.get(node_id).map_or(false, |since| now.saturating_sub(*since) < SUBMIT_IN_FLIGHT_MAX_SECS)
}

pub(crate) struct SubmitInFlight {
    node_id: String,
    since: u64,
}

impl SubmitInFlight {
    pub(crate) fn enter(node_id: &str, now: u64) -> Option<Self> {
        use dashmap::mapref::entry::Entry;
        match SUBMIT_IN_FLIGHT.entry(node_id.to_string()) {
            Entry::Occupied(e) if now.saturating_sub(*e.get()) < SUBMIT_IN_FLIGHT_MAX_SECS => return None,
            Entry::Occupied(mut e) => { *e.get_mut() = now; }
            Entry::Vacant(e) => { e.insert(now); }
        }
        Some(SubmitInFlight { node_id: node_id.to_string(), since: now })
    }
}

impl Drop for SubmitInFlight {
    fn drop(&mut self) {
        // Only this round's mark: a round that took over a leaked one owns it now.
        SUBMIT_IN_FLIGHT.remove_if(&self.node_id, |_, since| *since == self.since);
    }
}

// ---------------------------------------------------------------- first-sight metering (U14)

/// First-sight Solana lookups a submit door starts per client address and per node in one window. The
/// attestors meter per burner, but the cabinet's payment key is a fresh burner every time, so there an
/// honest activation and a flood of fresh keys look alike; the door tells them apart by address and by
/// node. A burn already looked at costs the attestors nothing (their caches answer it) and is not
/// counted again. An activation takes one to three submits, so the address budget carries a carrier NAT.
const DOOR_LOOKUP_WINDOW_SECS: u64 = 600;
static DOOR_ADDR_LIMIT: KeyedLimiter = KeyedLimiter::new(10, DOOR_LOOKUP_WINDOW_SECS);
static DOOR_NODE_LIMIT: KeyedLimiter = KeyedLimiter::new(3, DOOR_LOOKUP_WINDOW_SECS);
static DOOR_SEEN: Lazy<parking_lot::Mutex<HashMap<String, u64>>> = Lazy::new(|| parking_lot::Mutex::new(HashMap::new()));
const DOOR_SEEN_CAP: usize = 65_536;

/// The key a client address is metered under: the address, or for IPv6 its /64, which one subscriber
/// holds whole.
pub(crate) fn lookup_meter_key(ip: IpAddr) -> String {
    match canonical_ip(ip) {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => {
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
        }
    }
}

/// An IPv4 peer seen through an IPv6 socket is that IPv4 address.
fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

/// Whether a submit may start a first-sight lookup of its burn; Err carries the seconds to wait. `known`:
/// this node already verified the pair (its attestor's cache). A whitelisted address - the site's proxy,
/// which meters its own clients - skips the address meter; the node meter applies to every caller.
pub(crate) fn door_admit_lookup(addr: Option<IpAddr>, node_id: &str, burn_tx: &str, burner: &str, known: bool, now: u64) -> Result<(), u64> {
    if known { return Ok(()); }
    let pair = format!("{}_{}", burn_tx, burner);
    if DOOR_SEEN.lock().get(&pair).map_or(false, |t| now.saturating_sub(*t) < DOOR_LOOKUP_WINDOW_SECS) {
        return Ok(());
    }
    let addr_key = addr.filter(|ip| !is_ip_whitelisted(*ip)).map(lookup_meter_key);
    if let Some(k) = &addr_key { DOOR_ADDR_LIMIT.check(k, now)?; }
    DOOR_NODE_LIMIT.check(node_id, now)?;
    if let Some(k) = &addr_key { DOOR_ADDR_LIMIT.allows(k, now); }
    DOOR_NODE_LIMIT.allows(node_id, now);
    let mut seen = DOOR_SEEN.lock();
    if seen.len() >= DOOR_SEEN_CAP {
        seen.retain(|_, t| now.saturating_sub(*t) < DOOR_LOOKUP_WINDOW_SECS);
        if seen.len() >= DOOR_SEEN_CAP { seen.clear(); }
    }
    seen.insert(pair, now);
    Ok(())
}

// ---------------------------------------------------------------- committee callers (H10)

/// Whether a remote `node_attestBurn` caller is a committee member asking from its own submit door: a
/// genesis address, or the announced address of a member of the committee of the request's
/// `attest_epoch`. Loopback is not one: this node asks its own attestor in-process
/// (`attest_burn_in_process`), and a loopback caller is anyone a TLS terminator that passed no client on
/// let through. The device layer's `node_attestDevice` (A3) takes the same test.
pub(crate) fn attest_caller_in_committee(blockchain: &BlockchainNode, ip: IpAddr, attest_epoch: u64) -> bool {
    let ip = canonical_ip(ip);
    caller_is_genesis(ip) || committee_addresses(&blockchain.get_storage(), attest_epoch).contains(&ip)
}

fn caller_is_genesis(ip: IpAddr) -> bool {
    let s = ip.to_string();
    crate::genesis_constants::GENESIS_NODE_IPS.iter().any(|(g, _)| *g == s)
}

/// Announced addresses of the committee of `attest_epoch`, rebuilt at most once a minute (an endpoint
/// learned later is picked up then). An attestor accepts only a few epochs, so the cache stays small.
/// Addresses are compared parsed, so the spelling an endpoint was announced in does not matter; an
/// endpoint named by host name matches nothing (its member asks in the outside lane).
fn committee_addresses(storage: &crate::storage::Storage, attest_epoch: u64) -> Arc<std::collections::HashSet<IpAddr>> {
    type Entry = (u64, u64, Arc<std::collections::HashSet<IpAddr>>);
    static CACHE: Lazy<parking_lot::Mutex<Vec<Entry>>> = Lazy::new(|| parking_lot::Mutex::new(Vec::new()));
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    if let Some((_, _, set)) = CACHE.lock().iter().find(|(e, at, _)| *e == attest_epoch && now.saturating_sub(*at) < 60) {
        return set.clone();
    }
    let rep_h = attest_epoch.saturating_sub(1) * 90 + 1;
    let set: std::collections::HashSet<IpAddr> = BlockchainNode::committee_for_height(storage, rep_h)
        .unwrap_or_default().iter()
        .filter_map(|id| BlockchainNode::member_endpoint_ip(storage, id))
        .filter_map(|s| s.parse::<IpAddr>().ok().map(canonical_ip))
        .collect();
    let set = Arc::new(set);
    let mut c = CACHE.lock();
    c.retain(|(e, _, _)| *e != attest_epoch);
    if c.len() >= 4 { c.remove(0); }
    c.push((attest_epoch, now, set.clone()));
    set
}

/// The submit body the cabinet builds (the field set of the site's registration module) from the
/// contract vectors of wallet `wi` (`light-node.vectors.json`): the wallet's consent and the test
/// burner's owner bind, both at T = 1790000000.
#[cfg(test)]
pub(crate) fn submit_vector_body(wi: usize) -> (serde_json::Value, u64) {
    let v: serde_json::Value = serde_json::from_str(include_str!("../../../../docs/protocols/light-node.vectors.json"))
        .expect("vectors parse");
    let n = &v["node"][wi];
    let w = &v["wallets"][wi];
    let msg = |name: &str| n["messages"].as_array().unwrap().iter()
        .find(|m| m["name"].as_str() == Some(name)).unwrap().clone();
    let consent = msg("consent");
    let owner = msg("ownerBind");
    let t: u64 = consent["inputs"]["ts"].as_str().unwrap().parse().unwrap();
    assert_eq!(owner["inputs"]["ts"], consent["inputs"]["ts"], "the consent and the owner bind share T");
    let body = json!({
        "from": w["address"], "node_id": n["nodeId"], "node_type": "light", "wallet_address": w["address"],
        "registration_proof": n["proof"], "timestamp": t, "burn_tx_hash": n["burnTx"], "burn_amount": 1500u64,
        "burn_wallet": v["burner"]["address"], "dilithium_signature": consent["signature"],
        "dilithium_public_key": w["publicKey"], "owner_signature": owner["signature"],
    });
    (body, t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vector_submit(wi: usize) -> (serde_json::Value, u64) {
        submit_vector_body(wi)
    }

    fn req(body: &serde_json::Value) -> NodeRegistrationClientRequest {
        serde_json::from_value(body.clone()).expect("request")
    }

    fn code(r: Result<CheckedSubmit, SubmitRefusal>) -> Option<&'static str> {
        r.err().map(|e| e.code.as_str())
    }

    #[test]
    fn the_codes_are_the_contract_values_one_to_one() {
        let names: Vec<&str> = SubmitCode::ALL.iter().map(|c| c.as_str()).collect();
        assert_eq!(names, ["already_registered", "behind_chain", "committee_unavailable", "quorum_pending",
                           "mempool_rejected", "timestamp_window", "bad_request", "rate_limited", "wallet_has_node",
                           "bind_v2_pending"]);
        let distinct: std::collections::HashSet<&str> = names.iter().copied().collect();
        assert_eq!(distinct.len(), names.len());
        // The retry set the cabinet and the extension read (their RETRY_CODES).
        let retry: Vec<&str> = SubmitCode::ALL.iter().filter(|c| c.retryable()).map(|c| c.as_str()).collect();
        assert_eq!(retry, ["behind_chain", "committee_unavailable", "quorum_pending", "mempool_rejected", "rate_limited",
                           "bind_v2_pending"]);
        for c in SubmitCode::ALL {
            let r = SubmitRefusal::new(c, "t", "text");
            assert_eq!(r.body()["success"], json!(false));
            assert_eq!(r.body()["code"].as_str(), Some(c.as_str()));
        }
        // The limit's answer keeps the text old clients match ("rate limit exceeded") and adds the code.
        let r = SubmitRefusal::rate_limited("t", 30);
        assert_eq!(r.body()["error"].as_str(), Some("Rate limit exceeded"));
        assert_eq!((r.body()["code"].as_str(), r.body()["retry_after_seconds"].as_u64()), (Some("rate_limited"), Some(30)));
    }

    /// U5 (a) on the contract vectors: a consent a day old at most, five minutes ahead at most.
    #[test]
    fn a_consent_up_to_a_day_old_is_admitted_and_an_older_one_is_not() {
        for wi in 0..2 {
            let (body, t) = vector_submit(wi);
            let r = req(&body);
            let c = check_client_submit(&r, t + 23 * 3600, false).expect("23 h old");
            assert_eq!((c.burn_tx.as_str(), c.burn_amount), (body["burn_tx_hash"].as_str().unwrap(), 1500));
            assert_eq!(c.reg_tx.timestamp, t);
            assert!(check_client_submit(&r, t + 86_400, false).is_ok(), "exactly a day");
            assert!(check_client_submit(&r, t - 300, false).is_ok(), "five minutes ahead");
            assert_eq!(code(check_client_submit(&r, t + 86_401, false)), Some("timestamp_window"));
            assert_eq!(code(check_client_submit(&r, t - 301, false)), Some("timestamp_window"));
            let text = check_client_submit(&r, t + 90_000, false).err().unwrap().body()["error"].as_str().unwrap().to_lowercase();
            assert!(text.contains("timestamp too old or too far in future"), "the text old clients match");
        }
    }

    #[test]
    fn the_door_refuses_what_block_validation_would() {
        let (body, t) = vector_submit(0);
        let now = t + 60;
        let with = |k: &str, v: serde_json::Value| { let mut b = body.clone(); b[k] = v; req(&b) };
        // H9: a region variant of the pseudonym (same suffix) is not the node id.
        let node = body["node_id"].as_str().unwrap();
        let variant = node.replacen("light_mobile_", "light_eu_", 1);
        let r = check_client_submit(&with("node_id", json!(variant)), now, false);
        assert_eq!(r.as_ref().err().map(|e| e.reason), Some("node_id_not_pseudonym"));
        // A consent over another burn, a burn that is no signature, no burn at all.
        let other_burn = bs58::encode([9u8; 64]).into_string();
        assert_eq!(check_client_submit(&with("burn_tx_hash", json!(other_burn)), now, false).err().map(|e| e.reason),
                   Some("owner_signature_invalid"), "the owner bind covers the burn");
        assert_eq!(code(check_client_submit(&with("burn_amount", json!(0)), now, false)), Some("bad_request"));
        assert_eq!(code(check_client_submit(&with("owner_signature", json!("")), now, false)), Some("bad_request"));
        // A forged consent (another wallet's key) and a tampered one.
        let (other, _) = vector_submit(1);
        assert_eq!(check_client_submit(&with("dilithium_public_key", other["dilithium_public_key"].clone()), now, false)
                       .err().map(|e| e.reason), Some("owner_signature_invalid"), "the owner bind names sha3(K)");
        let mut sig = body["dilithium_signature"].as_str().unwrap().to_string();
        let flipped = if &sig[0..2] == "00" { "01" } else { "00" };
        sig.replace_range(0..2, flipped);
        assert_eq!(check_client_submit(&with("dilithium_signature", json!(sig)), now, false).err().map(|e| e.reason),
                   Some("dilithium_sig_invalid"));
        assert_eq!(code(check_client_submit(&with("node_type", json!("super")), now, false)), Some("bad_request"));
    }

    /// U14: a burn is metered the first time a door sees it, per client address and per node; a repeat,
    /// a burn this node already verified, and a whitelisted address's address meter cost nothing.
    #[test]
    fn first_sight_lookups_are_metered_per_address_and_per_node() {
        let now = 1_800_000_000;
        let ip: IpAddr = "203.0.113.7".parse().unwrap();
        let burn = |i: u32| format!("door_test_burn_{i}");
        // Per node: three new burns, then the fourth waits; a repeat of a seen burn does not.
        for i in 0..3 { assert_eq!(door_admit_lookup(Some(ip), "light_door_node_a", &burn(i), "b", false, now), Ok(())); }
        assert!(door_admit_lookup(Some(ip), "light_door_node_a", &burn(3), "b", false, now).is_err());
        assert_eq!(door_admit_lookup(Some(ip), "light_door_node_a", &burn(0), "b", false, now + 1), Ok(()), "a retry");
        assert_eq!(door_admit_lookup(Some(ip), "light_door_node_a", &burn(3), "b", true, now), Ok(()), "verified here before");
        // Per address: ten new burns across nodes, then the address waits.
        for i in 10..17 {
            assert_eq!(door_admit_lookup(Some(ip), &format!("light_door_node_{i}"), &burn(i), "b", false, now), Ok(()));
        }
        let wait = door_admit_lookup(Some(ip), "light_door_node_x", &burn(99), "b", false, now).unwrap_err();
        assert!(wait > 0 && wait <= DOOR_LOOKUP_WINDOW_SECS);
        assert_eq!(door_admit_lookup(Some(ip), "light_door_node_x", &burn(99), "b", false, now + DOOR_LOOKUP_WINDOW_SECS), Ok(()),
                   "the window slides");
        // A whitelisted address (localhost here) skips the address meter, never the node meter.
        let local: IpAddr = "127.0.0.1".parse().unwrap();
        for i in 20..23 { assert_eq!(door_admit_lookup(Some(local), "light_door_node_w", &burn(i), "b", false, now), Ok(())); }
        assert!(door_admit_lookup(Some(local), "light_door_node_w", &burn(23), "b", false, now).is_err());
        // One IPv6 subscriber holds a /64: its addresses share one meter.
        let a: IpAddr = "2001:db8:1:2::1".parse().unwrap();
        let b: IpAddr = "2001:db8:1:2:ffff::9".parse().unwrap();
        assert_eq!(lookup_meter_key(a), lookup_meter_key(b));
        assert_ne!(lookup_meter_key(a), lookup_meter_key("2001:db8:1:3::1".parse().unwrap()));
        assert_eq!(lookup_meter_key("::ffff:203.0.113.7".parse().unwrap()), "203.0.113.7");
    }

    #[test]
    fn one_attestation_round_per_node_at_a_time() {
        let now = 1_800_000_000;
        let first = SubmitInFlight::enter("light_inflight_a", now).expect("first");
        assert!(SubmitInFlight::enter("light_inflight_a", now + 5).is_none(), "the second waits");
        assert!(SubmitInFlight::enter("light_inflight_b", now).is_some(), "another node does not");
        drop(first);
        let again = SubmitInFlight::enter("light_inflight_a", now + 6).expect("free after the round");
        // A leaked mark is taken over, and the old holder's release does not free the new round.
        let late = SubmitInFlight::enter("light_inflight_a", now + 6 + SUBMIT_IN_FLIGHT_MAX_SECS).expect("taken over");
        drop(again);
        assert!(SubmitInFlight::enter("light_inflight_a", now + 7 + SUBMIT_IN_FLIGHT_MAX_SECS).is_none());
        drop(late);
    }

    fn pool() -> qnet_mempool::SimpleMempool {
        qnet_mempool::SimpleMempool::new(qnet_mempool::SimpleMempoolConfig { max_size: 100, min_gas_price: 1, max_per_sender: 10 })
    }

    fn pooled_registration(pool: &qnet_mempool::SimpleMempool, c: &CheckedSubmit, attest_epoch: u64) -> String {
        let mut c = c.clone();
        stamp_burn_attestation(&mut c, vec![("genesis_node_001".into(), "sig".into())], 1500, 1500, attest_epoch);
        assert!(pool.add_binary_transaction(bincode::serialize(&c.reg_tx).unwrap(), c.reg_tx.hash.clone(), 0));
        c.reg_tx.hash
    }

    /// U5 (b): a resubmit for a node whose registration the pool holds gets that hash, until its
    /// attestations reach the re-arm edge; the re-armed one then replaces it.
    #[test]
    fn a_resubmit_gets_the_pending_hash_until_the_rearm_edge() {
        let (body, t) = vector_submit(0);
        let c = check_client_submit(&req(&body), t, false).expect("checked");
        let node = body["node_id"].as_str().unwrap();
        let pool = pool();
        assert_eq!(reusable_pending_registration(&pool, node, 10), None);
        let h = pooled_registration(&pool, &c, 10);
        assert_eq!(reusable_pending_registration(&pool, node, 10), Some(h.clone()));
        assert_eq!(reusable_pending_registration(&pool, node, 11), Some(h.clone()), "the same hash again");
        assert_eq!(reusable_pending_registration(&pool, node, 12), None, "stale at the next epoch: re-arm");
        assert_eq!(reusable_pending_registration(&pool, node, 8), None, "attested ahead of this node's view");
        let h2 = pooled_registration(&pool, &c, 12);
        assert_ne!(h, h2);
        assert_eq!(reusable_pending_registration(&pool, node, 12), Some(h2), "the re-armed one replaced it");
        assert_eq!(pool.pending_registration_backlog(), 1);
    }

    /// H10: a member of the attest epoch's committee is a committee caller by the address it announced,
    /// in whatever spelling it announced it; an address outside the committee is not.
    #[tokio::test]
    async fn a_committee_member_is_known_by_its_announced_address() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        let epoch = 987_001u64; // an epoch no other test resolves: the address cache is per process
        let elig: Vec<qnet_state::EligibleProducer> = (0..5)
            .map(|i| qnet_state::EligibleProducer { node_id: format!("door_member_{i}"), reputation: 7000 })
            .collect();
        let mut cd = qnet_state::ConsensusData::default();
        cd.eligible_producers = Some(bincode::serialize(&elig).unwrap());
        cd.randomness_beacon = Some([3u8; 32]);
        let mb = qnet_state::MacroBlock::new(epoch - 2, 0, [0u8; 32], vec![], [1u8; 32], cd);
        storage.save_macroblock(epoch - 2, &mb).await.expect("save");
        let committee = BlockchainNode::committee_for_height(&storage, (epoch - 1) * 90 + 1).expect("committee");
        assert!(committee.len() >= 2);
        storage.save_node_endpoint(&committee[0], "http://[2001:db8:0:0::7]:8001").unwrap();
        storage.save_node_endpoint(&committee[1], "198.51.100.7:8001").unwrap();
        let set = committee_addresses(&storage, epoch);
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(set.contains(&ip("2001:db8::7")), "{set:?}");
        assert!(set.contains(&ip("198.51.100.7")));
        assert!(!set.contains(&ip("198.51.100.8")));
        assert!(set.contains(&canonical_ip(ip("::ffff:198.51.100.7"))), "an IPv4 caller seen through an IPv6 socket");
    }

    #[test]
    fn committee_callers_are_the_genesis_addresses_and_never_loopback() {
        let (g, _) = crate::genesis_constants::GENESIS_NODE_IPS[0];
        assert!(caller_is_genesis(g.parse().unwrap()));
        assert!(caller_is_genesis(canonical_ip(format!("::ffff:{g}").parse().unwrap())));
        // Loopback is whoever a terminator that passed no client on let through; this node asks its own
        // attestor in-process instead. A docker bridge is no committee member either.
        for not in ["127.0.0.1", "::1", "172.17.0.1", "203.0.113.7"] {
            assert!(!caller_is_genesis(not.parse().unwrap()), "{not}");
        }
        let collect = include_str!("../node/transactions.rs");
        let collect = &collect[collect.find("pub async fn collect_burn_attestations").expect("collector")..];
        assert!(collect.contains("crate::rpc::attest_burn_in_process("), "the collector asks itself in-process");
        assert!(!collect[..collect.find("\n    }\n").unwrap_or(collect.len())].contains("127.0.0.1"), "never over loopback");
    }

    /// H-3: the submit door and the super driver pool a registration only after the judge every peer and the
    /// producer run passes it at the next height; a refusal there is the retryable quorum_pending, never success.
    #[test]
    fn the_door_and_the_driver_pool_only_what_the_judge_takes() {
        let judge = "verify_burn_attestation_quorum(";
        let api = include_str!("registration_api.rs").replace("\r\n", "\n");
        let door = &api[api.find("pub(super) async fn handle_node_registration_client_submit(").expect("door")..];
        let at = |s: &str, pat: &str| s.find(pat).unwrap_or_else(|| panic!("missing {pat}"));
        assert!(at(door, "stamp_burn_attestation(") < at(door, judge));
        assert!(at(door, judge) < at(door, "mempool.add_binary_transaction("));
        let refusal = &door[at(door, judge)..at(door, "mempool.add_binary_transaction(")];
        assert!(refusal.contains("SubmitCode::QuorumPending") && !refusal.contains("\"success\": true"));
        assert!(door.contains("owner_bind_v2_allowed(&qnet_state::NodeType::Light, admission_height)"),
                "the door takes v2 exactly when the node lists owner_bind_v2");
        let act = include_str!("../node/activation.rs").replace("\r\n", "\n");
        let driver = &act[act.find("Self::collect_burn_attestations(").expect("driver")..];
        assert!(at(driver, "Self::sign_client_registration(&mut registration_tx") < at(driver, judge));
        assert!(at(driver, judge) < at(driver, "mempool.add_binary_transaction("));
    }
}
