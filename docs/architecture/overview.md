# System overview

This document describes how QNet is put together: the two-tier block structure, the path a transaction
takes from submission to irreversibility, what each node type does, the concurrent processes inside a
running node, which crate owns which part of the protocol, and the data flows that connect them. Each
section links to the reference document that covers the subject in full.

## The two-tier chain

QNet separates *ordering* from *agreement*. A single elected producer appends microblocks on a fixed
slot with no vote round, which is what keeps the chain appending while peers are partitioned or slow.
Agreement is then reached periodically by a committee that certifies a whole window of microblocks at
once with a quorum certificate. The two layers have independent failure modes: a stalled producer is
resolved by a signed timeout certificate that rotates leadership, while a stalled committee stops
finality without stopping block production.

| Parameter | Constant | Value |
| --- | --- | --- |
| Microblock slot | `MICROBLOCK_INTERVAL_SECS` | 1 second |
| Producer rotation | `ROTATION_INTERVAL_BLOCKS` | 30 microblocks |
| Finality checkpoint cadence | `CHECKPOINT_INTERVAL` | 30 microblocks |
| Macroblock / epoch window | `MACROBLOCK_INTERVAL` | 90 microblocks |
| Producer-eligible cap | `MAX_VALIDATORS` | 1000 |
| Committee cap | `COMMITTEE_SIZE` = `COMMITTEE_THRESHOLD` | 1000 |
| BFT quorum | `quorum_size(n)` | `n − floor((n−1)/3)` |
| Checkpoint view timeout | `VIEW_TIMEOUT_MS` | 4000 ms |
| Reward emission interval | `EMISSION_BLOCK_INTERVAL` | 14400 microblocks |
| Frozen-roster production horizon | `MAX_DERIVED_ROSTER_WINDOWS` | 32 windows (2880 blocks) |

Consequences of the arithmetic:

- Exactly three producers cover one macroblock window (90 / 30). A compile-time assertion enforces
  that `CHECKPOINT_INTERVAL` divides `MACROBLOCK_INTERVAL`, so every macroblock boundary is also a
  checkpoint boundary.
- Finality advances within a window. Checkpoints at 30 and 60 blocks into a window finalize
  microblocks without sealing; a checkpoint whose `window_head_height` is a multiple of 90 also
  carries a macroblock seal, held until the 2-chain commit reaches its index and releases it.
- A checkpoint's `index` is the BFT view and may skip on timeout; a macroblock's height is the window
  (`head / 90`). They are different quantities, so a skipped view leaves no macroblock gap.
- The quorum is `n − f`, which equals `2f+1` only when `n = 3f+1`. At the five genesis identities the
  quorum is 4.
- Because `COMMITTEE_THRESHOLD` equals `COMMITTEE_SIZE`, committee sampling only subsamples above 1000
  eligible nodes; below that the committee *is* the whole eligible set.
- Block timestamps are a pure function of height (`genesis_ts + height × MICROBLOCK_INTERVAL_SECS`) and
  are validated by exact match, so the wall clock is never a consensus input.

Block production runs independently of finality. If finality stalls, each node keeps producing on a
roster derived purely from the last sealed macroblock's bytes, bounded to 2880 blocks past that seal,
then parks and syncs. Rollback below the finalized height is refused. Those two rules together bound
reorg depth.

Full treatment: [consensus](./consensus.md).

## Measured performance

Every figure below is an end-to-end measurement over public RPC on a live 5-node network of
budget VPS hosts (8 vCPU class), taken by a load harness that counts a transfer only after the
block containing it is certified by a checkpoint: submitted → included → finalized. Nothing here
is a single-process benchmark.

- **Sustained throughput: 13,000 transfers/s** — the highest load rung that held ≥99% inclusion
  and finalization over a continuous 10-minute run (99.79%, 12,975 finalized transfers/s).
  12,000/s ran at 99.97% with exactly one block per second end to end (932 blocks in 932 s).
- **Peak throughput: 16,000 transfers/s** over 5-minute windows (99.79%). Sustained rungs above
  13k degrade gracefully: the pool queues and self-drains with no forks and no network halt
  (14k settles at ~9.2k/s effective, 20k at ~11k/s).
- **Single-signature transactions: ~450/s** on this hardware. Each carries its own 3,309-byte
  ML-DSA-65 signature and there is no standardized batch verification for ML-DSA, so the
  per-signer rate is bound by signature-adjacent work and scales with cores.
- **Batch transfers** put up to 1,000 payments under one ML-DSA-65 signature (3.3 signature
  bytes per transfer). The batch is signed and verified as one plain FIPS 204 message — no
  custom cryptography — which is what moves the throughput bound from signatures to state
  application.
- **Finality latency**: inclusion is seconds (p50 2–5 s at moderate load); hard BFT finality is
  the checkpoint certificate — p50 ~109 s measured at maximum sustained load (including ~30 s of
  inclusion queueing), bounded by the checkpoint cadence when idle.

The block work budget is calibrated from these runs (Ethereum-style target/limit split):
`BLOCK_GAS_LIMIT` = 200M (20 batches — the measured burst boundary: a backlog of limit-sized
blocks drains without a cadence avalanche but cannot be sustained on floor hardware) and the
producer fill target `BLOCK_FILL_SOFT_GAS` = 130M (13 batches — the highest 10-minute-sustained
rung, with the slot-schedule catch-up supplying the drain margin).

## Lifecycle of a transaction

1. **Construction.** The client builds the transaction and signs it with ML-DSA-65. The sender address
   is derived from that public key, so `from` is bound to the signature by construction rather than by
   a lookup. See [cryptography](./cryptography.md).
2. **Submission.** `POST /api/v1/transaction` on any Super node. The handler validates both EON
   addresses, then verifies the ML-DSA-65 signature on a blocking worker behind a bounded semaphore, so
   a burst of signature work cannot starve the async runtime.
3. **Admission.** `Transaction::validate()` runs, plus a gas-limit ceiling check, a chain-id check that
   rejects cross-chain replay, and a type whitelist that admits only the externally submittable
   transaction types. The RPC ingress and the gossip ingress apply the same whitelist.
4. **Mempool and gossip.** The transaction is stored in the mempool in its binary form keyed by hash
   and gas price, broadcast to peers, and surfaced as a pending-transaction WebSocket event.
5. **Inclusion.** The producer elected for the slot drains the mempool up to the per-block limit (bundle
   allocation first when MEV protection is enabled, public transactions after), prepends the emission
   transaction on emission blocks, computes the merkle root and the new state root, and signs the block
   digest with ML-DSA-65 before broadcasting.
6. **Ingestion on every other node.** Blocks enter the staged pipeline `Ingest → Decode → Verify →
   Apply → Notify`. Each stage has a bounded channel, so a bad or oversized block is dropped at its own
   stage instead of stalling the pipeline. Verify is parallelizable; Apply is a single sequential
   RocksDB writer by design and performs all side effects.
7. **Certification.** At each checkpoint boundary the committee agrees on one `Checkpoint` object
   binding the window's microblock hashes, the state root, the randomness beacon, the epoch commitment
   and the reward, registry, logs and public-key roots. A quorum certificate is an explicit signer list
   carrying one ML-DSA-65 signature per signer.
8. **Finality.** The commit rule is 2-chain: a QC at index *i* on a checkpoint whose parent QC is at
   index *i−1* finalizes index *i−1*. Before the local finality marker advances, the node independently
   re-checks that its tip reached the window head, that its local state root equals the certified one,
   and that every local block body in the window matches the certified per-height hash list. Only then
   does the monotonic ratchet move, under a mutex that also serializes it against rollback.

The RPC reports progress through a `ConfirmationLevel`:

| Level | Meaning |
| --- | --- |
| `Pending` | In the mempool, not yet in a block |
| `InBlock` | 1–4 confirmations deep |
| `QuickConfirmed` | 5–29 confirmations deep |
| `NearFinal` | 30+ deep but not yet covered by a checkpoint QC |
| `FullyFinalized` | Block height at or below the checkpoint-QC finalized height |

Depth alone caps at `NearFinal`. `FullyFinalized` is reported only for heights covered by a
checkpoint quorum certificate.

## Node types

`NodeType` has exactly two variants, `Light` and `Super`.

| | Light | Super |
| --- | --- | --- |
| Storage mode | `StorageMode::Light` — zero chain data on device | `StorageMode::Super` — full history |
| Consensus | Excluded by type, before any reputation check | Producer, checkpoint voter, failover voter |
| Consensus key | None (`vrf_pk` empty in the registry row) | Mandatory 1952-byte ML-DSA-65 `vrf_pk` |
| Archival | Never | Yes |
| Registration | Client-side from the mobile wallet | Server-side by the node itself |
| Devices | At most 3 bound devices | Server or VPS |

A Super node whose registration would carry a `vrf_pk` of the wrong length aborts its registration arm
rather than stamping a keyless row, because the chain-confirmed identity fields are immutable once
written and a keyless identity could never vote, produce or attest.

Five pinned genesis identities (`genesis_node_001`…`genesis_node_005`) carry binary-embedded ML-DSA-65
public keys, are stamped at registration height 0, are exempt from the burn-attestation requirement,
and serve as the committee for the first windows before an on-chain N−2 anchor exists.

A newly registered Super becomes producer-eligible only once its registration is buried by
`ACTIVATION_WARMUP_BLOCKS = 180` blocks, so a fresh joiner syncs as an observer before it can be
elected. Genesis identities are exempt.

Consensus reputation is binary: `INITIAL_REPUTATION = MIN_CONSENSUS_REPUTATION = 70.0`, and the only
transition is to 0 on a cryptographically proven equivocation recorded as a write-once
`banned_at_height` in the account.

Details: [node activation](../economics/node-activation.md), [mobile wallet](../applications/mobile-wallet.md).

## Processes inside a running node

A Super node runs these concurrently; each owns a distinct module.

- **Production loop** (`node/production.rs`) — slot timer, producer election for the current rotation
  round, mempool drain, block signing and broadcast. It re-checks authority immediately before
  mutating state and yields the slot if the certified round advanced or storage already holds the
  height.
- **Block pipeline** (`block_pipeline.rs`) — the staged ingest path, fork choice at contested heights,
  the apply-stage circuit breaker, and fork-recovery signalling.
- **Consensus coordinator** (`consensus_state.rs`) — one async task owning the node's consensus phase
  (`LoadingGenesis`, `Syncing`, `Synchronized`, `Producing`, `Validating`). Every other task sends it
  events — the node reports genesis loaded, blocks applied and sync complete, and the block pipeline and
  sync manager feed it too — over a bounded channel, and reads the phase from an `RwLock` snapshot. One
  writer and many readers means the phase is a single source of truth: the sync target lives in
  `Syncing.target_height`, and whether production and voting are permitted follows from the phase itself
  rather than from a set of independently settable flags.
- **Checkpoint-BFT runtime** (`consensus_v2_node.rs`, `consensus_v2_driver.rs`) — the always-on
  consensus select loop, the view timer, proposal and vote handling, macroblock sealing. Certificate
  verification runs off the loop on blocking workers behind a two-permit semaphore so an
  O(committee) signature verify cannot starve the view-change timer.
- **P2P layer** (`unified_p2p/`, `quic_transport.rs`, `p2p_transport.rs`) — peer registry and
  discovery, block and transaction gossip, timeout-vote collection and re-gossip, and the QUIC
  transport. See [networking](./networking.md).
- **Sync manager** (`sync_manager.rs`) — initial catch-up, desync recovery and post-rollback resync,
  in sequential waves bounded by pipeline backpressure.
- **Storage** (`storage/`) — RocksDB with 30 declared column families, plus an hourly cleanup pass
  that applies the per-artifact retention rules. See [state and storage](./state.md).
- **RPC and WebSocket server** (`rpc/`) — the HTTP API, rate limiting, and event subscriptions. See
  [RPC API](../developers/rpc-api.md).
- **Liveness loops** (`node/lifecycle.rs`) — periodic anchored Heartbeat transactions for Super nodes
  and the light-node eligibility bitmap, both of which feed reward eligibility.
- **Reward machinery** (`reward_epoch.rs`, `reward_sharding.rs`) — epoch roots, shard maintenance and
  the claim path. See [economics](../economics/overview.md).

## Crate map

The Cargo workspace has nine members.

| Crate | Path | Owns |
| --- | --- | --- |
| `qnet-state` | `core/qnet-state` | Account model, `Transaction` and its 20 types, `MicroBlock` / `MacroBlock`, the sparse Merkle state tree, feature gates, WASM apply glue |
| `qnet-consensus` | `core/qnet-consensus` | Checkpoint-BFT types and state machine, quorum and committee math, beacon and epoch commitment, deterministic reputation, lazy reward math, consensus signing |
| `qnet-mempool` | `core/qnet-mempool` | `SimpleMempool` (the one the node uses), priority, validation, eviction, MEV bundle protection, metrics |
| `qnet-vm` | `core/qnet-vm` | Deterministic contract VM on the `wasmi` interpreter, fuel as gas, deploy-time module validation |
| `qnet-core` | `core/qnet-core` | Merkle helpers used by the reward shard tree, security configuration, file encryption |
| `qnet-sharding` | `core/qnet-sharding` | Shard coordinator and parallel validator. Single-shard operation is the shipped configuration: the coordinator is not constructed, so cross-shard routing and the parallel executor are inactive |
| `qnet-integration` | `development/qnet-integration` | The node itself: the `node/`, `unified_p2p/`, `rpc/` and `storage/` modules, `block_pipeline.rs`, the consensus v2 driver and runtime, `sync_manager.rs`, `registry_lthash.rs`, `reward_epoch.rs`, `activation_validation.rs`, `genesis_constants.rs`, and the `qnet-node` binary |
| `qnet-loadtest` | `development/qnet-loadtest` | External harness that drives the production transaction path from outside the validators |
| `qnet-audit` | `audit` | Security and correctness test suite over the core crates |

Inside `qnet-integration` the four largest subsystems are directory modules. `node/` splits into
`lifecycle` (construction, bring-up and background-task wiring), `production` (the microblock
producer loop), `consensus`, `committee`, `leader` (election, rotation, frozen roster),
`registration`, `activation`, `rewards`, `state_apply`, `sync`, `transactions` and `monitoring`.
`unified_p2p/` splits into `transport`, `peer_table`, `peers`, `propagation`, `shred`, `dispatch`,
`queries`, `sync_serve`, `consensus_msgs`, `certificates`, `kademlia` and `background_tasks`. `rpc/`
splits into `tx_api`, `queries_api`, `registration_api`, `light_nodes`, `rewards_api`,
`contracts_api`, `misc_api` and `benchmark`. `storage/` splits into `persistent` (the RocksDB layer
and its column families), `blocks`, `chain_reads`, `snapshots`, `roster`, `registry`, `node_records`,
`reward_store`, `contracts` and `compression`.

Outside the Rust workspace: `applications/qnet-mobile` (the [mobile wallet](../applications/mobile-wallet.md)),
`applications/qnet-wallet` (the [browser extension](../applications/browser-wallet.md)),
`applications/qnet-explorer` (the [explorer](../applications/explorer.md)),
`applications/qnet-cli` (the [command-line tool](../applications/cli.md)),
`development/qnet-sdk` (the TypeScript [SDK](../developers/sdk.md)) and `development/qnet-contracts`
(contract examples and the external burn program, see [smart contracts](../developers/smart-contracts.md)).

## Data flow

**Production path.** Slot timer fires → node derives the leadership round from the height and the
absolute certified failover round → derives the candidate roster and election entropy from macroblock
N−2 (or from the frozen anchor when finality has stalled) → if it is the leader, checks that it holds
the previous block, drains the mempool, applies transactions to a working set, computes merkle and
state roots, re-checks authority, writes the block, and broadcasts it.

**Ingestion path.** Gossip or sync delivers bytes → `Ingest` enqueues → `Decode` parses the block in
whichever stored form it arrives in → `Verify` checks the slot-anchored timestamp, the producer's
authority for the claimed round, the producer signature and the hash chain → `Apply` snapshots state,
applies the block, compares the resulting state root, and either commits or rolls back and signals
fork recovery → `Notify` updates heights and publishes events.

**Finality path.** At a checkpoint boundary the driver proposes or awaits a `Checkpoint` for the
window → a proposal is refused unless its parent quorum certificate is exactly the receiving node's
own `high_qc` → committee members reproduce the window content locally and sign only what they
reproduce → votes accumulate into a quorum certificate → the 2-chain rule finalizes the parent → the
`Finalize` effect re-verifies tip, state root and every body hash → the finality marker ratchets
forward. At a 90-block boundary the quorum certificate builds a macroblock seal that is held until
the 2-chain commit reaches its index; on release every committee member writes the macroblock
locally, and only the proposer broadcasts it.

**Failover path.** When a slot goes unfilled past the grace conditions, validated committee members
broadcast signed timeout votes over a `(window, round, sealed anchor)` tuple. A quorum of same-round
votes forms a timeout certificate, which is the sole input that advances the highest certified round.
Leadership then shifts by that round within the same roster.

**Join path.** A cold or lagging node negotiates a snapshot, restores it into staging column families,
verifies it against the committed roots, promotes it, and then replays the tail through the same block
pipeline that live gossip uses. See [maintenance](../operators/maintenance.md).

## Where to read next

- [Consensus](./consensus.md) — production, rotation, fork choice, failover, finality
- [Cryptography](./cryptography.md) — signatures, hashes, addresses, transport security
- [State and storage](./state.md) — accounts, state commitment, column families, transaction types
- [Networking](./networking.md) — transport, message types, peer discovery
- [Economics](../economics/overview.md) and [node activation](../economics/node-activation.md)
- [Running a node](../operators/running-a-node.md) and [configuration](../operators/configuration.md)
- [RPC API](../developers/rpc-api.md) and [smart contracts](../developers/smart-contracts.md)
