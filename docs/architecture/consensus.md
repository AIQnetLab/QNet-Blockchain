# Consensus

This document describes how QNet orders and finalizes blocks: the fixed slot cadence and its clock-independent timestamps,
producer election and rotation, the candidate roster, what a microblock commits to, how Checkpoint-BFT turns a window of
microblocks into irreversible state through a quorum certificate, producer failover, the exact fork-choice precedence, and
the bounds on reorganisation.

## Chain structure

QNet runs two tiers over one block history. A single elected producer streams microblocks at a fixed slot; separately, a
committee runs Checkpoint-BFT over windows of those microblocks and issues quorum certificates that finalize them.
Macroblocks are sealed at the coarser cadence and carry the epoch snapshot the next windows elect from.

| Parameter | Name | Value | Defined in |
|---|---|---|---|
| Microblock slot | `MICROBLOCK_INTERVAL_SECS` | 1 second | `development/qnet-integration/src/node/mod.rs` |
| Producer rotation | `ROTATION_INTERVAL_BLOCKS` | 30 microblocks | `development/qnet-integration/src/node/mod.rs` |
| Finality checkpoint | `CHECKPOINT_INTERVAL` | 30 microblocks | `core/qnet-consensus/src/checkpoint_bft.rs` |
| Macroblock / epoch | `MACROBLOCK_INTERVAL` | 90 microblocks | `core/qnet-consensus/src/checkpoint_bft.rs` |
| Committee cap | `COMMITTEE_SIZE` / `COMMITTEE_THRESHOLD` | 1000 / 1000 | `core/qnet-consensus/src/checkpoint_bft.rs` |
| Producer roster cap | `MAX_VALIDATORS` | 1000 | `development/qnet-integration/src/node/mod.rs` |
| BFT view timeout | `VIEW_TIMEOUT_MS` | 4000 ms | `core/qnet-consensus/src/checkpoint_bft.rs` |
| Consensus state retained | `CONSENSUS_STATE_RETAIN` | 128 checkpoint indices | `core/qnet-consensus/src/checkpoint_bft.rs` |

A compile-time assertion enforces that `CHECKPOINT_INTERVAL` divides `MACROBLOCK_INTERVAL`, so every macroblock boundary is
also a checkpoint boundary. With rotation at 30 and the macroblock window at 90, exactly three elected producers cover one
macroblock window. Finality does not wait for a macroblock: intra-window checkpoints finalize without sealing anything.
`CHECKPOINT_INTERVAL`, `COMMITTEE_SIZE` and `VIEW_TIMEOUT_MS` are compile-time constants: they are consensus parameters,
divergent values produce divergent checkpoint chains, so changing one requires a network-wide rebuild.

### Consensus feature gates

A rule change that takes effect the moment a node runs it diverges that node from peers still on the previous binary.
`qnet-state`'s feature-gate registry binds such a change to an activation height instead. `ACTIVATIONS` is a hard-coded
list of `(feature id, activation height)` pairs compiled into every binary, and `is_active(feature, height)` is a pure
function of the two, so every node flips the rule at the same height whatever time its binary was deployed. A feature
with no entry is active from genesis — the default — so only a rule that must stay dormant until a coordinated height
needs a row. Shipping a rolling-safe rule change is therefore: add the pair at a future height, gate the divergent
branch on `is_active`, and deploy the binary everywhere before that height.

| Feature id | Rule it gates | Activation height |
|---|---|---|
| `burn_attestation_required` | a non-genesis `NodeRegistration` carries a genesis burn-attestation quorum | 0 |
| `registry_root_required` | a checkpoint's `registry_root` matches the validator's own recompute, and a snapshot's restored `node_registry` matches the anchor macroblock's committed root | 0 |
| `light_reg_epoch_roster` | the light-reward roster freezes at the commit-window open, so a node registered mid-epoch earns for that epoch | 0 |
| `logs_root_required` | a checkpoint's `logs_root` matches the validator's recompute | 0 |
| `reward_epoch_root_required` | a checkpoint's `reward_epoch_root` matches the validator's walk of the epoch grid | 0 |

All five stand at height 0, so the chain runs every one of these rules from the genesis block. Because the heights live
in the binary, agreement needs no on-chain governance vote. See
[maintenance](../operators/maintenance.md#upgrading-a-node) for how a gated change is rolled out.

## Slot cadence and block timestamps

A microblock timestamp is a pure function of its height, anchored to the genesis block's timestamp:

```
expected_block_timestamp(genesis_ts, height) = genesis_ts + height * MICROBLOCK_INTERVAL_SECS
```

The verify stage rejects any live (non-syncing) microblock whose `timestamp` is not exactly this value. Blocks arriving
through sync skip the check, because their timestamp is already bound by the block hash, the producer's signature and the
hash chain. The wall clock is therefore not a consensus input: two nodes with different clocks derive the same expected
timestamp for every height. The `QNET_MICROBLOCK_INTERVAL` environment variable affects only local production pacing — it
does not enter `expected_block_timestamp`, which uses the constant.

## Producer rotation

### Leadership round

Leadership rotates every `ROTATION_INTERVAL_BLOCKS` microblocks, and the round index derives from height alone: round 0 for
height 0 and heights 1..=30, and `(height - 1) / 30` above that. Blocks 1-30 are round 0, 31-60 round 1, 61-90 round 2.
Every derivation that needs a height uses the *round start height* (round 0 → height 1, round N → `N*30+1`) rather than the
current height, so the elected index is stable for the whole rotation window regardless of when a node first computes it.

### The leader hash

Election is a deterministic hash evaluated in three stages. All inputs are on-chain, so every synchronized node computes the
same result with no message exchange.

**1. Epoch entropy.** For a window whose epoch is `N = (height-1)/90 + 1`, the entropy source is derived from the chain
itself — the hash of the microblock at height `(N-2)·90`:

```
entropy_source = SHA3-256( "QNet_Chain_Entropy_v1" || seed_height_le || microblock_hash )
```

The seed block sits 91-180 blocks below every height of epoch `N`, so a producer holding its contiguous chain always has
it: production creates its own seed input and the seed can never lag production. Because the block is
`previous_hash`-committed, every node on one branch derives the identical value, and nothing node-local — seal prefix,
roster arm — enters the derivation. At the healthy finality gap the seed block is already below the certified frontier;
a fork deeper than the seed distance is bounded by the rollback floor and resolved by certified-round fork choice, so
branch-local seeds there behave like any chain-accumulated randomness. Deriving the seed from the *finalized* macroblock
instead coupled production liveness to finality liveness: a sealing stall of more than two windows halted the chain.
Round 0 and epochs 1-2 substitute a genesis-derived value, so no height up to 180 reads a chain seed.

**2. Round seed.** The entropy source is folded with the round and the ordered candidate list:

```
vrf_entropy = SHA3-256( "QNet_VRF_Round_Entropy_v1" || leadership_round_le
                      || each sorted candidate node_id || entropy_source )
slot_seed   = SHA3-256( "QNet_VRF_SlotSeed_v4" || vrf_entropy || leadership_round_le )
```

**3. Index.** The first 8 bytes of the leader hash, read as a little-endian `u64`, reduced modulo the candidate count:

```
round0_idx = SHA3-256( "QNET_LEADER_V4.5" || slot_seed
                     || round_start_height_le || leadership_round_le || 0u64_le )[..8]
             as u64 (LE) % candidates.len()
```

`candidates` is sorted by `node_id`, so the index-to-identity mapping is identical everywhere.

Election is public and computable in advance: any observer holding the chain through height `(N-2)*90` and the roster
snapshot can derive the leader for every slot of the coming windows, roughly two macroblock windows ahead. Liveness under leader targeting comes from timeout-certificate
failover.

### Failover rotation and the absolute round

Failover does not re-hash; the elected index shifts modularly by the certified round, so `selected_idx = (round0_idx +
certified_round) % candidates.len()`. Because `(round0_idx + R) % N` is a permutation for every base, successive rounds walk
the whole roster with no exclusion sets and no collisions. The round used is the **absolute** round, not a node-local
relative one. A microblock carries two signed fields, `timeout_round` and `carried_baseline`, whose sum is the absolute
round. Both come from a single snapshot of the window's certified-round tracker, so `timeout_round + carried_baseline ==
HIGHEST_CERTIFIED_ROUND[window]` holds by construction and any pollution in a node's local baseline cancels in the
reconstructed value. Electing on the absolute round is what prevents two honest nodes with divergent baselines from each
electing themselves.

Ingest enforces the exact predicate the producer used: `failover_round_authorized(window, block_round, carried_baseline)` is
true only when the window's certified round is at least `block_round + carried_baseline`. The predicate is applied
unconditionally, including when `block_round == 0`, so a forged inflated baseline cannot pass on a happy-path block.
Producer-authority checks are two-sided. If a block's absolute round equals the cached expected round but the producer
differs, it is rejected. If the block claims a different round, the leader for *that* round is recomputed from the cached
round-0 roster with the same formula and a mismatch is rejected; only an underivable roster leaves the soft path.

## Candidate roster

### The N-2 snapshot

The candidate roster for the window covering epoch `N` is the `eligible_producers` snapshot stored inside macroblock `N-2`,
deserialized and sorted by `node_id`. `N-2` rather than `N-1` because macroblock `N-1`'s consensus has not finished when
block `N*90+1` already needs a roster. The rule is strictly `N-2` with no walk-back. A node that does not hold macroblock
`N-2` abstains rather than substituting the nearest macroblock it happens to have. This is load-bearing: a walk-back makes
the roster a function of local holdings instead of the height, so a different stop index means a different roster and a fork.
The same rule governs the Checkpoint-BFT committee (`committee_for_height`), and committee and beacon are always read from
the *same* macroblock — the beacon is that macroblock's own `randomness_beacon`. Above height 180, an empty roster means the
node is desynchronized: producer selection returns an empty string, the node excludes itself from production and enters a
recoverable error state pending background sync.

### Genesis window and warmup

Heights up to and including 180 use the static genesis candidate list — the five pinned genesis consensus identities whose
ML-DSA-65 public keys are embedded in the binary. Epochs 1 and 2 have no on-chain `N-2` anchor and fall back to the same
set, so the genesis-era committee is 5 and its quorum is 4. A separate gate applies to newcomers: `ACTIVATION_WARMUP_BLOCKS
= 180` (two epochs). A registered Super node becomes producer-eligible only once its registration height is buried that
deep, so a fresh joiner syncs as an observer before it can be elected. Genesis nodes (registration height 0) are exempt.

### Cap and uniform sortition

When the eligible set exceeds `MAX_VALIDATORS = 1000` it is truncated by uniform SHA3 sortition, scoring each candidate as
`SHA3-256("EPOCH_VALIDATOR_VRF_v3.37" || beacon || macroblock_index_le || node_id)`. The 1000 lowest scores are taken by
quickselect with `node_id` as total-order tiebreak, then sorted. Uniform sortition re-rolls the truncated set each epoch
from the on-chain beacon, so no group of nodes can entrench itself in the roster by holding slots. If macroblock `N-2`'s
`randomness_beacon` is unavailable the snapshot builder abstains and returns an empty vector, since an untruncated list
would make the snapshot a function of local database contents and both variants land in the QC-signed `epoch_commitment`.
Reputation is binary — `INITIAL_REPUTATION` and `MIN_CONSENSUS_REPUTATION` are both 70.0 — and acts as an admission floor.
Candidate calculation reads committed state only, so local liveness observations never mutate the canonical candidate set.

### Frozen roster when finality stalls

Production is deliberately not gated on finality. `roster_mode(window)` classifies each window from one atomic read of `L`
(newest contiguously-sealed macroblock) and `B` (newest window known to be QC-certified): `Sealed` when `w-2 <= L` (use
macroblock `w-2` verbatim); `Defer` when `w-2 > L` and `L < B` (a certified anchor exists but is not held — abstain and
pull, never derive); `Frozen` when `w-2 > L` and `L == B` (finality genuinely stalled). Pre-first-seal (`L == 0`) is never
`Frozen`. In `Frozen` mode the anchor `M_A` is the newest sealed macroblock, descending the contiguous prefix from `L`, that
carries both a usable eligible set and a beacon. Roster, beacon and committee are then pure functions of that macroblock's
bytes plus the public window index; the election seed needs no frozen substitute, because it is chain-derived in every mode:

```
FrozenRoster       = M_A.eligible_producers, empty ids dropped, sorted by node_id (constant across the horizon)
FrozenBeacon(w)    = SHA3-256( "QNET_FROZEN_BEACON_V1"  || M_A.randomness_beacon || w_le )
FrozenCommittee(w) = sample_committee(FrozenRoster, w, FrozenBeacon(w), 1000, 1000)
```

Because none of these fold post-seal bytes, a contested tail above the seal cannot poison them.

## Microblock contents

A `MicroBlock` carries: `height`, `timestamp`, `transactions`, `producer`, `signature`, `previous_hash`, `merkle_root`,
`vrf_output`, `vrf_proof`, `fees_collected`, `state_root`, `timeout_round`, `carried_baseline`, and an optional
`timeout_proof`. `MicroBlock::validate` rejects a block carrying more than 50,000 transactions and recomputes and compares
`merkle_root`; the verify stage treats an empty signature on any non-genesis microblock as a hard reject.

### How the producer fills a block

Body composition is producer-side: it decides what a block contains, while validity is judged by the rules above. The
order is fixed, and each stage has its own budget so no one class of work can consume the whole slot.

| Order | Content | Budget |
|---|---|---|
| 1 | The emission transaction, on emission blocks | one |
| 2 | `EquivocationProof` transactions this node has detected | 16 per block |
| 3 | `VoteEquivocationProof` transactions this node has detected | 16 per block |
| 4 | The `NodeRegistration` lane | `MAX_ACTIVATIONS_PER_MICROBLOCK = 10` |
| 5 | General mempool transactions, `NodeActivation` sharing the lane budget | the same 10 for activations |
| 6 | Cumulative serialized size | `MAX_BLOCK_SIZE_BYTES = 80,000,000` |
| 7 | Cumulative gas | `gas_limits::BLOCK_GAS_LIMIT` |

The two proof classes are unsigned system transactions the producer injects into its own block rather than gossiping,
on the same model as the emission transaction. `NodeRegistration` is served exclusively by the mempool's deterministic
lane — ordered by attestation epoch, burn transaction and transaction hash, with exempt registrations capped at the
genesis-set size — and is stripped unconditionally from the general mempool stream, so every producer selects the same
next set and cross-producer ordering can never starve a registration. `NodeActivation` fills the remainder of the same
heavy budget from the general stream; anything over the cap rides the next block. The size cut is a prefix cut: the
first transaction that would cross 80 MB ends the block, keeping it inside what the shred layer can carry.

### What the block hash binds

```
MicroBlock::hash() = SHA3-256( height_le || timestamp_le || previous_hash || merkle_root
                             || producer || timeout_round_le || carried_baseline_le || state_root )
```

`EfficientMicroBlock::hash` mirrors this field-for-field so the storage anti-fork guard observes one block identity across
both read paths. `timeout_round` and `carried_baseline` are bound because together they select the elected producer.

The exclusions are deliberate, and each closes a specific attack:

| Excluded field | Reason |
|---|---|
| `signature` | ML-DSA signatures are randomized, so a producer could re-sign the same block to shift a signature-keyed fork-choice tie-break at will. The block hash cannot be ground this way, and two byte-identical blocks share one hash. |
| `fees_collected` | Outside the producer signing digest. Binding it would let an in-transit mutation change the identity of a validly signed block and frame an honest producer. |
| `vrf_output` | The window beacon folds block hashes; binding this field would give a producer a free grinding handle on block identity. |
| `timeout_proof` | Self-authenticating (a set of signed votes) and stripped on the storage serve path. |

The producer signing digest is a separate, wider preimage:

```
SHA3-256( "Block_Sig_v23.1" || height_be || timestamp_be || merkle_root || previous_hash
        || state_root || producer || vrf_output (if Some)
        || timeout_round_be || carried_baseline_be || microblock_pk_digest(transactions) )
```

signed as a detached ML-DSA-65 signature and carried on the wire as the UTF-8 string `dilithium3_v4:<hex>`. Because the
digest already covers `state_root`, binding `state_root` into the block hash is safe: a mutation breaks the signature before
it can change block identity. Block production, block signing, timeout voting and leader election all sign with ML-DSA-65
(FIPS 204, CRYSTALS-Dilithium3). See [cryptography](cryptography.md).

### Producer self-checks

A producer will not produce block `H` unless it holds `H-1`; it pre-checks storage at cycle entry and yields if the target
height is already filled; and it re-checks authority immediately before any state mutation, yielding if the certified round
advanced past the round it started with. It also refuses to build at or below its own finality marker.

A durable anti-double-sign mark, ordered view-first as `(absolute round, height)`, is written with `fsync` before the
signature is produced, so a crash between the two costs one slot rather than a second signature. A block is signable when
that pair is strictly new: within one view heights must climb, and a strictly higher view may re-sign any height. The
higher view is what lets a producer that rolled back re-extend the branch it adopted — a different view at one height is
failover, not a double sign, and it already needs an n-f timeout certificate to be accepted. Keying the mark on height
alone would bar such a producer from every height it had signed on the branch it abandoned. Tolerated sync lag
before abstaining is 2 blocks in round 0, 3 in round 1, 5 in round 2 and above. Every one of these reads local state only:
the right to produce never depends on observing other nodes, because an input shared by every member of a connected mesh
cannot distinguish isolation from a silent observation channel. The rotation-vote path is independent of these, so a node
blocked from producing still drives failover.

## Finality

Finality is Checkpoint-BFT. One consensus object, the `Checkpoint`, commits a window of leader-streamed microblocks via a
quorum certificate of committee ML-DSA-65 signatures.

### Checkpoints, indices and windows

A checkpoint's `index` is the BFT view/round and may skip when a view times out. Its `window_head_height` is the contiguous
chain position, always a multiple of `CHECKPOINT_INTERVAL`. A macroblock is sealed only at a boundary checkpoint —
`window_head_height % MACROBLOCK_INTERVAL == 0` — and only once the 2-chain commit releases that seal; intra-window
checkpoints advance finality without sealing. The macroblock's height is the *window* (`head / 90`), decoupled from the
consensus round, so a skipped round leaves no macroblock gap. The checkpoint hash
preimage (domain `qnet-checkpoint-v2`) covers `index`, the parent link (`checkpoint_hash` and `index` of the parent QC),
`window_head_height`, every `window_mb_hash`, `state_root`, `beacon`, `epoch_commitment`, `reward_root`, `registry_root`,
`logs_root`, `dilithium_pk_root`, `reward_epoch_root`, `total_supply`, `timestamp` and `proposer`. `proposer_sig` is
excluded, and QC signer sets are never hashed. A checkpoint carries only a `QcRef` — the parent checkpoint hash and index —
not the full parent certificate.

### Quorum

```
quorum_size(n) = n - floor((n-1)/3)
```

This is n−f, which coincides with 2f+1 only when `n = 3f+1`. `quorum_size(5) = 4`, `quorum_size(100) = 67`,
`quorum_size(1000) = 667`.

### Committee selection

`sample_committee` is the single committee-selection function, shared by the macroblock checkpoint sealer and the microblock
failover voting set, so the two layers can never disagree on membership. It scores each candidate index as
`SHA3-256("COMMITTEE_VRF_v3.36" || seed || window_le || index_le)`, sorts by score, truncates to `COMMITTEE_SIZE`, then
restores the original index order. Callers must pass a roster already sorted by `node_id`. Because `COMMITTEE_THRESHOLD ==
COMMITTEE_SIZE == 1000`, the function is the identity for any network with at most 1000 eligible nodes — at that size the
committee simply *is* the whole eligible set, and subsampling begins only above the cap. The checkpoint leader for an index
is seeded only by the index and the committed parent hash: `leader_index = SHA3-256("qnet-leader-v2" || index_le ||
parent_checkpoint_hash)[..8] as u64 % committee_len`.

### Quorum certificates

A `QuorumCertificate` holds `checkpoint_hash`, `index`, `signers` (node ids), `sig_merkle_root`, and `sigs` — a parallel
list of individual signatures, each carried and verified on its own. `QuorumCertificate::verify` checks `signers.len() >=
quorum`; `signers.len() == sigs.len()`; no duplicate signer; every signer a committee member; `sig_merkle_root` recomputes;
and every signature verifies. The quorum threshold is supplied by the caller and never derived inside `verify`, so a
certificate cannot choose its own threshold.

QC signatures are public-key-stripped. Each signer's key is resolved from committed on-chain state — the registered VRF
public-key row, else the binary-pinned genesis anchor — never from the in-memory peer registry, which is idle-evicted and
would be a fork source inside a consensus verifier. The live-gossip and apply-time verifiers apply this rule identically.
Committee members sign `"QNET_BFT2_VOTE:" + hex(checkpoint_hash)` for votes, `"QNET_BFT2_TMO:" + hex(timeout_bytes)` for
timeouts, and `"QNET_BFT2_CKPT:" + hex(cp.hash())` for proposals, where `timeout_bytes = "qnet-timeout-v2" || index_le ||
high_qc_index_le`.

A completed certificate — quorum or timeout — is relayed to a bounded random subset of peers, `RELAY_FANOUT = 8` in
`development/qnet-integration/src/consensus_v2_node.rs`, rather than to every peer. Relay is redundancy, not the
delivery path: every committee member assembles the identical certificate from the votes it has already collected, so
the fanout only covers members whose own tally lagged. At the genesis size the fanout exceeds the peer count, so every
peer receives it anyway; at a 1000-member committee a certificate is megabytes and relaying it to all peers would make
the step quadratic in committee size.

### Safety rule and commit rule

A replica votes for a proposal only if `cp.index > last_voted_index` **and** `proposal.parent_qc.index >= locked_index`,
where `locked_index` is the highest certified index it has seen. The commit rule is 2-chain: given child checkpoint `C_i`
and its QC at index `i`, if `C_i.parent_qc.index == i-1` then index `i-1` becomes final.

Ahead of that, the node layer refuses any proposal whose `parent_qc` is not byte-equal to its own `high_qc` reference.
The parent link is a claim, not a source of truth: leader election is `SHA3(index || parent_hash)`, so a committee
member free to name the parent could grind 32 bytes until the function elects it, copy the honest window content and
emit a second valid proposal at the same index — a vote split that is not equivocation and convicts nobody. The rule
costs no honest refusal, because a `QcRef` carries no signatures and two independently formed certificates for one
checkpoint are byte-identical.

### The finality ratchet

All finality flows through one entry point, `try_advance_finality`. It takes a finality mutex, refuses to advance while a
rollback is in progress, and is strictly monotonic — a call at or below the current round is a no-op success, so
`LAST_FINALIZED_HEIGHT` never moves backward through this path. A valid QC alone is not sufficient — three independent local
checks must pass first:

1. The local chain height has reached the checkpoint's `window_head_height`.
2. The local head microblock's `state_root` equals the QC-certified `state_root`.
3. Every local body in the window matches the QC-certified per-height hash list (`window_content_verdict` returns
   missing and mismatched heights; either being non-empty blocks the advance). Sub-anchor history is exempt: when the
   node's adopted snapshot anchor (`SNAPSHOT_ANCHOR_MB * 90`) already covers `window_head_height`, `anchor_ok`
   short-circuits this check, because those bodies were never downloaded and their correctness rests on the snapshot's
   own QC binding instead.

The third check is the safety property that stops a same-state-different-body failover fork tail from being pinned as final;
on divergence the node solicits block repair instead of advancing. Once finality advances, branches at or below it can never
be adopted, and the retained fork tree is pruned below that height at macroblock boundaries.

Adopting a verified snapshot is the second way the marker moves. `adopt_snapshot_finality` runs under the same finality
mutex and lifts `LAST_FINALIZED_CONSENSUS_ROUND`, `LAST_FINALIZED_HEIGHT`, `WEAK_SUBJECTIVITY_CHECKPOINT`,
`SNAPSHOT_ANCHOR_MB`, the local blockchain height and the QC-verified frontier to the anchor, each with `fetch_max` so
the ratchet property holds. The three per-window checks are not repeated for that history: the joiner has already walked
the macroblock QC chain up to the anchor from the pinned trust root, and the anchor's checkpoint certificate is finality
by definition. The joiner therefore tails from `anchor + 1` instead of replaying sub-anchor microblocks it never
downloaded.

### The genesis-anchored live checkpoint

Beside the checkpoint chain the network maintains a small self-authenticating weak-subjectivity pin that a node can trust
before it holds any chain data: the genesis-anchored live checkpoint. It bounds the cold-join lineage walk to a few
macroblocks at any chain age, and it refreshes on a cadence rather than on a release.

A capsule carries `version`, `network_id`, a macroblock index `K`, `MacroBlock::hash()` at `K`, two committee-fields
digests, the height it was minted at, and its signature list. The signed value is the domain-tagged string
`QNET_GENESIS_CHECKPOINT_v1:{version}:{network_id}:{K}:{mb_hash}:{digest_anchor}:{digest_pred}:{minted_at_height}`.

- **Minting.** Every 15 seconds each of the five pinned genesis identities checks whether a capsule is due. `K` is
  deterministic — the newest finalized macroblock index rounded down to a multiple of `GALC_MINT_INTERVAL = 40`
  macroblocks — so all five sign the identical tuple with no coordination. The interval is derived from the state-snapshot
  cadence, and a compile-time assertion pins `GALC_MINT_INTERVAL × 90` to `SNAPSHOT_INCREMENTAL_INTERVAL`, so every
  capsule co-locates with a snapshot anchor and a joiner's anchor *is* the capsule root.
- **Gossip and aggregation.** A minter broadcasts its partial as `GenesisCheckpointSig`. Every node buckets partials by
  `SHA3-256(preimage)`, so a genesis identity signing a different tuple forms its own bucket instead of polluting the
  honest one. At `quorum_size(genesis_node_count())` distinct signatures — 4 of 5 — the bucket assembles into a capsule.
  Complete capsules travel as `GenesisCheckpoint`, any Super node relays and serves one, and a cold joiner pulls with
  `RequestGenesisCheckpoint`.
- **Verification.** Signatures are accepted only from the binary-embedded genesis anchor keys, never from peer-supplied
  keys, and the capsule must declare `mb_index >= 2` and the local `network_id`. `network_id` is the hash of the local
  genesis block, which binds a capsule to this chain and rejects one replayed from another. The cheap checks run first
  and post-quantum verification runs behind an eight-permit semaphore, so a capsule flood cannot pile up signature work.
- **Adoption.** A verified capsule is adopted monotonically by index under a lock and published through a seqlock, so a
  reader never pairs the index of one capsule with the hash of another. It is persisted, and a restarting node
  re-verifies it against the embedded keys before re-adopting.

The two digests are what make the pin sufficient on its own. `committee_fields_digest` is SHA3-256 over one macroblock's
`eligible_producers`, `randomness_beacon`, `consensus_committee` and `banned_validators`, each behind a present/absent
flag so `None` and an empty vector never collide — exactly the `consensus_data` fields `MacroBlock::hash()` omits. A
capsule carries the digest of `K` (anchor) and of `K-1` (predecessor), because both macroblocks feed the forward N−2
committee derivation.

`effective_pin_checkpoint()` returns the max-by-index of the binary weak-subjectivity pin and the adopted capsule as the
tuple `(index, mb_hash, digest_anchor, digest_pred)`. That tuple is the inductive trust root for macroblock acceptance
below. It is kept separate from `effective_ws_checkpoint()`, the finality floor: a capsule shortens the walk and never
advances finality, which stays gated on the full snapshot binding.

### Sealing a macroblock

The seal is built on the boundary window's quorum certificate and held, not written: the 2-chain commit releases it, and
a window whose certificate never acquires a child certificate never commits and therefore never seals. That is the safety
property — two byte-different bodies at one window head can each reach a single-certificate quorum across rounds, but only
the branch that continues can commit. The held set is bounded, and the commit frontier releases every held index at or
below the index it reaches, so a skipped round that commits `r+2` off a parent at `r` does not strand window `r`.

Sealing is all-seal: every committee member writes the macroblock locally, because the body is a pure function of the
committed window and therefore byte-identical everywhere. Only the proposer broadcasts it, to avoid N-fold traffic. A
sealer that cannot derive the body byte-identically declines the window rather than writing bytes that would differ from
every other sealer's — `seal_deferred window=… reason=parent_absent` when it does not hold the parent macroblock the
`previous_hash` is taken from, and `reason=ban_set_underivable` when the window's cumulative equivocation ban set cannot
be computed. The window is left to the quorum that can derive it and the deferring node adopts the sealed object through
sync; two nodes storing different bytes under one macroblock key would poison the roster and beacon source for every
later epoch. Nothing node-local enters a sealed body for the same reason: the candidate roster is derived from
`eligible_producers` alone, and a liveness exclusion would be admissible only if it were itself derived from certified,
replayable data that every sealer reproduces byte for byte.

`verify_v2_macroblock` is the single authority for macroblock acceptance, and it resolves in this order.

**Structural gates.** A received macroblock is zstd-decompressed under `MAX_MACROBLOCK_DECOMPRESSED = 16 MiB` before
deserialization, and its declared height must equal the index it arrived under. A macroblock whose
`consensus_data.is_skip_marker` is set is rejected ahead of the certificate gate, so the flag cannot route a block
around it.

**The pinned pair.** Let `pin = effective_pin_checkpoint()`. At `index == pin.0` the macroblock is trusted by hash:
`MacroBlock::hash()` must equal `pin.1` and its `committee_fields_digest` must equal the pinned anchor digest, and on
that basis it is accepted. At `index == pin.0 - 1` it is trusted through the chain: the macroblock at `pin.0` must
already be stored and its `previous_hash` must equal this block's hash, and this block's own digest must equal the pinned
predecessor digest. A not-yet-held anchor defers the block (`v2_qc_defer_anchor`) rather than rejecting it. Each branch
checks only its own macroblock's digest, so neither waits on the other's `consensus_data`. These two branches root the
cold-join lineage walk in an exogenous genesis-signed value instead of in data the snapshot server supplied, and because
the digest covers precisely the fields the block hash omits, a hash-equal macroblock carrying a forged roster is refused
at store time through every ingress path.

**Below the floor.** A macroblock at an index below `effective_ws_checkpoint()` — the max of the binary pin and the
locally adopted snapshot anchor — is refused as `v2_below_ws`. That span is history the node's adopted anchor already
covers.

**Every other index** goes through the quorum certificate. Acceptance rejects a macroblock whose
`consensus_data.checkpoint_qc` is absent; requires `cp.window_head_height == index * 90` exactly (not `head / 90 == index`),
`cp.hash() == qc.checkpoint_hash`, and exactly 90 microblock hashes; and binds every consensus-critical body field to the QC
— `window_mb_hashes` against `micro_blocks`, `state_root`, `randomness_beacon` against `cp.beacon`, and `timestamp`. The
published `eligible_producers`, `consensus_committee` and `banned_validators` are re-hashed through `epoch_commitment` and
compared against the QC-signed value, so a relayer cannot corrupt the stored validator or ban set. `previous_hash` is inside
`MacroBlock::hash()` but is not a checkpoint field, so the QC does not cover it; a *present* mismatching parent is rejected
while an *absent* one is allowed (pruned history, cold join, out-of-order backfill). A locally recomputed `reward_root` that
disagrees with the certified one produces a warning only and never rejects the macroblock — a deliberate trade that trusts
the quorum rather than stalling catch-up nodes. `MacroBlock::hash` covers only `height`, `timestamp`, `previous_hash`,
`state_root` and the `micro_blocks` list; `consensus_data` is excluded, which makes the macroblock hash byte-stable across
nodes.

### Beacon

The window randomness beacon is an order-independent XOR-fold of the window's QC-signed block hashes, domain-hashed with
`qnet-beacon-v2`. Every input is a certified block hash, so the value is reproducible from the certified window alone and
any node can recompute and check it after the fact.

## Producer failover

When the elected producer is silent, the committee rotates it out by certificate. This layer is separate from Checkpoint-BFT
view changes, and the two objects named `TimeoutCertificate` are different types.

### Timeout votes

A vote is a detached ML-DSA-65 signature over a canonical string built by one shared function used by both signer and
verifier:

```
QNET_TIMEOUT_V2:{window}:{round}:{hex(anchor)}:{high_qc_idx}:{hex(high_qc_hash)}:{tip_height}:{hex(tip_hash)}
```

`window` is the vote window (`target_height / 90`), `anchor` is the hash of macroblock `window-2` (zeros for windows below
3), and the `high_qc` and `tip` fields are the voter's own sync hints — covered by the signature for accountability but
never quorum-read as a max-of-claims. Emission requires all of: local slot delay above `STALL_GRACE_SECS = 5` **or** the
slot's own expected producer has already voted (leader self-yield); at least `TIMEOUT_ESCALATION_MIN_PEERS = 2` validated
peers; at least `TIMEOUT_ESCALATION_BOOT_FLOOR_SECS = 15` of uptime; and no seal throttle. Emission is suppressed while a
remote producer's heartbeat is fresh (`HEARTBEAT_SILENT_MS = 3000`) and its advertised slot height covers the failover
height, but for at most `HEARTBEAT_SUPPRESS_CEILING_SECS = 15`; past `D2_PROGRESS_HARD_CEILING_SECS = 180` of no view
progress the vote fires unconditionally. The emitted round is `max(certified + 1, R)`, where `R` is the highest round
already supported by `f+1` distinct committee voters — f+1 amplification jumps the target to a round at least one honest
validator has reached, rather than stepping one round at a time — clamped to `MAX_FAILOVER_ROUND = 50`. Amplifying the vote
*target* cannot cause dual production, because leader election still reads only the n−f-certified round. At the cap the
pacemaker holds — it keeps emitting the clamped round and requests chronic-stall recovery sync in parallel — rather than
going terminal.

`handle_timeout_vote` gates a vote cheapest-first: field-length check, window at or above the observed floor, round at most
`certified + MAX_FAILOVER_ROUND`, window-committee membership, sealed-anchor match, and the signature verify last. Received
votes are re-gossiped to a rotated subset of the node's connected peers — self and the original voter excluded, with no
committee filter on the recipients — with fanout 5 when the window committee exceeds 100 members and 3 otherwise. The
subset is rotated by `(window XOR round) % peers`, so different votes pick different peers and coverage accumulates over
the wave. A re-vote with an advanced tip or high-QC is a legitimate rate-bounded update.

A vote whose anchor differs from the receiver's sealed `w-2` is never tallied — two views must not combine into one
quorum — but it is not evidence either, because an honest node legitimately replaces a locally sealed macroblock with the
network's during reconciliation. Dropping it and doing nothing more would leave a node on a minority view deaf: it would
discard exactly the messages carrying the news that the view moved. Distinct *signed* foreign anchors are therefore
counted per `(window, anchor)`, and n-f of them is proof that the receiver's own anchor is the minority one, at which
point it pulls the window anchor. Signature verification runs only for an anchor-voter pair not already counted, and
distinct anchors per window are capped, so neither a replay nor a flood of fresh anchors buys work.

### Certificates and round advance

A `TimeoutProof` (aliased `TimeoutCertificate` in the integration layer) holds `height` — which is the vote **window**, not
a block height — plus `timeout_round`, `anchor`, and the vector of signed votes. The votes themselves are the proof. The
certificate forms when the collected vote count reaches the n−f quorum over the window committee, using the same quorum
function as Checkpoint-BFT; on certification the proof is stored at `(window, round)` and `HIGHEST_CERTIFIED_ROUND[window]`
is raised monotonically.

That tracker is the *only* input that rotates the microblock leader. It advances on an n−f quorum within a single window
and on nothing else — not on f+1, not across rounds, not on a clock. Producer and ingest gate read the same value, so they
cannot disagree about whether a round is authorised, which is what prevents dual production.

A microblock whose absolute round exceeds 0 is rejected at ingest unless that round is certified. The block stays replayable
and the node rate-limited-pulls the window's certificates (`FAILOVER_CERT_PULL_COOLDOWN_SECS = 2` per window). A round>0
microblock may also carry its own n−f `TimeoutProof` in its `timeout_proof` field; ingest adopts it in-band before checking
authorization, so a node that missed the one-shot certificate broadcast still converges.

### The failover floor

The vote and certificate view floor is derived from finality, never stored: `observed_tc_window_floor() =
LAST_FINALIZED_HEIGHT / MACROBLOCK_INTERVAL`. No honest node forms, accepts or tallies a vote or certificate for a window
below it — a finalized window is sealed, which closes the banked-vote double-certificate vector. Because finality is a
ratchet always at or below the node's applied tip, the floor can never sit *above* the window a node is failing over at.
For the same reason certificate state is retained across rollback: a certified round is a fact a rollback cannot unmake.

### The Checkpoint-BFT view change

The macroblock layer has its own view-change object: a `TimeoutCertificate` holding `index`, a vector of `TimeoutMsg`, and
an optional `high_qc`. `TimeoutCertificate::verify` requires at least a strict quorum of distinct committee timeouts, all
for the certificate's own view, each signature valid, plus a valid carried high-QC if present. A certificate forms exactly
once on the quorum-crossing insert and sets `current_index = index + 1`; separately, f+1 timeouts observed at a higher index
trigger a Bracha-style jump to that index. The view timer is built from `VIEW_TIMEOUT_MS` with an adaptive backoff driven by
consecutive timeouts without a commit.

### Proposal and evidence hygiene

The caches that back equivocation detection are bounded, because the admission gate accepts a proposal from any committee
member rather than only from the index's leader.

| Bound | Value | What it bounds |
|---|---|---|
| `MAX_PROPOSALS_PER_INDEX` | 4 | Distinct checkpoint preimages cached for one index; a round has one honest proposal and an equivocating leader has two |
| `VOTE_DETECT_WINDOW` | 256 indices | Retention of the first-seen vote and proposal caches, swept every 64 indices |
| `EVIDENCE_RETENTION_BLOCKS` | 14,400 blocks | How long an unsubmitted equivocation proof stays eligible to find a producer |
| `MAX_PENDING_EVIDENCE` | 4,096 | Pending block-equivocation entries, newest heights kept |
| `CLEANUP_HEIGHT_WINDOW` | 500 blocks | Retention of the per-height producer-vote and certificate-request maps |

Equivocation is detected within one round, so the tight detection window bounds memory at any committee size, while the
evidence horizon is deliberately a full epoch: sizing it for vote churn would give a sound proof only minutes to reach a
producer.

## Block attestation

Between checkpoints a leader streams blocks that carry no quorum signatures, so without a second signal a branch nobody
follows looks exactly like a branch everybody follows until the window closes. Block attestation supplies that signal at
per-block granularity.

The committee is partitioned across the checkpoint window rather than polled in full every block. For a height, the
attester slice is `k = ceil(committee / CHECKPOINT_INTERVAL)` members taken from the sorted roster at offset
`slot * k`, where `slot = (height-1) % CHECKPOINT_INTERVAL`, with the block's own producer excluded because
self-attestation is not external evidence. Each member therefore attests about once per window, and the signatures spent
per window are close to those in a single checkpoint quorum certificate — the same bandwidth, delivered a window
earlier. The slice is a pure function of committee and height, so membership is checkable on receipt.

An attester signs `chain_tag || "QNET_ATTEST:" || height || block_hash` with its ML-DSA-65 key on accepting the block and
gossips it to the validator set. A receiver admits the message only from a member of that height's slice, refuses a pair
it has already counted and a fresh block hash once the per-height cap is reached — both before the signature verify, so
neither a replay nor a hash flood buys work — and then verifies the signature against the consensus key registry.

Two properties are deliberate. Attestation **never gates production**: an input shared by every node cannot distinguish
isolation from a dead attestation channel, so yielding on a shortfall would stop every producer at once on a single
symmetric fault. Attestation **never enters fork choice**: gossip is partial, so counts differ between nodes, and a
node-dependent count cannot select a branch. Its one action is a pull — when a node's own block at a height carries no
attestations while a competing hash carries `f+1`, it requests the window anchor, and the deterministic rules below
decide the branch once the data arrives.

## Fork choice

At a stored height above finality, `maybe_supersede_by_certified_round` decides between the block a node holds and an
incoming competitor, in this exact precedence:

1. **QC-certified content, in our favour.** If the height's window macroblock is stored and *our* body equals the
   QC-certified hash at that height while the competitor's does not, keep ours unconditionally.
2. **QC-certified content, in the competitor's favour.** If the *competitor* matches the certified hash and we do not,
   adopt it unconditionally.
3. **Strictly higher certified absolute round wins.** The competitor's attached `TimeoutProof` is adopted first so the
   round can be learned in-band; if the higher round is still not certified locally, the node pulls that window's
   certificates (rate-limited) and keeps its own block for now.
4. **Equal absolute round.** The competitor wins only if it is a genuine same-producer self-fork with a lower **block
   hash** and a valid producer signature.
5. **Strictly lower round.** Keep ours.

Content-QC authority dominates the round heuristic in *both* directions. A one-sided override would turn a wedge into an
A→B→A flap: if we hold the certified body and adopt a checkpoint-rejected higher-round sibling, an adversary re-gossiping
that sibling holds our finality at that height forever. The equal-round tie-break compares block hashes — `incoming.hash()`
against the stored hash — because ML-DSA signatures are randomized and a signature-keyed tie could be re-ground at will. The
same-producer requirement closes a reorg denial-of-service in which any registered node could grind a lower value and force
a wasteful rollback.

`maybe_supersede_by_certified_round` returns immediately if the height is at or below `LAST_FINALIZED_HEIGHT`, so fork
choice never touches finalized history. When the competitor wins, the node signals fork recovery at `max(height-1,
finalized)`, the deepest pending target winning via a compare-and-swap loop. The pre-verify anchor-recovery detector rolls
back to `disputed_height - 2` clamped at or above finality, using the same rule. Repeated apply-stage divergence escalates
to fail-closed fork recovery after `APPLY_MISMATCH_BREAKER = 3` consecutive `state_root` mismatches, counted across heights
so a mismatch hopping to the next height cannot reset the counter.

At the storage layer, an incoming block whose hash differs from the stored hash at the same height is rejected, but its
bytes are retained non-destructively as a branch keyed by hash. Equivocation evidence is recorded only when both blocks
share the same producer; two different producers at one height is a failover race, rejected without penalty. The
equivocation identity hash mirrors `MicroBlock::hash`'s field set and folds `vrf_output` through a fixed-width tagged fold,
so an honest producer re-emitting a block after a rollback is not recorded as an equivocator. Liveness is handled by the
heartbeat eligibility gate together with penalty-free slot-timeout failover.

### Ingest defences around fork choice

The pipeline carries its own bounded machinery so a contested or gappy tail is repaired rather than absorbed.

| Mechanism | Bound |
|---|---|
| Fork-source peer cooldown — a peer that supplied a forked-branch block is deprioritised by the sync peer selector, falling back to the full set if every candidate is in cooldown | `FORKED_PEER_COOLDOWN_MS` = 5 minutes |
| Missing-parent request, deduplicated per height | `MISSING_BLOCK_REQUEST_TTL_MS` = 30 s |
| Range repair, preferred over a cascade of single-height requests once the gap is large enough | `RANGE_SYNC_GAP_THRESHOLD` = 5 blocks, `RANGE_SYNC_WINDOW` = 500 (one serve-side batch), `RANGE_SYNC_RETRY_MS` = 10 s |
| Deferred-block buffer, keyed by parent hash so siblings racing for one slot coexist instead of overwriting each other. At either cap the entry furthest from the tip is evicted and the arrival admitted, since the arrival is the one closer to what the node needs next | `DEFERRED_MAX` = 2000, `DEFERRED_MAX_PER_PRODUCER` = 2 × `ROTATION_INTERVAL_BLOCKS`, `DEFERRED_MAX_AGE_SECS` = 120 |
| Gossip acceptance horizon above the local chain height | `GOSSIP_HORIZON` = 200 blocks |

Hash-chain breaks are witnessed per `(height, peer)` rather than acted on from a single report, and the pipeline tracks
occupancy per stage with a 30-second stuck-stage detector over its operation codes, so a stalled stage is visible as
itself instead of as generic sync lag.

## Reorg bounds

Reorganisation is bounded on two independent sides. **Hard floor:** `begin_finality_guarded_rollback` refuses any rollback
whose target is below `LAST_FINALIZED_HEIGHT`, returning a `FINALITY_VIOLATION` error. The check runs under the same
finality mutex that serializes `try_advance_finality`, and the rollback slot is claimed before the re-check, so there is no
window in which finality can advance past a rollback in flight. **Soft ceiling:** production parks once the next block
height exceeds the seal base — `max(last_sealed_macroblock_index * 90, QC-verified frontier)` — by
`MAX_DERIVED_ROSTER_WINDOWS * MACROBLOCK_INTERVAL = 32 * 90 = 2880` blocks. This is the sole production ceiling, and
`production_throttle_reason` derives it from the seal base alone. An unbounded unfinalized tail is an unbounded reorg, so
the frozen-roster horizon caps it; the value is a pure function of committed scalars, so every honest node parks at the same
height. `MAX_UNSEALED_WINDOWS = 2` drives sync and desync detection — a sync nudge at the QC-verified frontier and the
macroblock-behind test in the sync coordinator. The apply-side seal backpressure also uses `MAX_DERIVED_ROSTER_WINDOWS *
90`, so following the chain is not finality-gated.

## Related documents

- [Architecture overview](overview.md) — how consensus sits alongside the rest of the node
- [Cryptography](cryptography.md) — ML-DSA-65 signing, hashes, addresses, transport
- [State](state.md) — accounts, state commitment, transaction types
- [Networking](networking.md) — gossip, message types, peer discovery
- [Node activation](../economics/node-activation.md) — how a node becomes producer-eligible in the first place
