//! Certified state proofs end to end. Blocks go through the consensus apply funnel with state
//! changes in every block (transfers, accounts created, an account emptied, a token whose holders
//! come and go), every block is stored with its root, and each macroblock is sealed through storage
//! 30 blocks after its boundary, with a checkpoint the committee signs with real ML-DSA keys.
//! Every answer is then read the way a light client reads it: verify macroblock j's certificate,
//! require it to name window head 90j, and fold the proof to that checkpoint's state_root, never
//! to the root the node served.

use super::certified_proofs::{certified_account_reply, certified_token_reply, state_certified_reply, wants_certified};
use crate::node::BlockchainNode;
use crate::storage::proof_view_rig::{attach, view_indices, wait_for, Rig};
use crate::storage::Storage;
use once_cell::sync::Lazy;
use qnet_consensus::checkpoint_bft::{quorum_size, sig_merkle_root, Checkpoint, QuorumCertificate, MACROBLOCK_INTERVAL};
use qnet_state::transaction::{deploy_code_hash, derive_contract_address, DeployKind};
use qnet_state::{Account, AccountLeafPreimage, LeafProofKind, MacroBlock, MicroBlock, StateMerkleTree, Transaction, TransactionType};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use warp::http::StatusCode;

const MB: u64 = MACROBLOCK_INTERVAL;
/// Macroblock j is sealed once the checkpoint 30 blocks past its boundary commits.
const SEAL_LAG: u64 = 30;
const WALLETS: u64 = 400;
/// Wallets below this move only in the scripted events, so their history is known exactly.
const SCRIPTED: u64 = 20;
const TOKEN_SUPPLY: u64 = 10_000_000;
const PRODUCER: &str = "genesis_node_001";
const COMMITTEE: [&str; 4] = ["genesis_node_001", "genesis_node_002", "genesis_node_003", "genesis_node_004"];
/// Created in window 3 (after macroblock 2).
const CREATED_AFTER_2: &str = "eon_e2e_created_in_window_3";
/// Created after macroblock 4, inside the window no macroblock covers yet.
const CREATED_AFTER_4: &str = "eon_e2e_created_in_window_5";
/// Created on an abandoned branch only.
const BRANCH_ONLY: &str = "eon_e2e_created_on_branch_a";

fn w(i: u64) -> String {
    format!("eon_e2e_w{:05}", i)
}

fn local() -> Option<SocketAddr> {
    Some(SocketAddr::new("127.0.0.1".parse().unwrap(), 0))
}

// ─── The committee ──────────────────────────────────────────────────────────────────────────────

struct Member {
    id: &'static str,
    pk: Vec<u8>,
    sk: pqcrypto_mldsa::mldsa65::SecretKey,
}

static MEMBERS: Lazy<Vec<Member>> = Lazy::new(|| {
    use pqcrypto_traits::sign::PublicKey as _;
    COMMITTEE.iter().map(|id| {
        let (pk, sk) = pqcrypto_mldsa::mldsa65::keypair();
        Member { id, pk: pk.as_bytes().to_vec(), sk }
    }).collect()
});

/// One member's vote over `hash`, in the compact form a stored certificate carries.
fn vote(m: &Member, hash: &[u8; 32]) -> Vec<u8> {
    use base64::{engine::general_purpose, Engine as _};
    use pqcrypto_traits::sign::SignedMessage as _;
    let msg = format!("QNET_BFT2_VOTE:{}", hex::encode(hash));
    let signed = pqcrypto_mldsa::mldsa65::sign(msg.as_bytes(), &m.sk);
    let sm = signed.as_bytes();
    let mut c = Vec::new();
    c.extend_from_slice(&(sm.len() as u32).to_le_bytes());
    c.extend_from_slice(sm);
    c.extend_from_slice(&(m.pk.len() as u32).to_le_bytes());
    c.extend_from_slice(&m.pk);
    let full = format!("dilithium_sig_{}_{}", m.id, general_purpose::STANDARD.encode(&c));
    qnet_consensus::consensus_crypto::strip_embedded_pk(&full).expect("a full vote strips").into_bytes()
}

/// The root a client folds to for index j: the checkpoint state_root of macroblock j, taken only
/// after its certificate verifies against the committee and names window head 90j.
fn verified_root(st: &Storage, j: u64) -> [u8; 32] {
    let raw = st.get_macroblock_by_height(j).expect("read").expect("macroblock stored");
    let mb: MacroBlock = BlockchainNode::macroblock_plaintext(raw)
        .and_then(|b| bincode::deserialize(&b).ok()).expect("macroblock decodes");
    let (cp, qc): (Checkpoint, QuorumCertificate) =
        bincode::deserialize(mb.consensus_data.checkpoint_qc.as_deref().expect("certificate")).expect("certificate decodes");
    assert_eq!(qc.checkpoint_hash, cp.hash(), "the certificate signs this checkpoint");
    assert_eq!(cp.window_head_height, j * MB, "the checkpoint names window head 90j");
    let committee: Vec<String> = COMMITTEE.iter().map(|s| s.to_string()).collect();
    let keys: HashMap<&str, &[u8]> = MEMBERS.iter().map(|m| (m.id, m.pk.as_slice())).collect();
    qc.verify(&committee, quorum_size(committee.len()), |voter: &str, body: &[u8], sig: &[u8]| {
        let Some(pk) = keys.get(voter) else { return false };
        std::str::from_utf8(sig).map_or(false, |s| qnet_consensus::consensus_crypto::verify_consensus_signature_compact(
            voter, &format!("QNET_BFT2_VOTE:{}", hex::encode(body)), s, pk))
    }).expect("the committee certified it");
    assert_eq!(mb.state_root, cp.state_root);
    cp.state_root
}

// ─── The client's reading of an answer ──────────────────────────────────────────────────────────

fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&hex::decode(s).expect("hex"));
    out
}

fn steps_of(v: &Value) -> Vec<([u8; 32], bool)> {
    v.as_array().expect("steps").iter()
        .map(|s| (hex32(s["sibling"].as_str().expect("sibling")), s["is_right"].as_bool().expect("is_right")))
        .collect()
}

fn entries_of(v: &Value) -> Vec<([u8; 32], [u8; 32])> {
    v.as_array().expect("entries").iter()
        .map(|e| (hex32(e["key"].as_str().expect("key")), hex32(e["leaf"].as_str().expect("leaf"))))
        .collect()
}

/// Every leaf field, strictly typed: u64 values are decimal strings, slot masks numbers.
fn fields_of(v: &Value, balance: &str, nonce: &str) -> AccountLeafPreimage {
    let text = |k: &str| v[k].as_str().unwrap_or_else(|| panic!("{} is a string", k)).parse::<u64>().expect("decimal");
    let slots = |k: &str| u16::try_from(v[k].as_u64().unwrap_or_else(|| panic!("{} is a number", k))).expect("u16");
    let is_contract = v["is_contract"].as_bool().expect("is_contract");
    assert_eq!(v["storage_root"].is_null(), !is_contract, "storage_root present exactly for a contract");
    AccountLeafPreimage {
        balance: text(balance),
        nonce: text(nonce),
        is_contract,
        is_node: v["is_node"].as_bool().expect("is_node"),
        contract_code_hash: v["contract_code_hash"].as_str().map(str::to_string),
        storage_root: v["storage_root"].as_str().map(hex32).unwrap_or([0u8; 32]),
        heartbeat_epoch: text("heartbeat_epoch"),
        heartbeat_slots: slots("heartbeat_slots"),
        heartbeat_final_epoch: text("heartbeat_final_epoch"),
        heartbeat_final_slots: slots("heartbeat_final_slots"),
        last_claimed_epoch: text("last_claimed_epoch"),
        banned_at_height: text("banned_at_height"),
    }
}

fn zero_fields() -> AccountLeafPreimage {
    AccountLeafPreimage::of(&Account::new(String::new()))
}

fn bound_to(v: &Value, j: u64) {
    assert_eq!(v["proof_format"], json!(2), "{}", v);
    assert_eq!(v["macroblock_index"], json!(j));
    assert_eq!(v["state_height"], json!(j * MB), "state_height is 90 * macroblock_index");
    assert!(v.get("block_height").is_none(), "the applied tip never appears in a certified body");
}

/// What a client accepts from an account answer at index j: Some(fields) proven present, None proven
/// absent. Panics on anything a client would reject.
fn client_account(v: &Value, address: &str, j: u64, root: &[u8; 32]) -> Option<AccountLeafPreimage> {
    bound_to(v, j);
    assert_eq!(v["address"], json!(address));
    let pre = fields_of(v, "balance", "nonce");
    let steps = steps_of(&v["merkle_proof"]);
    let (kind, fields) = match v["proof_kind"].as_str().expect("proof_kind") {
        "inclusion" => (LeafProofKind::Inclusion(pre.leaf_hash(address)), Some(pre)),
        "absence" => (LeafProofKind::Absence, None),
        "absence_in_bucket" => (LeafProofKind::AbsenceInBucket(entries_of(&v["bucket_entries"])), None),
        other => panic!("unknown proof kind {}", other),
    };
    assert_eq!(v["exists"], json!(fields.is_some()));
    if fields.is_none() {
        assert_eq!(fields_of(v, "balance", "nonce"), zero_fields(), "an absent account carries zero fields");
    }
    assert!(qnet_state::verify_account_proof(address, fields.as_ref(), &kind, &steps, root),
            "{} at index {} does not fold to the certified root", address, j);
    fields
}

/// What a client accepts from a token answer at index j: the contract status, the proven contract
/// fields, and the holder's balance (None = proven absent).
fn client_token(v: &Value, contract: &str, holder: &str, j: u64, root: &[u8; 32])
    -> (String, Option<AccountLeafPreimage>, Option<String>) {
    bound_to(v, j);
    assert_eq!((v["contract_address"].clone(), v["holder"].clone()), (json!(contract), json!(holder)));
    let pre = fields_of(v, "account_balance", "account_nonce");
    let steps = steps_of(&v["account_proof"]);
    let (kind, fields) = match v["account_proof_kind"].as_str().expect("account_proof_kind") {
        "inclusion" => (LeafProofKind::Inclusion(pre.leaf_hash(contract)), Some(pre)),
        "absence" => (LeafProofKind::Absence, None),
        "absence_in_bucket" => (LeafProofKind::AbsenceInBucket(entries_of(&v["account_bucket_entries"])), None),
        other => panic!("unknown proof kind {}", other),
    };
    assert!(qnet_state::verify_account_proof(contract, fields.as_ref(), &kind, &steps, root),
            "contract {} at index {} does not fold", contract, j);
    let status = v["contract_status"].as_str().expect("contract_status").to_string();
    let expected = match &fields { None => "absent", Some(f) if !f.is_contract => "not_contract", Some(_) => "contract" };
    assert_eq!(status, expected, "the status is what the proven leaf says");
    if status != "contract" {
        assert!(v.get("storage_proof").is_none() && v.get("token_balance").is_none());
        return (status, fields, None);
    }
    let storage_root = fields.as_ref().expect("contract").storage_root;
    let slot = format!("balance:{}", holder);
    let raw = v["token_balance"].as_str().expect("token_balance").to_string();
    let sv = steps_of(&v["storage_proof"]);
    let (skind, value) = match v["storage_proof_kind"].as_str().expect("storage_proof_kind") {
        "inclusion" => (LeafProofKind::Inclusion(StateMerkleTree::storage_leaf_value(&raw)), Some(raw.clone())),
        "absence" => (LeafProofKind::Absence, None),
        "absence_in_bucket" => (LeafProofKind::AbsenceInBucket(entries_of(&v["storage_bucket_entries"])), None),
        other => panic!("unknown proof kind {}", other),
    };
    if value.is_none() {
        assert_eq!(raw, "0", "an absent holder reads 0");
    }
    // The storage root comes from the proven contract leaf, never from a field of its own.
    assert!(qnet_state::verify_storage_proof(&slot, value.as_deref(), &skind, &sv, &storage_root),
            "{} in {} at index {} does not fold", holder, contract, j);
    (status, fields, value)
}

async fn parts(r: warp::reply::Response) -> (StatusCode, warp::http::HeaderMap, Value) {
    let status = r.status();
    let headers = r.headers().clone();
    let bytes = warp::hyper::body::to_bytes(r.into_body()).await.expect("body");
    (status, headers, serde_json::from_slice(&bytes).expect("json"))
}

fn q(mb: &str) -> Vec<(String, String)> {
    vec![("mb".to_string(), mb.to_string())]
}

/// A client honours `busy` and asks again; every other answer is returned as is.
async fn ask_account(st: &Arc<Storage>, address: &str, mb: &str) -> (StatusCode, Value) {
    for _ in 0..100 {
        let (status, _, v) = parts(certified_account_reply(st.clone(), address.to_string(), q(mb), local()).await).await;
        if status == StatusCode::SERVICE_UNAVAILABLE && v["error"] == json!("busy") {
            tokio::time::sleep(Duration::from_millis(20)).await;
            continue;
        }
        return (status, v);
    }
    panic!("busy throughout");
}

async fn ask_token(st: &Arc<Storage>, contract: &str, holder: &str, mb: &str) -> (StatusCode, Value) {
    for _ in 0..100 {
        let (status, _, v) = parts(certified_token_reply(st.clone(), contract.to_string(), holder.to_string(), q(mb), local()).await).await;
        if status == StatusCode::SERVICE_UNAVAILABLE && v["error"] == json!("busy") {
            tokio::time::sleep(Duration::from_millis(20)).await;
            continue;
        }
        return (status, v);
    }
    panic!("busy throughout");
}

async fn state_certified(st: &Storage) -> Value {
    parts(state_certified_reply(st, local())).await.2
}

// ─── The chain ──────────────────────────────────────────────────────────────────────────────────

#[derive(Clone)]
enum Amount {
    Fixed(u64),
    /// Everything the sender holds, read when the block is built.
    All,
}

#[derive(Clone)]
enum Event {
    Deploy,
    Transfer { from: String, to: String, amount: Amount },
    Token { from: String, to: String, amount: Amount },
}

/// The scripted history every chain shares; `extra` adds branch-specific events.
fn script(h: u64) -> Vec<Event> {
    use Amount::*;
    use Event::*;
    match h {
        1 => vec![Deploy],
        9 => vec![Token { from: w(1), to: w(11), amount: Fixed(5_000) }],
        12 => vec![Token { from: w(1), to: w(14), amount: Fixed(3_333) }],
        186 => vec![Transfer { from: w(10), to: CREATED_AFTER_2.to_string(), amount: Fixed(123_456) }],
        187 => vec![Transfer { from: w(7), to: w(8), amount: All }],
        189 => vec![Token { from: w(11), to: w(12), amount: All }],
        300 => vec![Token { from: w(1), to: w(13), amount: Fixed(777) }],
        365 => vec![Transfer { from: w(15), to: CREATED_AFTER_4.to_string(), amount: Fixed(1_000) }],
        _ => Vec::new(),
    }
}

struct Chain {
    r: Rig,
    tip: u64,
    /// Every block this node applied on its canonical chain.
    blocks: BTreeMap<u64, MicroBlock>,
    /// The accounts after every boundary block: what a certified answer at 90j must say.
    at: BTreeMap<u64, HashMap<String, Account>>,
    sealed: BTreeMap<u64, MacroBlock>,
    token: String,
    rng: u64,
    extra: HashMap<u64, Vec<Event>>,
}

impl Chain {
    fn genesis() -> Self {
        let r = crate::storage::proof_view_rig::rig();
        let accounts: Vec<(String, Account)> = (0..WALLETS).map(|i| {
            let mut a = Account::new(w(i));
            a.balance = 1_000_000_000_000 + i;
            (a.address.clone(), a)
        }).collect();
        r.sm.restore_accounts(accounts).expect("genesis");
        let token = derive_contract_address(&w(1), 1);
        Self { r, tip: 0, blocks: BTreeMap::new(), at: BTreeMap::new(), sealed: BTreeMap::new(), token, rng: 0x0E2E_5EED, extra: HashMap::new() }
    }

    fn next(&mut self) -> u64 {
        self.rng = self.rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.rng >> 17
    }

    fn token_balance(&self, holder: &str) -> u128 {
        self.r.sm.get_account(&self.token)
            .and_then(|t| t.contract_storage.get(&format!("balance:{}", holder)).cloned())
            .map_or(0, |b| b.parse().expect("balance"))
    }

    /// Transactions for block h: the scripted events, random transfers among the free wallets (a new
    /// account every tenth block), and from block 15 on, token moves every third block.
    fn txs_for(&mut self, h: u64) -> Vec<Transaction> {
        let mut pending: HashMap<String, u64> = HashMap::new();
        let mut nonce = |sm: &crate::StateManager, from: &str| {
            let n = pending.entry(from.to_string()).or_insert_with(|| sm.get_account(from).map_or(0, |a| a.nonce));
            *n += 1;
            *n
        };
        let mut events = script(h);
        events.extend(self.extra.get(&h).cloned().unwrap_or_default());
        let mut txs = Vec::new();
        for e in events {
            match e {
                Event::Deploy => {
                    let mut payload = json!({ "qrc20": true, "name": "E2E", "symbol": "E2E", "decimals": 9, "initial_supply": TOKEN_SUPPLY });
                    payload["code_hash"] = json!(deploy_code_hash(DeployKind::Qrc20, &payload).expect("digest"));
                    let n = nonce(&self.r.sm, &w(1));
                    assert_eq!(derive_contract_address(&w(1), n), self.token);
                    txs.push(Transaction::new(w(1), None, 0, n, 0, 1_000_000, h, None, TransactionType::ContractDeploy, Some(payload.to_string())));
                }
                Event::Transfer { from, to, amount } => {
                    let amount = match amount { Amount::Fixed(a) => a, Amount::All => self.r.sm.get_account(&from).expect("sender").balance };
                    let n = nonce(&self.r.sm, &from);
                    txs.push(transfer(&from, &to, amount, n, h));
                }
                Event::Token { from, to, amount } => {
                    let amount = match amount { Amount::Fixed(a) => a as u128, Amount::All => self.token_balance(&from) };
                    let n = nonce(&self.r.sm, &from);
                    txs.push(token_call(&from, &self.token, &to, amount, n, h));
                }
            }
        }
        if h >= 15 && h % 3 == 0 {
            let to = w(SCRIPTED + self.next() % (WALLETS - SCRIPTED));
            let amount = 1 + (self.next() % 50_000) as u128;
            let n = nonce(&self.r.sm, &w(1));
            txs.push(token_call(&w(1), &self.token, &to, amount, n, h));
            let holders: Vec<String> = (SCRIPTED..WALLETS).map(w).filter(|a| self.token_balance(a) > 0).collect();
            if !holders.is_empty() {
                let from = holders[(self.next() % holders.len() as u64) as usize].clone();
                let to = w(SCRIPTED + self.next() % (WALLETS - SCRIPTED));
                let have = self.token_balance(&from);
                let amount = if self.next() % 4 == 0 { have } else { 1 + (self.next() as u128 % have) };
                if from != to {
                    let n = nonce(&self.r.sm, &from);
                    txs.push(token_call(&from, &self.token, &to, amount, n, h));
                }
            }
        }
        for k in 0..36 {
            let from = w(SCRIPTED + self.next() % (WALLETS - SCRIPTED));
            let to = if k == 0 && h % 10 == 0 { format!("eon_e2e_new_{}", h) } else { w(SCRIPTED + self.next() % (WALLETS - SCRIPTED)) };
            let n = nonce(&self.r.sm, &from);
            txs.push(transfer(&from, &to, 1 + self.next() % 10_000, n, h));
        }
        txs
    }

    /// Apply one block as the pipeline does: the funnel, the stored block with its root, the
    /// account rows, the proof view request, the journal. A block taken again (a resync) must
    /// reproduce the root it was stored with.
    fn apply(&mut self, mut mb: MicroBlock) -> [u8; 32] {
        let h = mb.height;
        let (sm, st) = (&self.r.sm, &self.r.st);
        let mut expect: HashMap<String, u64> = HashMap::new();
        for tx in &mb.transactions { expect.insert(tx.from.clone(), tx.nonce); }
        let mut snap = sm.create_block_snapshot(h);
        let res = BlockchainNode::apply_block_to_state(sm, &mb, st, Some(&mut snap));
        assert!(!res.mirror_stale && res.reward_epoch_missing.is_none(), "block {} applied cleanly", h);
        for (from, n) in &expect {
            assert_eq!(sm.get_account(from).map(|a| a.nonce), Some(*n), "every transaction of block {} applied ({})", h, from);
        }
        if mb.state_root != [0u8; 32] {
            assert_eq!(res.merkle_root, mb.state_root, "block {} reproduces its committed root", h);
        }
        mb.state_root = res.merkle_root;
        st.save_microblock(h, &bincode::serialize(&mb).expect("encode")).expect("stored");
        let (puts, dels) = crate::storage::account_delta(sm, &snap);
        st.mirror_block_delta(h, puts, dels);
        st.request_proof_view(sm, h);
        sm.retain_block_journal(snap);
        if h % MB == 0 {
            self.at.insert(h, sm.get_all_accounts().into_iter().collect());
        }
        self.blocks.insert(h, mb);
        self.tip = h;
        res.merkle_root
    }

    fn build(&mut self, h: u64) -> MicroBlock {
        let txs = self.txs_for(h);
        let parent = self.blocks.get(&(h - 1)).map(|b| b.hash()).unwrap_or([0u8; 32]);
        MicroBlock::new(h, 1_700_000_000 + h, parent, txs, PRODUCER.to_string())
    }

    /// Build and apply blocks up to `target`, sealing each macroblock 30 blocks after its boundary.
    async fn advance_to(&mut self, target: u64) {
        while self.tip < target {
            let h = self.tip + 1;
            let mb = self.build(h);
            self.apply(mb);
            if h % MB == SEAL_LAG && h > MB {
                self.seal((h - SEAL_LAG) / MB).await;
            }
        }
    }

    /// Take known blocks again (a resync after a rollback), re-storing the macroblocks sealed before.
    async fn resync_to(&mut self, target: u64) {
        while self.tip < target {
            let h = self.tip + 1;
            let mb = self.blocks[&h].clone();
            self.apply(mb);
            if h % MB == SEAL_LAG && h > MB {
                let j = (h - SEAL_LAG) / MB;
                let sealed = self.sealed[&j].clone();
                self.r.st.save_macroblock(j, &sealed).await.expect("re-stored");
            }
        }
    }

    /// Seal macroblock j as the committee does: its checkpoint carries the stored window head's root,
    /// every member signs, and storage keeps it after checking that root against the stored block.
    async fn seal(&mut self, j: u64) {
        let head = j * MB;
        let head_mb = self.r.st.load_microblock_auto_format(head).expect("read").expect("window head stored");
        let window: Vec<[u8; 32]> = ((head - MB + 1)..=head).map(|h| self.blocks[&h].hash()).collect();
        let cp = Checkpoint {
            index: 3 * j, parent_qc: None, window_head_height: head, window_mb_hashes: window.clone(),
            state_root: head_mb.state_root, beacon: [3u8; 32], epoch_commitment: [0u8; 32], reward_root: [0u8; 32],
            registry_root: [0u8; 32], logs_root: [0u8; 32], dilithium_pk_root: [0u8; 32], reward_epoch_root: [0u8; 32],
            total_supply: 0, timestamp: head_mb.timestamp, proposer: PRODUCER.to_string(), proposer_sig: Vec::new(),
            recovery_anchor: None,
        };
        let hash = cp.hash();
        let sigs: Vec<Vec<u8>> = MEMBERS.iter().map(|m| vote(m, &hash)).collect();
        let qc = QuorumCertificate {
            checkpoint_hash: hash, index: cp.index, signers: COMMITTEE.iter().map(|s| s.to_string()).collect(),
            sig_merkle_root: sig_merkle_root(&sigs), sigs,
        };
        let mut cd = qnet_state::ConsensusData::default();
        cd.checkpoint_qc = Some(bincode::serialize(&(cp.clone(), qc)).expect("encode"));
        let prev = self.sealed.get(&(j - 1)).map(|m| m.hash()).unwrap_or([0u8; 32]);
        let mb = MacroBlock::new(j, head_mb.timestamp, prev, window, cp.state_root, cd);
        self.r.st.save_macroblock(j, &mb).await.expect("sealed");
        self.sealed.insert(j, mb);
    }

    fn settle(&self) {
        self.r.sm.merkle_flush_barrier();
        crate::storage::proof_view_rig::settle(&self.r);
    }

    /// Stop the node and start it again on the same data directory: views and the aux DB go, the
    /// tree DB and the chain stay.
    fn restart(self) -> Self {
        self.settle();
        let Chain { r, tip, blocks, at, sealed, token, rng, extra } = self;
        let Rig { st, sm, dir } = r;
        drop(sm);
        drop(st);
        let st = Arc::new(Storage::new(dir.path().to_str().unwrap()).expect("reopen"));
        let sm = attach(&st);
        Chain { r: Rig { st, sm, dir }, tip, blocks, at, sealed, token, rng, extra }
    }

    /// The boot path after a restart or a rollback: the boundary snapshot at `anchor` restored and
    /// checked against its certified root, its view requested, then every stored block above it up to
    /// `to` replayed through the boot replay.
    fn boot_from(&mut self, anchor: u64, to: u64) {
        let accounts: Vec<(String, Account)> = self.at[&anchor].clone().into_iter().collect();
        let root = self.r.sm.restore_accounts_streamed(accounts).expect("tier 1 restore");
        assert_eq!(root, verified_root(&self.r.st, anchor / MB), "the anchor matches its certified root");
        self.r.st.request_proof_view(&self.r.sm, anchor);
        for h in anchor + 1..=to {
            let mb = self.r.st.load_microblock_auto_format(h).expect("read").expect("stored block");
            assert_eq!(mb.transactions.len(), self.blocks[&h].transactions.len(), "block {} read back whole", h);
            if let Err(stop) = BlockchainNode::replay_block_verified(&self.r.sm, &self.r.st, &mb) {
                panic!("block {} did not replay: {:?}", h, stop);
            }
        }
        self.tip = to;
        self.settle();
    }

    fn st(&self) -> &Arc<Storage> {
        &self.r.st
    }
}

fn transfer(from: &str, to: &str, amount: u64, nonce: u64, ts: u64) -> Transaction {
    Transaction::new(from.to_string(), Some(to.to_string()), amount, nonce, 0, qnet_state::gas_limits::TRANSFER, ts, None,
                     TransactionType::Transfer { from: from.to_string(), to: to.to_string(), amount }, None)
}

fn token_call(from: &str, contract: &str, to: &str, amount: u128, nonce: u64, ts: u64) -> Transaction {
    let data = json!({ "method": "transfer", "args": [to, amount.to_string()] }).to_string();
    Transaction::new(from.to_string(), Some(contract.to_string()), 0, nonce, 0, 1_000_000, ts, None,
                     TransactionType::ContractCall, Some(data))
}

/// Addresses a check covers at index j: scripted wallets, a spread of the free ones, the created
/// and emptied accounts, the token, the deposit escrow and an address nobody ever used.
fn account_sample(token: &str, offset: u64) -> Vec<String> {
    let mut v: Vec<String> = (0..SCRIPTED).map(w).collect();
    v.extend((SCRIPTED + offset..WALLETS).step_by(13).map(w));
    v.extend([CREATED_AFTER_2, CREATED_AFTER_4, BRANCH_ONLY, "eon_e2e_never_used", qnet_state::transaction::STORAGE_RENT_ESCROW_ADDR]
        .iter().map(|s| s.to_string()));
    v.push(token.to_string());
    v
}

fn holder_sample(offset: u64) -> Vec<String> {
    let mut v: Vec<String> = [1, 11, 12, 13, 14, 16, 17].iter().map(|i| w(*i)).collect();
    v.extend((SCRIPTED + offset..WALLETS).step_by(11).map(w));
    v.push("eon_e2e_never_held".to_string());
    v
}

/// Check every sampled account and holder at index j against the model, through the RPC.
async fn check_index(chain: &Chain, j: u64, offset: u64) {
    let st = chain.st();
    let root = verified_root(st, j);
    let model = &chain.at[&(j * MB)];
    for addr in account_sample(&chain.token, offset) {
        let (status, v) = ask_account(st, &addr, &j.to_string()).await;
        assert_eq!(status, StatusCode::OK, "{} at {}: {}", addr, j, v);
        let got = client_account(&v, &addr, j, &root);
        assert_eq!(got, model.get(&addr).map(AccountLeafPreimage::of), "{} at index {}", addr, j);
    }
    let token = &model[&chain.token];
    for holder in holder_sample(offset) {
        let (status, v) = ask_token(st, &chain.token, &holder, &j.to_string()).await;
        assert_eq!(status, StatusCode::OK, "{} at {}: {}", holder, j, v);
        let (s, fields, balance) = client_token(&v, &chain.token, &holder, j, &root);
        assert_eq!(s, "contract");
        assert_eq!(fields, Some(AccountLeafPreimage::of(token)));
        assert_eq!(balance.as_ref(), token.contract_storage.get(&format!("balance:{}", holder)), "{} holds at {}", holder, j);
    }
}

/// The same check straight on the view, past the answer cache: what a rebuilt view proves.
fn check_view_directly(chain: &Chain, j: u64) {
    let st = chain.st();
    let root = verified_root(st, j);
    let set = st.proof_views().current();
    let view = set.views.iter().find(|v| v.index == j).expect("view held");
    assert_eq!(view.root, root);
    let model = &chain.at[&(j * MB)];
    for addr in account_sample(&chain.token, 3) {
        let a = st.certified_account_proof(view, &addr).expect("proves");
        assert_eq!(a.fields, model.get(&addr).map(AccountLeafPreimage::of), "{} at {}", addr, j);
        assert!(qnet_state::verify_account_proof(&addr, a.fields.as_ref(), &a.kind, &a.steps, &root));
    }
    let token = &model[&chain.token];
    for holder in holder_sample(5) {
        let t = st.certified_token_proof(view, &chain.token, &holder).expect("proves");
        let s = t.storage.expect("a contract");
        assert_eq!(s.value.as_ref(), token.contract_storage.get(&format!("balance:{}", holder)));
        assert!(qnet_state::verify_storage_proof(&format!("balance:{}", holder), s.value.as_deref(), &s.kind, &s.steps, &token.storage_root));
    }
}

// ─── The scenarios ──────────────────────────────────────────────────────────────────────────────

// Blocks 1..395 change state in every block; macroblocks 1..4 are sealed 30 blocks after their
// boundaries. Answers for c=4, c-1 and c-2 fold to exactly the root each sealed checkpoint carries,
// and say what the state was at 90j: an account created or emptied after a macroblock, a holder
// drained or added after it, an account created after the newest one.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn certified_proofs_verify_against_the_sealed_checkpoint_root() {
    let mut chain = Chain::genesis();
    chain.advance_to(395).await;
    chain.settle();
    wait_for("views 4, 3, 2", || view_indices(&chain.r) == vec![4, 3, 2]);
    let st = chain.st().clone();

    let v = state_certified(&st).await;
    let listed: Vec<Value> = [4u64, 3, 2].iter()
        .map(|j| json!({ "macroblock_index": j, "state_height": j * MB, "state_root": hex::encode(verified_root(&st, *j)) }))
        .collect();
    assert_eq!(v["views"], json!(listed), "each view names the root its sealed checkpoint carries");
    assert_eq!((v["newest_certified_index"].clone(), v["capture"].clone()), (json!(4), json!("ok")));

    for j in [4u64, 3, 2] {
        check_index(&chain, j, j % 3).await;
    }

    // The scripted history, as a client reads it.
    let read = |j: u64, addr: &str| {
        let (st, addr) = (st.clone(), addr.to_string());
        async move {
            let (status, v) = ask_account(&st, &addr, &j.to_string()).await;
            assert_eq!(status, StatusCode::OK);
            client_account(&v, &addr, j, &verified_root(&st, j))
        }
    };
    assert!(read(2, CREATED_AFTER_2).await.is_none(), "created after macroblock 2: proven absent at 2");
    assert_eq!(read(3, CREATED_AFTER_2).await.map(|f| f.balance), Some(123_456));
    let y_at_2 = read(2, &w(7)).await.expect("w7 exists at 2");
    assert!(y_at_2.balance > 0);
    for j in [3u64, 4] {
        let y = read(j, &w(7)).await.expect("an emptied account still exists");
        assert_eq!((y.balance, y.nonce), (0, y_at_2.nonce + 1), "emptied at block 187");
        assert!(read(j, CREATED_AFTER_4).await.is_none(), "created after macroblock 4: absent at {}", j);
    }
    assert!(chain.r.sm.get_account(CREATED_AFTER_4).is_some(), "while the live state already holds it");
    let held = |j: u64, h: u64| {
        let (st, token) = (st.clone(), chain.token.clone());
        async move {
            let (status, v) = ask_token(&st, &token, &w(h), &j.to_string()).await;
            assert_eq!(status, StatusCode::OK);
            client_token(&v, &token, &w(h), j, &verified_root(&st, j)).2
        }
    };
    assert_eq!(held(2, 11).await.as_deref(), Some("5000"), "w11 holds at 2");
    assert_eq!((held(3, 11).await, held(4, 11).await), (None, None), "drained at block 189");
    assert_eq!((held(2, 13).await, held(3, 13).await), (None, None), "w13 receives at block 300");
    assert_eq!(held(4, 13).await.as_deref(), Some("777"));

    // A contract that does not exist and a plain account asked as one: proven negatives.
    let (status, v) = ask_token(&st, "eon_e2e_no_such_contract", &w(30), "4").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(client_token(&v, "eon_e2e_no_such_contract", &w(30), 4, &verified_root(&st, 4)).0, "absent");
    let (status, v) = ask_token(&st, &w(31), &w(30), "4").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(client_token(&v, &w(31), &w(30), 4, &verified_root(&st, 4)).0, "not_contract");

    // `latest` is the newest view with the indices this node serves.
    let (status, v) = ask_account(&st, &w(33), "latest").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["servable"], json!([4, 3, 2]));
    assert_eq!(client_account(&v, &w(33), 4, &verified_root(&st, 4)), chain.at[&360].get(&w(33)).map(AccountLeafPreimage::of));

    // The legacy route is untouched: without `mb` it answers from the live root at the applied tip,
    // which folds against that root and, once the account moved past the newest macroblock, against
    // no certified root at all — the failure the certified form exists to remove.
    assert!(!wants_certified(&[]));
    let live = chain.r.sm.get_balance_with_proof(&w(15)).expect("legacy proof");
    let body = super::queries_api::legacy_balance_proof_body(&live);
    assert_eq!(body["block_height"], json!(395), "the applied tip");
    assert_eq!(body["state_root"], json!(hex::encode(chain.r.sm.get_merkle_state_root())), "the live root");
    assert_eq!(body["proof_valid"], json!(true));
    assert!(qnet_state::State::verify_balance_proof(&live), "it folds to the live root");
    let w15 = AccountLeafPreimage::of(&chain.r.sm.get_account(&w(15)).unwrap());
    for j in [4u64, 3, 2] {
        assert!(!qnet_state::verify_account_proof(&w(15), Some(&w15), &LeafProofKind::Inclusion(w15.leaf_hash(&w(15))), &live.proof, &verified_root(&st, j)),
                "a live-root proof of an account that moved after 360 folds to no certified root ({})", j);
    }
}

// The node stops mid-window, after macroblock 4 and before macroblock 5. Until the boot rebuilds
// anything every certified read is refused with its reason; after the Tier-1 restore at 270 and
// the replay of 271..405 the views at and above the anchor are back, the one below it is reported
// not retained, and the chain carries on to the next seal.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restart_mid_window_rebuilds_views_or_reports_them_missing() {
    let mut chain = Chain::genesis();
    chain.advance_to(405).await;
    chain.settle();
    wait_for("views 4, 3, 2", || view_indices(&chain.r) == vec![4, 3, 2]);
    check_index(&chain, 4, 0).await;

    let mut chain = chain.restart();
    let st = chain.st().clone();
    assert!(st.proof_views().current().views.is_empty(), "no view survives a restart");
    let v = state_certified(&st).await;
    assert_eq!((v["views"].clone(), v["newest_certified_index"].clone()), (json!([]), json!(4)));
    assert_ne!(v["capture"], json!("ok"), "nothing is captured before the boot rebuilds: {}", v);
    let (status, v) = ask_account(&st, &w(40), "latest").await;
    assert_eq!((status, v["error"].clone(), v["servable"].clone()),
               (StatusCode::SERVICE_UNAVAILABLE, json!("certified_state_unavailable"), json!([])));
    let (status, v) = ask_account(&st, &w(40), "4").await;
    assert_eq!((status, v["error"].clone()), (StatusCode::GONE, json!("view_not_retained")), "{}", v);
    let (status, v) = ask_account(&st, &w(40), "5").await;
    assert_eq!((status, v["error"].clone()), (StatusCode::NOT_FOUND, json!("macroblock_not_certified")));

    chain.boot_from(270, 405);
    wait_for("views 4, 3 after the boot", || view_indices(&chain.r) == vec![4, 3]);
    let (status, v) = ask_account(&st, &w(40), "2").await;
    assert_eq!((status, v["error"].clone(), v["servable"].clone()), (StatusCode::GONE, json!("view_not_retained"), json!([4, 3])),
               "below the anchor: honestly not retained");
    for j in [4u64, 3] {
        check_view_directly(&chain, j);
        check_index(&chain, j, 1).await;
    }

    chain.advance_to(5 * MB + SEAL_LAG).await;
    chain.settle();
    wait_for("views 5, 4, 3", || view_indices(&chain.r) == vec![5, 4, 3]);
    for j in [5u64, 4, 3] {
        check_index(&chain, j, 2).await;
    }
}

// An operator rollback to 300 lies below view 4 (height 360) and above view 3 (270). View 4 goes
// with its macroblock; index 4 is then not certified here, and latest is view 3. The state is
// rebuilt from 270, the same certified chain comes back by sync, and view 4 returns with the same
// root and the same proofs.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_operator_rollback_below_a_view_retracts_it_and_the_resync_restores_it() {
    let mut chain = Chain::genesis();
    chain.advance_to(395).await;
    chain.settle();
    wait_for("views 4, 3, 2", || view_indices(&chain.r) == vec![4, 3, 2]);
    let st = chain.st().clone();
    let before: Vec<(String, Vec<([u8; 32], bool)>)> = {
        let set = st.proof_views().current();
        let view = &set.views[0];
        account_sample(&chain.token, 0).into_iter()
            .map(|a| { let p = st.certified_account_proof(view, &a).expect("proves"); (a, p.steps) })
            .collect()
    };

    st.retract_chain_position_above(300);
    st.delete_microblocks_range(301, 395).expect("blocks above the target go");
    st.set_chain_height(300).expect("tip lowered");
    assert_eq!(view_indices(&chain.r), vec![3, 2], "the view above the target goes with its macroblock");
    let v = state_certified(&st).await;
    assert_eq!(v["newest_certified_index"], json!(3));
    let (status, v) = ask_account(&st, &w(50), "4").await;
    assert_eq!((status, v["error"].clone(), v["newest_certified_index"].clone()),
               (StatusCode::NOT_FOUND, json!("macroblock_not_certified"), json!(3)));
    let (status, v) = ask_account(&st, &w(50), "latest").await;
    assert_eq!((status, v["macroblock_index"].clone(), v["servable"].clone()), (StatusCode::OK, json!(3), json!([3, 2])));
    client_account(&v, &w(50), 3, &verified_root(&st, 3));

    chain.boot_from(270, 300);
    chain.resync_to(395).await;
    chain.settle();
    wait_for("view 4 back", || view_indices(&chain.r) == vec![4, 3, 2]);
    let set = st.proof_views().current();
    assert_eq!(set.views[0].root, verified_root(&st, 4), "the same certified root");
    for (a, steps) in before {
        assert_eq!(st.certified_account_proof(&set.views[0], &a).expect("proves").steps, steps, "{}: the same proof", a);
    }
    for j in [4u64, 3, 2] {
        check_index(&chain, j, 1).await;
    }
}

// Branch A applies 356..365 (with token moves and an account of its own) and offers a candidate
// at 360; a shallow undo takes the node back to 355 and branch B is applied instead. The committee
// seals B's root: only B's state is ever served at index 4, and the token's storage rows, taken
// back through the undo and forward through B, prove B's balances.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_shallow_undo_below_a_candidate_serves_only_the_sealed_branch() {
    let mut chain = Chain::genesis();
    chain.advance_to(355).await;
    chain.settle();
    chain.extra.insert(357, vec![Event::Token { from: w(14), to: w(16), amount: Amount::Fixed(1_111) }]);
    chain.extra.insert(358, vec![Event::Transfer { from: w(9), to: BRANCH_ONLY.to_string(), amount: Amount::Fixed(9_999) }]);
    let rng_at_355 = chain.rng;
    let root_a = {
        let mut root = [0u8; 32];
        for h in 356..=365 {
            let mb = chain.build(h);
            let r = chain.apply(mb);
            if h == 360 { root = r; }
        }
        root
    };
    chain.settle();
    assert!(chain.st().proof_views().candidate(360).map_or(false, |c| c.1 && c.2), "branch A's boundary is a complete candidate");

    // The undo, as the pipeline runs it: journals back to 355, the root proven against the stored
    // block, the rows mirrored, the abandoned blocks dropped from storage.
    let (undone, mirror, _) = chain.r.sm.undo_blocks_above(355, 365).expect("journals cover the range");
    assert_eq!(undone, 10);
    let root_355 = chain.r.sm.finalize_merkle();
    assert_eq!(root_355, chain.blocks[&355].state_root, "the undo lands on block 355's root");
    chain.r.sm.chain_state.write().height = 355;
    let (puts, dels): (Vec<_>, Vec<_>) = mirror.into_iter().partition(|(_, a)| a.is_some());
    let _ = chain.st().mirror_enqueue(puts.into_iter().map(|(k, a)| (k, a.unwrap())).collect(), dels.into_iter().map(|(k, _)| k).collect());
    chain.st().delete_microblocks_range(356, 365).expect("abandoned blocks go");
    chain.st().set_chain_height(355).expect("tip lowered");
    for h in 356..=365 { chain.blocks.remove(&h); }
    chain.tip = 355;

    chain.extra.clear();
    chain.extra.insert(357, vec![Event::Token { from: w(14), to: w(17), amount: Amount::Fixed(2_222) }]);
    chain.rng = rng_at_355 ^ 0xB;
    chain.advance_to(365).await;
    let root_b = chain.blocks[&360].state_root;
    assert_ne!(root_a, root_b, "the branches differ at 360");
    let (status, v) = ask_account(chain.st(), &w(60), "4").await;
    assert_eq!((status, v["error"].clone()), (StatusCode::NOT_FOUND, json!("macroblock_not_certified")), "unsealed: not served");

    chain.advance_to(4 * MB + SEAL_LAG).await;
    chain.settle();
    wait_for("view 4", || view_indices(&chain.r).first() == Some(&4));
    let st = chain.st().clone();
    assert_eq!(verified_root(&st, 4), root_b, "the committee sealed branch B");
    assert_eq!(st.proof_views().current().views[0].root, root_b, "and only B is served");
    check_index(&chain, 4, 0).await;
    check_view_directly(&chain, 4);
    let root = verified_root(&st, 4);
    let (_, v) = ask_account(&st, BRANCH_ONLY, "4").await;
    assert!(client_account(&v, BRANCH_ONLY, 4, &root).is_none(), "branch A's account is absent");
    let (_, v) = ask_token(&st, &chain.token, &w(16), "4").await;
    assert_eq!(client_token(&v, &chain.token, &w(16), 4, &root).2, None, "branch A's holder is absent");
    let (_, v) = ask_token(&st, &chain.token, &w(17), "4").await;
    assert_eq!(client_token(&v, &chain.token, &w(17), 4, &root).2.as_deref(), Some("2222"), "branch B's holder");
    let (_, v) = ask_token(&st, &chain.token, &w(14), "4").await;
    assert_eq!(client_token(&v, &chain.token, &w(14), 4, &root).2.as_deref(), Some("1111"), "w14 paid B's 2222 of its 3333");
}

// What a request costs through the RPC layer (pool, build, self-check, JSON), cache misses and
// cache hits, over a view of 20k accounts and a 5k-holder token.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn certified_rpc_cost_per_request() {
    use crate::storage::proof_view_rig::{block, certify, rig, wallet};
    let r = rig();
    let token = "eon_e2e_cost_token";
    let mut all: Vec<(String, Account)> = (0..20_000u64).map(|i| { let a = wallet(i, 50_000 + i); (a.address.clone(), a) }).collect();
    let mut t = Account::new(token.to_string());
    t.is_contract = true;
    t.contract_code_hash = Some("ab".repeat(32));
    t.contract_storage = (0..5_000u64).map(|i| (format!("balance:eon_e2e_ch{:05}", i), format!("{}", 7 + i))).collect();
    t.storage_root = StateMerkleTree::compute_storage_root(&t.contract_storage);
    all.push((token.to_string(), t));
    r.sm.restore_accounts(all).expect("restore");
    let mut root = [0u8; 32];
    for h in 1..=MB { root = block(&r, h); }
    certify(&r, MB, root);
    wait_for("the view", || view_indices(&r) == vec![1]);
    let report = |what: &str, mut d: Vec<Duration>, bytes: usize| {
        d.sort();
        let pick = |p: f64| d[((d.len() - 1) as f64 * p).round() as usize].as_secs_f64() * 1e6;
        println!("[MEASURE][RPC] {} n={} p50_us={:.0} p99_us={:.0} max_us={:.0} body_bytes_avg={}",
                 what, d.len(), pick(0.5), pick(0.99), pick(1.0), bytes / d.len().max(1));
        Duration::from_secs_f64(pick(0.99) / 1e6)
    };
    let (mut miss, mut hit, mut tok) = (Vec::new(), Vec::new(), Vec::new());
    let (mut miss_bytes, mut tok_bytes) = (0usize, 0usize);
    for i in 0..400u64 {
        let addr = wallet((i * 37) % 20_000, 0).address;
        let t0 = Instant::now();
        let resp = certified_account_reply(r.st.clone(), addr.clone(), q("1"), local()).await;
        let elapsed = t0.elapsed();
        let bytes = warp::hyper::body::to_bytes(resp.into_body()).await.expect("body");
        miss.push(elapsed);
        miss_bytes += bytes.len();
        let t0 = Instant::now();
        let resp = certified_account_reply(r.st.clone(), addr, q("1"), local()).await;
        hit.push(t0.elapsed());
        let _ = warp::hyper::body::to_bytes(resp.into_body()).await;
    }
    for i in 0..200u64 {
        let holder = format!("eon_e2e_ch{:05}", (i * 53) % 6_000);
        let t0 = Instant::now();
        let resp = certified_token_reply(r.st.clone(), token.to_string(), holder, q("1"), local()).await;
        tok.push(t0.elapsed());
        tok_bytes += warp::hyper::body::to_bytes(resp.into_body()).await.expect("body").len();
    }
    let p99 = [report("account_miss", miss, miss_bytes), report("account_cache_hit", hit, 0), report("token", tok, tok_bytes)];
    for d in p99 {
        assert!(d < Duration::from_millis(250), "p99 {:?}", d);
    }
}
