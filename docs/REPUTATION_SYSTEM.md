# QNet Reputation & Liveness

## Model: binary consensus reputation

Consensus reputation is **binary {70 | 0}** — a pure deterministic fold of the committed
chain, identical on every node:

- Every node starts at `INITIAL_REPUTATION = 70`.
- A node drops to `0` **only** on a cryptographically-proven equivocation (block double-sign
  or same-round checkpoint double-vote). The ban is **permanent**.
- The only consensus use is the admission gate: a node is eligible iff `reputation >= 70`
  (`MIN_REPUTATION_BP = 7000`) — i.e. not equivocation-banned.

There is **no graduated score, jail, decay, or recovery** on the consensus path. Producer and
committee selection is **uniform-VRF** among all eligible nodes — the reputation value never
ranks anyone — so a gradient would feed nothing.

### Why binary (design rationale)

- **Uniform-VRF** makes a graduated value useless for ranking and prevents validator-set
  entrenchment at scale (a rank-by-reputation top-N locks out ~99% of nodes at 100k+).
- **Proof-of-burn** economics (no locked stake): there is nothing to slash for downtime; the
  Sybil cost is the one-time burn, and exclusion of failing nodes is delivered for free by the
  liveness gate.
- A mutable per-node "who failed / who was slow" counter is **timing-dependent** (nodes detect
  timeouts at different moments) → divergent state → fork. It is therefore deliberately absent;
  consensus eligibility must be a pure function of finalized chain state.

## What gates consensus (four layers, none is a reputation score)

| Threat | Defense |
|--------|---------|
| Sybil / many identities | Proof-of-burn cost per node + 2f+1 committee burn-attestation binding each registration to a real on-chain burn |
| Double-sign / equivocation | Cryptographic proof (ML-DSA-65) → permanent ban; ban-set anchored per-macroblock in `consensus_data.banned_validators`, re-verified each epoch (O(window), pruning-safe) |
| Invalid block | Rejected at validation (sig/hash) before apply; if it reached a QC, requires proof = permanent-ban class |
| Censorship by a producer | Uniform-VRF rotation (30 blocks/producer) + 2f+1 timeout-round failover; next producer from the same eligible pool |
| Slot timeout / silent producer | Failover skips it, **no penalty** — missed-block attribution is deterministically unsound post-failover |
| Offline / lagging node | Heartbeat-liveness gate: a non-heartbeating node deterministically drops from the eligible set within ~2 subwindows |
| Absentee committee member | Carryover only with a signed on-chain commit in >=1 of the last 3 macroblocks |
| VRF grinding | Selection entropy = SHA3 of the finalized N-2 macroblock; reputation is forbidden in the entropy |

## Liveness: unforgeable on-chain heartbeats

Super/Genesis liveness (which also gates per-epoch rewards) is proven by on-chain `Heartbeat`
transactions, not by RAM gossip:

- Each node emits ~10 tiny Dilithium-signed `Heartbeat` TXs per 4-hour epoch (one per
  ~1440-block subwindow). Each TX is anchored to a recent canonical block hash (cannot be
  pre-signed) and must be included within ~90 blocks of its anchor (cannot be backfilled). It is
  verified at block validation against the node's registry public key.
- A per-node subwindow bitmask lives in account-state (part of `state_root`). Reward eligibility
  = `popcount(bitmask) >= 9` of 10 — recomputed identically by every node from the chain, with no
  central tallier and no end-of-epoch scan.
- Producer eligibility (Phase-2A) additionally requires a heartbeat in the current or previous
  subwindow, so an offline/lagging node drops out automatically.

Heartbeat network load scales linearly and stays negligible:

| Nodes | Heartbeats / 4h | Rate | Bandwidth |
|-------|-----------------|------|-----------|
| 1,000 | 10,000 | 0.7/s | 2.8 Kbit/s |
| 10,000 | 100,000 | 7/s | 28 Kbit/s |
| 100,000 | 1,000,000 | 70/s | 280 Kbit/s |

Light nodes have a fixed 70 reputation, never produce blocks, and prove liveness via a
deterministic per-window ping (shard-assigned, 1 ping per 4h).

## Slashing (equivocation only)

| Offense | Result | Evidence |
|---------|--------|----------|
| Double-sign (2 valid sigs, same height) | Permanent ban (rep 0) | `EquivocationProof` TX, re-verified (ML-DSA-65) |
| Same-round checkpoint double-vote | Permanent ban | `VoteEquivocationProof` TX, re-verified |
| Invalid block | Rejected before apply | Block validation (sig/hash) |

**Not slashable — missed blocks.** There is no deterministic post-facto "who should have
produced" (no `original_producer` field, failover overwrites slot ownership, partitions cause
false positives). Missed-block liveness is handled by the heartbeat gate + no-penalty failover,
never by a slashing counter.

The ban-set is a pure fold: `bans(N) = bans(N-1) ∪ {verified proofs in window N}`, anchored in
the macroblock body and re-verified every epoch through `epoch_commitment` (the eligible set
excludes banned). A stale or forged copy self-heals via `content_ok` fail-stop instead of forking.

## Finality checkpoints

Long-range protection: a macroblock is final once `FINALITY_DEPTH = 2` macroblocks carry
`FINALITY_THRESHOLD = 0.67` (2f+1) committee signatures.

```rust
pub const FINALITY_DEPTH: u64 = 2;
pub const FINALITY_THRESHOLD: f64 = 0.67;

pub struct FinalityCheckpoint {
    pub macroblock_index: u64,
    pub macroblock_hash: [u8; 32],
    pub signatures: HashMap<String, Vec<u8>>, // 2f+1 validators
    pub is_final: bool,
}
```

## Off-consensus telemetry

A richer reputation/uptime score may be kept for explorer/operator display, but it is RAM-local
and must **never** feed eligibility, `epoch_commitment`, or any QC-bound field.

## Code locations

| Component | File | Symbol |
|-----------|------|--------|
| Consensus reputation fold {70\|0} | `node.rs` | `compute_consensus_reputation_map` |
| Equivocation ban-set | `node.rs` | `compute_cumulative_ban_set` |
| Eligible producers + heartbeat gate | `node.rs` | `create_eligible_producers_snapshot` |
| Parameters | `deterministic_reputation.rs` | `INITIAL_REPUTATION`, `MIN_CONSENSUS_REPUTATION` |
| Finality | `macro_consensus.rs` | `FinalityManager`, `FinalityCheckpoint` |
