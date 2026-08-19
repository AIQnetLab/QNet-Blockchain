# QNet protocol whitepaper

This document specifies the QNet protocol as implemented in this repository: its node model and fault assumptions, its
two-tier block production and deterministic leader election, its Checkpoint-BFT finality rule, the post-quantum
cryptography used on every authenticated path, the account and state-commitment model, the emission and reward
economics, and the security properties that follow from those choices. Every constant, domain-separation tag and rule
below is taken from the source tree. Subsystem-level detail lives in
[docs/architecture/overview.md](docs/architecture/overview.md) and the documents it links.

## Status and risk note

QNet is experimental software. There are no warranties of correctness, availability or economic outcome, and anyone
operating a node or holding value on the network bears the full risk of doing so.

---

## 1. Abstract

QNet is an account-based blockchain in which every signature on every authenticated path — block production, consensus
voting, view change, peer handshake, transactions, registration, reward claims — is CRYSTALS-Dilithium3 / ML-DSA-65
(FIPS 204). The chain runs two cadences over one linear microblock sequence: a single elected producer streams
microblocks on a fixed one-second slot and is rotated every 30 blocks, while a separate consensus object, the
Checkpoint, commits a window of those microblocks with a quorum certificate of committee signatures every 30 blocks;
every third checkpoint boundary also seals a macroblock carrying the epoch transition, the emission, and the roster
snapshot from which the next epoch's producers and committee are derived. Leader election is a public deterministic
hash over data committed two macroblocks earlier, and liveness against a targeted leader comes from certified timeout
rounds. State is a flat address-to-account map committed by a 256-level sparse Merkle tree, with the node roster
committed separately by a homomorphic multiset hash so a light client can verify who is allowed to sign. Emission is a
pure function of block height paid into a single on-chain pool; every credit to a wallet requires a signed,
proof-carrying claim transaction. Node admission is bought once by an external token burn, and the only on-chain
penalty is a permanent ban recorded in state on cryptographically proven equivocation.

---

## 2. Design goals and scope

### 2.1 Goals

1. **Post-quantum authentication everywhere.** One scheme, ML-DSA-65, on every path that decides validity.
2. **Determinism as a structural property.** Consensus-relevant values are pure functions of committed bytes:
   block timestamps are slot-anchored to genesis, leader election reads only data sealed two macroblocks back,
   and the contract VM rejects floating point at deploy time.
3. **Safety over liveness at every branch.** A node that cannot reproduce what it is asked to certify abstains.
   Missing roster, missing anchor macroblock, missing epoch data and unresolvable proofs all produce abstention
   or a block-level abort, never a fallback value.
4. **Verifiability by a device that holds no chain.** Checkpoints commit the state root, reward root, registry
   root, account-key root and event-log root, so a light client can verify balances, rewards, token balances
   and event inclusion against a certificate it checks itself.
5. **Membership priced once, participation unpriced.** Node admission costs an external burn; rewards are then
   flat per eligible node within each pool and depend on proven presence.

### 2.2 Scope

The protocol targets a single execution shard: every apply path mutates one global account map. Execution is a
deterministic WASM interpreter with a small host ABI. Consensus parameters are compile-time constants, so changing one
is a network-wide rebuild rather than an on-chain action.

---

## 3. System model

### 3.1 Participants

Two node types exist, `NodeType::Light` and `NodeType::Super`.

| Property | Super node | Light node |
| --- | --- | --- |
| Consensus participation | Yes (production, voting, attestation) | No — excluded by type before any other check |
| Chain persistence | Full history, subject to retention rules | None |
| Archival duty | Yes | Never |
| Consensus key in registry row | Mandatory, 1952-byte ML-DSA-65 `vrf_pk` | Absent |
| Registration | Server-initiated by the node itself | Client-initiated from the mobile wallet |
| Devices per identity | One | Up to 3 |

Five genesis identities (`genesis_node_001` … `genesis_node_005`) are pinned in the binary with their 1952-byte public
keys and addresses, and hold enumerable privileges: they are the bootstrap peer set, the fallback committee for the
first macroblock windows, the publishers of light-node eligibility bitmaps, and they are exempt from handshake bans,
per-address connection caps, sync rate limits and inbound diversity caps.

### 3.2 Trust assumptions

- **Identity is a public key bound to a name on-chain.** A node's consensus identity is its registry row,
  committing node id, wallet, registration height, burn and the SHA3-256 digest of its consensus public key.
  Any verifier that decides validity resolves a signer's key from committed on-chain state or from the
  binary-pinned genesis anchor.
- **A wallet address is itself a key commitment**, derived from the ML-DSA-65 public key, so
  `address == derive(public_key)` is checkable without any registry.
- **Transport carries encryption; identity is asserted at the application layer**, by an ML-DSA-65 handshake
  proof and, where it matters, per message rather than per connection.

### 3.3 Fault model

The adversary is Byzantine: it may equivocate, withhold, reorder, replay, forge messages it holds keys for, and
control network delivery within the bounds below. It cannot forge ML-DSA-65 signatures or find SHA3 collisions.

- **Quorum.** For a committee of `n` members, `f = floor((n − 1) / 3)` and the threshold is
  `quorum_size(n) = n − f`. For `n = 5` the quorum is 4; for `n = 100`, 67; for `n = 1000`, 667.
- **Safety.** Any two quorums intersect in at least `f + 1` members, hence in at least one honest member, so
  two conflicting certificates at the same index cannot both form.
- **Liveness.** Progress requires at least `quorum_size(n)` committee members to be correct and mutually
  reachable. With more than `f` lost, finality halts at the last certified checkpoint and resumes once a quorum
  is reachable again; the threshold is a fixed function of committee size.
- **Threshold provenance.** A certificate never chooses its own threshold: verification takes the quorum as a
  caller-supplied parameter derived from the resolved committee.

### 3.4 Network assumptions

The protocol is safe under asynchrony and live under partial synchrony. Block timestamps are not network-derived:
`block_ts = genesis_ts + height × MICROBLOCK_INTERVAL_SECS`, validated by exact match on the live path, so clock skew
cannot influence validity. View changes are paced by a network-uniform constant, `VIEW_TIMEOUT_MS = 4000`. Transport
is QUIC on UDP port 10876 (the API port plus a fixed offset of 2875). Peer discovery bootstraps from the five pinned
genesis addresses and continues through peer exchange and a Kademlia routing table.

---

## 4. Block production

### 4.1 Two-tier structure

| Parameter | Constant | Value |
| --- | --- | --- |
| Microblock slot | `MICROBLOCK_INTERVAL_SECS` | 1 second |
| Producer rotation | `ROTATION_INTERVAL_BLOCKS` | 30 microblocks |
| Finality checkpoint cadence | `CHECKPOINT_INTERVAL` | 30 microblocks |
| Macroblock / epoch cadence | `MACROBLOCK_INTERVAL` | 90 microblocks |
| Round / committee cap | `MAX_VALIDATORS`, `COMMITTEE_SIZE` | 1000 |
| Maximum transactions per microblock | — | 50,000 |

A compile-time assertion enforces that `CHECKPOINT_INTERVAL` divides `MACROBLOCK_INTERVAL`, so every macroblock
boundary is also a checkpoint boundary, and one macroblock window spans exactly three producer rotations and three
checkpoints. A microblock carries `height`, `timestamp`, `transactions`, `producer`, `signature`, `previous_hash`,
`merkle_root`, `fees_collected`, `state_root`, `timeout_round`, `carried_baseline` and an optional `timeout_proof`.
`MicroBlock::hash` binds height, timestamp, previous hash, merkle root, producer, `timeout_round`, `carried_baseline`
and `state_root`, so block identity is a function of the producer's committed content alone.

The producer signs a SHA3-256 digest under the domain tag `Block_Sig_v23.1` covering, in order, height, timestamp,
merkle root, previous hash, state root, producer, timeout round, carried baseline and a digest of the transactions'
wire key/signature material, and publishes it as `dilithium3_v4:<hex>`. An empty signature on any non-genesis
microblock is a hard reject.

### 4.2 The roster snapshot and its N-2 derivation

Both the candidate roster and the election entropy for a macroblock window come from macroblock **N-2**, never N-1:
when the first block of window N is due, consensus on macroblock N-1 has not finished, so N-1 is not a usable common
reference. The rule is strict — a node that does not hold macroblock N-2 abstains rather than substituting a nearby
macroblock, because a different stop index means a different seed, a different roster and therefore a fork.

- The roster is the `eligible_producers` set committed inside macroblock N-2, sorted by node id. If it exceeds
  `MAX_VALIDATORS = 1000` it is truncated by **uniform** SHA3 sortition under the domain
  `EPOCH_VALIDATOR_VRF_v3.37`, seeded on that macroblock's randomness beacon. A node lacking the N-2 beacon
  emits an empty snapshot, so the snapshot is never a function of local database contents.
- Heights at or below 180 use the five static genesis identities. Above 180, an empty roster means the node is
  desynchronized: it returns an empty producer and excludes itself from production.
- A newly registered Super node becomes producer-eligible only `ACTIVATION_WARMUP_BLOCKS = 180` blocks (two
  epochs) after its registration height; genesis identities are exempt.
- Local observation may never alter the canonical candidate set: per-node exclusion and ejection inputs are
  neutralised in candidate computation because they are not certificate-bound.

### 4.3 Leader election

Leader election is a deterministic public hash over committed bytes.

```
mb_entropy   = SHA3-256("QNet_Deterministic_Entropy_v2.33" || consensus-invariant fields of macroblock N-2)
entropy      = SHA3-256("QNet_VRF_Round_Entropy_v1" || leadership_round_le
                        || sorted candidate node ids || mb_entropy)
slot_seed    = SHA3-256("QNet_VRF_SlotSeed_v4"  || entropy || leadership_round_le)
leader_index = SHA3-256("QNET_LEADER_V4.5" || slot_seed || round_start_height_le
                        || leadership_round_le || 0u64_le)[0..8] as little-endian u64  mod  N
producer     = candidates[(leader_index + absolute_round) mod N]
```

The fourth hashed field is a constant zero on every path: the absolute round enters only as the modular shift, so the
normal and the failover branch hash the same preimage and failover is a shift of the round-0 index rather than a
re-hash. Here `leadership_round = (height − 1) / 30`, `round_start_height = leadership_round × 30 + 1` (so the index is
stable across the whole rotation window), `N` is the sorted candidate count, and the absolute round is `timeout_round`
plus `carried_baseline`. Both preimages read only values identical on every node: the macroblock-entropy preimage omits
the macroblock's `consensus_data`, and the candidate contribution hashes node ids only, never the dynamically changing
reputation figure. The schedule is computable roughly two macroblock windows in advance.

### 4.4 Producer failover

The absolute round is a certified quantity, and it is the only input that rotates leadership.

1. A validator emits a signed `TimeoutVote` over
   `QNET_TIMEOUT_V2:{window}:{round}:{anchor}:{high_qc_idx}:{high_qc_hash}:{tip_height}:{tip_hash}`, where
   `window = target_height / 90` and `anchor` is the hash of the macroblock two windows back (zeros before
   window 3). Emission is gated on a stall grace period, a minimum validated-peer count and a minimum uptime,
   and suppressed while the expected producer's heartbeat is fresh; past a hard ceiling on view-progress
   silence it fires unconditionally.
2. When `quorum_size(committee)` **distinct** votes for the **same** `(window, round)` are collected, a
   `TimeoutProof` is formed. The votes themselves are the proof.
3. Certification raises `HIGHEST_CERTIFIED_ROUND[window]` monotonically. That is the sole advance path for
   rotation, and it is what prevents two nodes from each believing they are the producer.
4. A microblock whose absolute round is above zero is rejected at ingest unless the round is certified; the
   block remains replayable while the node pulls that window's certificates, and it may carry its own
   quorum-strength `timeout_proof` inline so a node that missed the one-shot broadcast still converges.
5. `MAX_FAILOVER_ROUND = 50` is a holding cap: the pacemaker keeps emitting the clamped round and requests
   recovery sync in parallel rather than going terminal.

A vote that re-votes for the same `(window, round)` under a *different* anchor is recorded as equivocation; a re-vote
carrying an advanced tip is treated as a legitimate rate-bounded update.

### 4.5 Fork choice and reorg bounds

At a contested height the precedence is, in order: (1) if the window's macroblock is stored and **our** body matches
the certificate-committed hash while the competitor's does not, keep ours; (2) if the **competitor's** body matches and
ours does not, adopt it — the override is two-sided, because a one-sided rule flaps; (3) otherwise the strictly higher
certified absolute round wins; (4) on an equal round, only a same-producer self-fork with a strictly lower **block
hash** and a valid producer signature wins; (5) a lower round never wins.

Reorgs are bounded on both sides. Downward: a rollback below `LAST_FINALIZED_HEIGHT` is structurally refused under
the same mutex that serializes finality advancement. Upward: production parks once the tip exceeds the last sealed
macroblock by `MAX_DERIVED_ROSTER_WINDOWS × MACROBLOCK_INTERVAL = 2880` blocks — a pure function of committed scalars,
so every node parks at the same height. The storage layer rejects an incoming block whose hash differs from the stored
hash at the same height, retains the losing branch keyed by hash, and records equivocation evidence only when both
blocks share a producer — two different producers at one height is a failover race, rejected but never punished.
Punishable conduct is provable double-signing, invalid blocks and conflicting signed blocks; the penalty is a
permanent ban flag in account state.

---

## 5. Finality

### 5.1 The Checkpoint

Finality is Checkpoint-BFT. One consensus object, the `Checkpoint`, commits a window of leader-streamed microblocks.
Its hash preimage, under the domain tag `qnet-checkpoint-v2`, covers: the index, the parent link (hash and index),
`window_head_height`, every microblock hash in the window, `state_root`, the randomness `beacon`, `epoch_commitment`,
`reward_root`, `registry_root`, `logs_root`, `dilithium_pk_root`, `reward_epoch_root`, `total_supply`, the timestamp,
the proposer, and a final tag byte. The proposer's signature is excluded, and quorum-certificate signers are never
hashed.

Two quantities must not be confused: **`index`** is the BFT view (round) and can skip when a view times out, while
**`window_head_height`** is the contiguous chain position, `window × CHECKPOINT_INTERVAL`. A macroblock is sealed
**only** when `window_head_height % 90 == 0`, and its height is the window (`head / 90`), decoupled from the round, so
a skipped round leaves no macroblock gap. Intra-window checkpoints advance finality without sealing anything, and a
transaction's confirmation level is determined by the checkpoint certificate that covers it, at the 30-block cadence.

### 5.2 Committee

The committee for a height is resolved strictly from macroblock N-2 — same rule, same justification as the producer
roster — with no walk-back; a node lacking that macroblock abstains. Committee and seed come from the same macroblock:
the sampler reads that macroblock's own randomness beacon. `sample_committee` is a SHA3 sortition under the domain `COMMITTEE_VRF_v3.36` over `(seed, window, candidate index)`:
it hashes, sorts by hash, truncates to the size cap, then restores original index order. It is the single shared
selection function for **both** macroblock finality and microblock failover voting, so the two layers can never
disagree on membership. Because `COMMITTEE_THRESHOLD == COMMITTEE_SIZE == 1000`, subsampling only occurs above 1000
eligible nodes: at or below that size the sampler is the identity function and the committee is the whole eligible
set. Macroblocks 1 and 2 have no on-chain N-2 anchor and fall back to the five embedded genesis identities, giving a
genesis-era committee of 5 and a quorum of 4.

### 5.3 Quorum certificates

```
QuorumCertificate {
    checkpoint_hash,
    index,
    signers: Vec<NodeId>,
    sig_merkle_root,
    sigs: Vec<Vec<u8>>,    // positionally aligned with `signers`
}
```

Verification requires at least `quorum` signers, one signature per signer, no duplicate signer, every signer a member
of the resolved committee, a recomputing `sig_merkle_root`, and every individual signature valid. Signatures are
checked in parallel and off the consensus select loop behind a two-permit semaphore, so a committee-sized verification
never starves the view-change timer. The message a committee member signs is `QNET_BFT2_VOTE:` followed by the hex of the checkpoint hash. Timeouts sign
`QNET_BFT2_TMO:` over `qnet-timeout-v2 ‖ index_le ‖ high_qc_index_le`, and proposals sign `QNET_BFT2_CKPT:`. Vote
signatures are stored public-key stripped, and each signer's key is resolved from committed on-chain state — the
`vrf_pk` registry row, cross-checked against the registry-root-covered key digest, else the binary-pinned genesis
anchor. A checkpoint carries a reference to its parent certificate (hash and index), which keeps proposal size
independent of the parent's signer count.

### 5.4 Commit rule and the finality ratchet

Safety in the replica state machine is a lock rule: a replica votes only if `cp.index > last_voted_index` and the
proposal's `parent_qc.index >= locked_index`, where `locked_index` is the highest certified index. Adopting a
certificate updates the high certificate and the lock, applies the commit rule, and advances the current index. The
commit rule is **2-chain**: given a checkpoint `C_i` with a certificate at index `i`, if
`C_i.parent_qc.index == i − 1` then index `i − 1` becomes final.

A valid certificate is necessary but not sufficient to move the local finality ratchet, which advances through exactly
one entry point that takes a mutex, refuses while a rollback is in progress, and is strictly monotonic. Before it
advances, three independent local checks must pass: (1) the local chain height has reached the window head; (2) the
local head microblock's `state_root` equals the certificate-committed state root; and (3) **every** local body in the
window matches the certificate-committed per-height hash list. The third check is what prevents finalizing a
same-state, different-body fork tail — except below the adopted snapshot anchor, where snapshot-carried history is
trusted by the weak-subjectivity binding and the per-height comparison is skipped; on divergence the node solicits
block repair instead of advancing. A separate content-verified frontier is raised one macroblock window at a time,
stopping at the first missing or divergent window and floored at the finalized height so pruned bodies below finality
cannot pin it at zero.

### 5.5 View change

A `TimeoutCertificate` (the checkpoint-layer object, distinct from the microblock `TimeoutProof` of Section 4.4)
carries an index, a set of timeout messages and an optional high certificate. It verifies only with at least
`quorum_size` **distinct** committee timeouts all for its own view, each signature valid, and any carried certificate
valid; every caller passes the strict threshold. It is formed exactly once, on the quorum-crossing insert, and sets
the current index to one past the timed out view. Independently, observing `f + 1` timeouts at a higher index triggers
a Bracha-style jump to that view. Per-index consensus state is retained `CONSENSUS_STATE_RETAIN = 128` indices below
the committed frontier, bounding memory to `O(retain × committee)`.

### 5.6 Macroblock acceptance

One function is the sole authority for accepting a macroblock. It rejects a macroblock whose consensus data carries no
checkpoint certificate; requires `window_head_height == index × 90` exactly and
`checkpoint.hash() == qc.checkpoint_hash`; requires exactly 90 microblocks; and binds every consensus-critical body
field to the certificate — the microblock hash list, the state root, the randomness beacon and the timestamp. The
published eligible-producer set, consensus committee and banned-validator set are re-hashed through `epoch_commitment`
and compared to the certified value, so a relayer cannot corrupt the stored roster or ban set. `previous_hash` is part
of the macroblock hash but not a checkpoint field, so a *present* mismatching parent is rejected while an absent one
is tolerated (pruned history, cold join, out-of-order backfill), and a weak-subjectivity floor makes macroblocks at or
below the pinned anchor trusted by hash rather than re-walked. Sealing is all-seal — every committee member writes the
macroblock locally, because its body is a pure function of the committed window, and only the proposer broadcasts.

### 5.7 Production during a finality stall

Block production is not finality-gated. Each window is classified from one atomic read of the last sealed macroblock
and the best certified anchor: **Sealed** (window minus two is at or below the last seal — derive normally), **Defer**
(a certified anchor exists but is not held locally — abstain and pull, never derive) or **Frozen** (finality has
stalled — derive from a frozen anchor). The state before the first seal is never classified Frozen.

In Frozen mode the roster, entropy, beacon and committee are pure functions of the newest sealed macroblock `M_A` plus
the public window index `w`:

```
FrozenRoster       = eligible set of M_A, verbatim, sorted   (constant across the horizon)
FrozenEntropy(w)   = SHA3-256("QNET_FROZEN_ENTROPY_V1" || entropy_of(M_A) || w)
FrozenBeacon(w)    = SHA3-256("QNET_FROZEN_BEACON_V1"  || M_A.randomness_beacon || w)
FrozenCommittee(w) = sample_committee(FrozenRoster, w, FrozenBeacon(w), 1000, 1000)
```

Because only sealed bytes and the window index are folded, no post-seal tail can poison the derivation. The horizon is
`MAX_DERIVED_ROSTER_WINDOWS = 32` windows (2880 blocks); past it the node parks and syncs, which is exactly the reorg
bound of Section 4.5.

---

## 6. Cryptography

### 6.1 One signature scheme

Every authenticated path uses ML-DSA-65 / CRYSTALS-Dilithium3 (FIPS 204): public key 1952 bytes, secret key 4032
bytes, detached signature 3309 bytes. Consensus verification rejects any embedded key whose length is not exactly 1952
bytes, and structural pre-checks reject all-zero signatures and signatures with fewer than 200 distinct byte values
before the lattice math runs.

Certificates carry one individual signature per signer, so certificate size scales with committee size: a quorum
certificate over a 1000-member committee carries up to 1000 3309-byte signatures plus the signer list and a Merkle
root over the signature set, and the macroblock decompression ceiling is sized at 16 MiB accordingly. That size is why
the parent certificate is carried as a reference, why verification runs off the consensus loop, and why the committee
is capped at 1000.

### 6.2 Identity derivation

Node identity is derived, not random, and is never written to disk. Two **independent** keys are derived from one
BIP-39 mnemonic on distinct domains:

| Key | Seed derivation | Purpose |
| --- | --- | --- |
| Consensus key | `xi = SHA3-256("QNet/ML-DSA-65/consensus-identity/v1" ‖ bip39_seed)` | Block signing, votes, timeouts, handshake proofs |
| Wallet key | `xi = SHAKE-256("QNET_WALLET_MLDSA65_v1:" ‖ hex(bip39_seed))[0..32]` | On-chain address, value transactions, claims |

Both go through the FIPS-204 seeded key generation. The key manager is fail-closed: on a cache miss it reports the
identity as not installed rather than loading from disk or generating a random keypair. A wiped node re-derives the
identical identity from the mnemonic, which is the only backup. Secret keys are zeroized on drop, and a startup
self-test proves the derived keys verify under the production verifier, with a tampered-message negative control,
exiting the process on any failure.

### 6.3 Addresses

An account address ("EON") is 45 characters: 19 lowercase hex, the literal `eon`, 15 lowercase hex, and an 8-character
checksum, where the hex body is SHA-512 of the **raw 1952-byte ML-DSA-65 wallet public key** and the checksum is the
first four bytes of SHA3-256 over the body. The address is therefore itself the address-to-key binding:
value-transaction verification enforces `derive_address(pk) == tx.from` on every path — gossip admission, submission,
block validation and producer-local checks — so a substituted key yields a different address and fails the check. It
is also why the public key is elidable on the wire, present only on an address's first on-chain transaction and
rehydrated from committed state thereafter.

### 6.4 Hash functions and accumulators

SHA3-256 is used for block hashes, transaction hashes, the state tree, all Merkle trees and every domain tag.
SHAKE-256 is used in wallet-seed derivation and multiset-hash lane expansion; SHA-512 in address derivation and in
mnemonic-based key derivation — PBKDF2-HMAC-SHA512 produces the BIP-39 seed that both keys of Section 6.2 start from,
and HMAC-SHA512 drives the SLIP-10 child derivation of the external burn wallet; BLAKE3 in the wallet-derived node
pseudonym, which is consensus-checked at registration apply (Section 8.6), and in non-consensus derivations such as
device-token hashing and Kademlia region keys.

Three accumulator constructions coexist because they serve different jobs:

1. **Domain-separated binary Merkle tree** — leaves `SHA3-256(0x00 ‖ leaf)`, internal nodes
   `SHA3-256(0x01 ‖ left ‖ right)`, odd tail duplicated. Used for transaction and reward proofs.
2. **Sparse Merkle tree, depth 256** — internal nodes are plain `SHA3-256(left ‖ right)` with domain separation
   living in the leaves. Used for account and contract state (Section 7).
3. **LtHash multiset hash** — 1024 lanes of 16 bits (2048 bytes of state), rows expanded through SHAKE-256 and
   combined by component-wise wrapping addition so removal is the exact inverse. Used for `registry_root`,
   `dilithium_pk_root` and the reward-epoch commitment.

### 6.5 Domain separation

Every signed or hashed preimage is domain-tagged, so a signature or digest produced for one purpose can never be
replayed as another. The consensus-critical set is `Block_Sig_v23.1`, `QNET_BFT2_VOTE:` / `QNET_BFT2_TMO:` /
`QNET_BFT2_CKPT:`, `qnet-checkpoint-v2`, `qnet-timeout-v2`, `qnet-leader-v2`, `qnet-beacon-v2`, `qnet-epoch-v2`,
`QNET_LEADER_V4.5`, `QNet_VRF_Round_Entropy_v1`, `QNet_VRF_SlotSeed_v4`, `QNet_Deterministic_Entropy_v2.33`,
`EPOCH_VALIDATOR_VRF_v3.37`, `COMMITTEE_VRF_v3.36`, `QNET_FROZEN_ENTROPY_V1` / `QNET_FROZEN_BEACON_V1`, `QNET_ADDR:` /
`QNET_ACCOUNT_V2:` / `QNET_STORAGE_KEY:` / `QNET_STORAGE_VAL:`, `qnet-registry-root-v2` / `qnet-registry-row-v4`,
`qnet-dpk-row-v1` and `qnet-reward-epoch-root-v1`. The full inventory, including the transport, claim,
burn-attestation, contract and Merkle tags, is in
[docs/architecture/cryptography.md](docs/architecture/cryptography.md).

### 6.6 The window randomness beacon

Each checkpoint window commits a `beacon`: an order-independent XOR fold of the block hashes of that window — the same
hashes the certificate commits — domain-hashed with the tag `qnet-beacon-v2`. Because the fold is order-independent
and reads only certificate-signed hashes, every node holding the window derives the identical value, and the beacon is
itself a certificate-signed checkpoint field. It seeds the two sortition functions of Section 4.2 and Section 5.2 —
roster truncation under `EPOCH_VALIDATOR_VRF_v3.37` and committee sampling under `COMMITTEE_VRF_v3.36` — both reading
the beacon of macroblock N-2, so the randomness a window consumes was sealed roughly two macroblock windows earlier.

### 6.7 Transport security

Peer traffic runs over QUIC with TLS 1.3 pinned, the `aws-lc-rs` provider, and ALPN `qnet-p2p-v1`. The TLS
certificate is self-signed with a node-derived subject name and carries encryption, with a trust-on-first-use
fingerprint pin (24-hour lifetime, 2-hour rotation grace) layered on top.

Peer identity is asserted by an application-layer ML-DSA-65 proof over
`qnet-quic-handshake-v2:{node_id}:{timestamp}:{block_height}:{channel_binding}`, where the channel binding is a
32-byte TLS keying-material export under the label `qnet-quic-channel-binding-v1`, so a proof captured from another
session cannot be replayed; if the exporter is unavailable the connection is refused rather than downgraded. The proof
is mandatory: a peer that presents none, presents malformed bytes, or presents one that fails under the claimed
identity's registered key is refused. Consensus authority is decided per
message, from signatures verified against committed on-chain keys. A pre-verification address gate pins genesis
identities to their five compiled-in addresses and registered Super nodes to their on-chain endpoint address. That
endpoint is written at apply by a node's registration and refreshed by its reactivation, persisted with the chain data
and rebuilt at boot, so the gate is armed for the first inbound connection after a restart and a node that moves to a
new address republishes it on chain.

---

## 7. State and storage

### 7.1 Account model

State is a flat map from a 45-character address to an `Account`. An account holds balance, nonce, node flags and type,
reputation, timestamps, contract fields (`is_contract`, `contract_code_hash`, `contract_storage`, `storage_root`), the
liveness quartet (`heartbeat_epoch`, `heartbeat_slots`, `heartbeat_final_epoch`, `heartbeat_final_slots`), the claim
watermark `last_claimed_epoch`, the cached public key and `banned_at_height`.

### 7.2 State commitment

The commitment is a sparse Merkle tree of fixed depth 256 — the full width of the address hash — so every leaf
converges to one root at a fixed depth.

- Leaf position: `SHA3-256("QNET_ADDR:" ‖ address)`.
- Leaf value, under the tag `QNET_ACCOUNT_V2:`: balance (LE u64), nonce (LE u64), address bytes, `is_contract`,
  then conditionally `CODE:` ‖ code hash and, for contracts only, `SROOT:` ‖ storage root, then unconditionally
  `HB:` ‖ the four heartbeat fields, `LCE:` ‖ last claimed epoch, `BAN:` ‖ banned height, `NODE:` ‖ is-node.
  Reputation stays outside the leaf because a 64-bit float is not deterministic across platforms; the public
  key stays outside because the address already commits to it.
- Internal nodes are `SHA3-256(left ‖ right)` with no 0x00/0x01 prefixes — unlike the binary Merkle tree of
  Section 6.4 — and empty subtrees use a precomputed default-hash ladder seeded from the all-zero hash. Depth 0
  splits on the **last** bit of the key (`level_bit = 255 − depth`), making every subtree a contiguous key range;
  the mobile verifier is pinned to the same bit order. Inclusion proofs are exactly 256 `(sibling, is_right)`
  pairs and verification re-checks each direction bit against the address hash.

Path compression is a **storage** property, not a hashing property: the fold always runs all 256 levels, but only
branch nodes and the tops of single-leaf chains are persisted, and the chain below a single-leaf node is derived on
read. A missing *branch* node is never served as a default — the subtree is rebuilt in place if small enough,
otherwise the root is recomputed in full. Contract accounts additionally commit a per-contract storage tree of the
same type, keyed `SHA3-256("QNET_STORAGE_KEY:" ‖ key)` with values `SHA3-256("QNET_STORAGE_VAL:" ‖ value)`; its root
is the `SROOT:` field of the account leaf, which makes an individual token balance provable by a two-level proof.

### 7.3 The node registry

The registry is a row per node id plus two roster index prefixes, one for super/genesis identities and one for light
identities. Once a chain apply has stamped a row, the identity fields — wallet, registration height, burn, node type,
key digest and registration index — are immutable; a discovery-cache write can never rebind them. Registration indices
are drawn from six independent monotone counters (one super/genesis space, five light shards), so an index is only
meaningful inside its own space.

`registry_root` is the LtHash of the row set, wrapped as `SHA3-256("qnet-registry-root-v2" ‖ state)`, with each row
seeded by SHA3-256 over the tag `qnet-registry-row-v4` and the length-prefixed node id, wallet, registration height,
registration index, node type, burn and key digest. The accumulator is updated in the same write batch as the row, so
the two cannot disagree across a crash; it is sealed per checkpoint for constant-time reads, and a missing seal falls
back to a from-scratch scan that **fails closed** on any iterator error. `dilithium_pk_root` uses the same primitive
over per-account public keys, so an untrusted snapshot cannot omit or alter one. Both are checkpoint fields and
therefore certificate-signed.

### 7.4 Transactions

Transactions are typed. System-typed transactions — registration, activation, reactivation, heartbeat, eligibility
bitmap, reward distribution, key rotation and both equivocation proofs — pay zero gas. The transaction hash preimage
clears the hash, both signature fields and the public key, so an elided transaction hashes identically to its
first-use form. Structural wire limits on every free-form field are enforced on the block-validation path.

Transactions are chain-bound. One builder produces the canonical signed message per transaction class and prefixes the
chain tag `q{chain_id}|` at its single exit point, so no class can be left unbound and node, mobile wallet and browser
extension reconstruct the same bytes. The same identifier is a transaction field inside the hash preimage and is
checked on both the RPC and the gossip ingress, so a signature is valid on exactly one chain and the field cannot be
rewritten in flight to mint a second hash for one signature. The chain identifier is a compile-time constant: two nodes
disagreeing on it would compute different preimages.

### 7.5 Persistence and retention

Storage is RocksDB with 30 declared column families and one shared block cache. The Merkle leaf and node sets live on
disk with bounded read-through caches, wired from block zero, and the in-memory account map is an LRU cache with
persist-before-evict, never the authority. Retention is per-artifact and asymmetric: transaction indexes 100,000 blocks; microblock **bodies** 86,400 blocks (six
epochs) on Super nodes, while macroblocks, height-to-hash aliases, snapshots and account state are kept; registry and
supply seals one 14,400-block window; the newest three snapshots. A compile-time assertion links body retention to the
snapshot switch gap and the retained snapshot span, the invariant that makes pruning safe for cold join, and
interfaces affected by pruning report the prune floor explicitly. Cold-join snapshots are restored into parallel
staging column families, verified — including re-deriving each contract's storage root — and only then promoted.

### 7.6 Contracts

The VM is a deterministic WASM interpreter, live from genesis. Determinism is enforced structurally at deploy —
floating point disabled (so all float types and operators are rejected), threads, atomics, SIMD, reference types, GC,
tail calls and exceptions off, an explicit bounded memory maximum required, imported memory and tables forbidden — and
at runtime by fuel metering, a memory-growth limiter and sorted storage. Contract addresses are always derived as
`SHA3-256("qnet_contract_v1" ‖ from ‖ nonce)`, never caller-supplied, and deployment is init-once. Reentrancy is
blocked at the VM layer, cross-contract depth is capped at 8, one fuel budget is threaded across frames, and the only
time-like host input is the slot-anchored block height. The two token standards, QRC-20 and QRC-721, are implemented
natively in the apply arms; their events and WASM `emit_log` share one per-block sink whose leaves form a per-block
sub-root that is merkled across the 90-block window into `Checkpoint.logs_root`, active from genesis and
certificate-signed, so an inclusion proof costs one block rather than one window.

---

## 8. Economics

### 8.1 Emission

Emission is a pure function of block height with no clock and no state read:

```
years          = height × 1s / 31,536,000
halving_cycles = years / 4
emission(cycles) = 251,432,340,000,000 nanoQNC / divisor, and exactly 0 once cycles >= 50
    divisor = 2^cycles              for cycles 0..4
            = 160                   for cycles == 5    (four halvings, then a further /10)
            = 160 × 2^(cycles − 5)  for cycles > 5     (shift exponent clamped at 63)
```

The base is 251,432.34 QNC per emission interval at cycle 0, one halving every four emission-years, and one
non-halving "sharp drop" at cycle 5 that multiplies the reduction by ten before normal halving resumes from the lower
base. An emission is due only at heights that are exact multiples of `EMISSION_BLOCK_INTERVAL = 14,400` (four hours at
one block per second) and at or above the second interval, so the first emission lands at height 28,800 and pays a
reward epoch that has already closed and been certified. A scheduled amount of zero is reported as "none due" rather
than "exactly zero", so producer, validator and the window recompute all agree that no transaction must exist.

Supply is bounded by `MAX_QNC_SUPPLY = 2^32` QNC (`× 10^9` nanoQNC). Genesis sets `total_supply = 0` and creates no
accounts, so every unit in circulation entered through emission at a scheduled height. The mint is
watermark-idempotent, clamped to the remaining headroom, and credits the pool exactly what was minted; it is the only
site in the workspace where total supply increases.

### 8.2 The reward pool and the epoch commitment

The emission transaction moves value from `system_emission` to `system_rewards_pool`, a real account whose balance is
in the state tree and therefore in `state_root`. Its amount is never read from the transaction body: every node
re-derives it from height and accepts the transaction only if the amount matches and the payload carries the expected
version.

A reward epoch is keyed by a macroblock index (`MB_PER_EPOCH = 14,400 / 90 = 160`). Epoch `E`'s authoritative reward
root is the `reward_root` field of the checkpoint sealed inside macroblock `E + 160` — a certificate-signed value, not
a transaction field. A separate checkpoint field, `reward_epoch_root`, is an LtHash commitment over every epoch root
certified at or below the N-2 macroblock; its builder defers and triggers a repair fetch rather than folding a shorter
set. At an emission boundary whose leaf set is not locally derivable the window builder produces nothing and the
caller defers.

### 8.3 Distribution

Each epoch's total splits two ways: `OPERATOR_POOL_BP = 2500` basis points (25%) to eligible super/genesis operators
and the remaining 75% to eligible light nodes. Within each pool the share is exactly equal per eligible node id
(`per_node = pool / count`, with the remainder distributed one nano each to the first nodes in sorted order so the sum
is conserved), and shares are accumulated **per wallet**, so a wallet holding both a super and a light identity
produces a single leaf. If one side has no eligible recipients its whole share goes to the other.

Eligibility is proven on-chain, not self-attested. A **super or genesis** node needs `banned_at_height == 0` and a
heartbeat sub-window popcount of at least 9 for the epoch, read from committed account state: the 14,400-block epoch
is divided into ten sub-windows of 1440 blocks, a heartbeat transaction sets its sub-window's bit, and it is
admissible only within `HB_ANCHOR_MAX_LAG = 90` blocks of its anchor — which is also why the eligible set is sampled
90 blocks past the epoch boundary rather than at it. A **light** node is eligible if its bit is set in the per-epoch
bitmaps published by the genesis nodes, one per hash shard, indexed by its permanent registration index. A node that
cannot locally derive its set abstains rather than voting a root that pays nobody. The reward leaf is
`SHA3-256(wallet ‖ epoch_le ‖ amount_le)`, and the recipient set is streamed and hashed one 4096-leaf shard at a time.

### 8.4 Claims are pull-only

Emission credits the pool; a wallet is credited only when it submits a proof-carrying claim transaction, through a
two-step handshake. First the node **quotes** a batch — the claim data, a signing message, a timestamp and the
wallet's current watermark — enumerating epochs strictly above the watermark in ascending order and **stopping** at
the first epoch it cannot serve. Then the wallet re-posts the same bytes with an ML-DSA-65 signature over
`qnet_claim_v1:{wallet}:{timestamp}:{hex(SHA3-256(claims_data))}`; binding the timestamp is what stops a replay. The
claimant wallet must equal the on-chain registered wallet for the node id, the address derived from the transaction's
public key must equal the recipient, and a claim pays no fee.

At apply, entries are sorted by epoch ascending, each proof is verified against the certified root, the pool is
debited, the wallet is credited, and `Account.last_claimed_epoch` — part of the account leaf, therefore
consensus-bound — advances. Because that watermark is **monotonic**, a batch must stop rather than skip on a failure:
skipping would permanently forfeit the skipped epochs. Two fail-closed rules complete the design: a claim larger than
the pool balance is refused *without* advancing the watermark, so the wallet may retry later; and a node that cannot
resolve an epoch's certifying macroblock must abort the whole block rather than credit or skip, because either choice
would fork the state root. Pool remainder plus credited balances equals what was minted, and a claim leaves total
supply unchanged.

### 8.5 Fees

Fees are separate from emission and are credited in full to the block producer.

| Parameter | Value |
| --- | --- |
| `NANO_PER_QNC` / decimals | 1,000,000,000 / 9 |
| `BASE_FEE_NANO_QNC` / `MIN_GAS_PRICE` | 100,000 nanoQNC / 10 nanoQNC per gas unit |
| Quantum-signature premium | +50% on the effective gas price |
| `gas_limits::TRANSFER` / `REWARD_CLAIM` / `MAX_GAS_LIMIT` | 10,000 / 25,000 / 1,000,000 |
| `GAS_METERING_ACTIVATION_HEIGHT` | 100,000 |
| Refundable contract-storage deposit | 10,000,000 nanoQNC per new entry |

The sender prepays `effective_gas_price × gas_limit` at apply. From height 100,000 onward the unused remainder is
refunded, less the metered WASM fuel charge. One hundred percent of the recomputed net fee is credited to the block
producer's on-chain registered wallet; if no registered wallet resolves, no fee is credited at all. The credited
amount is recomputed from the applied transactions, never read from the block header's `fees_collected` field.

### 8.6 Two-phase node activation

| | Phase 1 (active) | Phase 2 |
| --- | --- | --- |
| Payment | Burn of the external 1DEV token on Solana | QNC transferred on QNet |
| On-chain `amount` | Must be 0 | Chain floor: 3,750 QNC (Super) / 5,000 QNC (Light) |
| Price | Universal across node types: `max(1500 − 150 × floor(burn% / 10), 300)` whole 1DEV | Base 10,000 QNC (Light) / 7,500 QNC (Super) × a network-size multiplier of 0.5 / 1.0 / 2.0 / 3.0 |
| Destination of funds | Destroyed on the external chain | Deducted from the payer |

The transition to Phase 2 fires at 90% of the 1DEV supply burned or five years from the genesis block timestamp,
whichever comes first. Phase-1 pricing is universal, so a light node and a super node pay the same; in Phase 2 Light
costs more than Super. The chain floor is a pure function of the transaction and two compile-time constants, and it is
enforced on the block-apply path every node runs when accepting a block, so a producer sealing its own activation is
bound by the same price as a submitted one; the same check runs at admission to keep an underpriced activation out of
the mempool. Two distinct transactions carry the flow: `NodeActivation` flips `Account.is_node`, is one-shot
per (wallet, phase) and carries the Phase-2 payment, while `NodeRegistration` creates the registry row, roster index
and registry-root entry and is one-shot for the chain's lifetime.

Registration binds a burn to a specific node identity through four independent artifacts, all re-verified
deterministically at apply with no external read: (1) `node_id` must equal the deterministic wallet-derived pseudonym
(`light_mobile_…` or `super_node_…`, domain-separated so one wallet has independent identities in each namespace); (2)
a signature by the burning wallet, under the external chain's own scheme, over
`qnet_onchain_reg:{node_id}:{wallet}:{proof}:{timestamp}:{attest_root_tag}:{burn_tx}`, whose tag binds the ML-DSA-65
key digest; (3) a quorum of **distinct committee** ML-DSA-65 signatures over
`burn_attest:{burn_tx}:{burn_wallet}:{wallet}:{amount}:{node_type}:{cost}:{attest_epoch}`, where each attestor
independently re-verifies the external burn and recomputes the price from its own supply read, attestor eligibility is
the consensus committee of the attestation epoch, and that epoch must be within two epochs of the apply height; and
(4) a committed `burn_tx → node_id` uniqueness index, keyed on node id rather than wallet because one wallet owns two
pseudonyms and a wallet-keyed bind would let one burn activate both tiers. The reward wallet must be derivable either
from the signing ML-DSA-65 wallet key or from the burning external address. Genesis identities are burn-exempt, bound
to the five hardcoded ids.

---

## 9. Security considerations

The design assumes a Byzantine adversary that controls up to `f` committee members, sees all traffic, and schedules
delivery within partial synchrony. It cannot forge ML-DSA-65 signatures or find SHA3 collisions. The protections below
follow from that model.

**Signature forgery and identity substitution.** The address is the key commitment, so substituting a key changes the
address and fails the binding check. Registry rows are immutable once chain-stamped, and re-registering an id with a
different key is rejected. Consensus-grade verification resolves every signer key from committed on-chain state or the
binary-pinned genesis anchor, so no process-local, node-varying set can decide validity.

**Equivocation.** Two blocks at one height from the same producer produce an equivocation record and a permanent ban
written into account state, inside the state root and therefore consensus-bound. Two blocks from *different* producers
is a failover race: rejected, never punished. Timeout votes for one round under different anchors are likewise
attributable, and the losing branch is retained rather than deleted so the evidence survives.

**Long-range history and fork finalization.** A weak-subjectivity floor gates re-verification; below it, history is
trusted by pin, and light clients walk N-2 parity chains from the binary-pinned genesis anchor, binding each committee
key to the epoch's `registry_root`. A valid certificate alone never finalizes: the local tip, the local state root and
every local body hash in the window must match the certified values, which is what closes the
same-state-different-body attack. Rollback below the finalized height is structurally refused.

**Denial of service.** The transport applies a layered ladder in a fixed order: pre-handshake address bans from a
failed-handshake token bucket, a global connection cap, three-tier per-address connection caps, a bounded handshake
semaphore with a timeout, the address-identity gate, the signature check, per-type pre-deserialization size ceilings,
and per-(address, node id) serve rate limits. Inbound messages are split into three quality-of-service lanes so a
bulk-sync flood cannot starve checkpoint and failover frames, and compressed payloads are decoded through bounded
readers. Signed consensus messages are bounded by protocol-level uniqueness — one vote per member per round — rather
than by a count-based limiter.

**Eclipse resistance.** Reserved outbound slots, an inbound reputation floor and per-/24 and per-/16 inbound
concurrency caps constrain admission; all four are compile-time constants, identical on every node, so one network
neighbourhood cannot own a node's peer table. Peers learned through peer exchange enter by that same admission path,
the identity bound to a gossiped address is resolved from the pinned genesis table or the chain-committed endpoint
rather than from the relaying peer's claim, and the number of new peers taken from any one response is capped, so
discovery converges over repeated exchanges instead of letting one relay shape the peer set. Consensus decisions are
anchored to certified data rather
than to peer opinion: a node that cannot resolve macroblock N-2 abstains, so an eclipsed node stalls instead of
following an attacker's chain.

**Randomness.** The window beacon is a certificate-signed fold of committed block hashes (Section 6.6) and is consumed
two macroblock windows after it is sealed, so a window's contribution reaches a roster and committee two windows in
the future rather than the slot it is producing, and the sortition it seeds is uniform over the eligible set.

**Quorum loss.** If more than `f` committee members are lost, finality halts at the last certified checkpoint. Block
production continues off the frozen roster of Section 5.7 for up to 32 windows and then parks, and finality resumes
when a quorum of the resolved committee is reachable again.

**Committee-size assumption.** The cap of 1000 is chosen for the equivocation bound: an attack requires at least
`f + 1` sampled Byzantine members, and the sampling failure probability falls exponentially in committee size. At or
below 1000 eligible nodes there is no sampling, so the assumption reduces to the quorum assumption over the whole
eligible set.

---

## 10. Further reading

Operational and subsystem detail lives in the documents indexed at [docs/README.md](docs/README.md) — consensus,
cryptography, state and networking under [docs/architecture/](docs/architecture/overview.md), emission and activation
under [docs/economics/](docs/economics/overview.md), node operation under
[docs/operators/](docs/operators/running-a-node.md), and the client surface under
[docs/developers/](docs/developers/rpc-api.md).
