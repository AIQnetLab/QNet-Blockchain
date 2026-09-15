# State and storage

This document specifies how QNet represents chain state: the flat account model, the exact account
leaf preimage the consensus state commitment hashes (a cross-implementation contract mirrored by the
mobile light client), the sparse Merkle tree that produces `state_root`, the per-contract storage
tree, the RocksDB storage engine and its column families, every index the node maintains, the node
registry and its `registry_root` commitment, retention and pruning, and the complete set of
transaction types. Signatures and address derivation are in [cryptography.md](cryptography.md); block
production and finality are in [consensus.md](consensus.md).

## Account model

State is a flat map from address to `Account`. `Address` in the account module is
`pub type Address = String` (`core/qnet-state/src/account.rs`) — a 45-character EON address, not a
fixed-width byte array. The EON address is 19 hex characters, the literal `eon`, 15 hex characters and an 8-hex
SHA3-256 checksum over the body, derived from SHA-512 of the raw 1952-byte ML-DSA-65 public key, so
the address is itself a commitment to the account's signing key. `Account` fields follow in
declaration order, which is also the positional bincode order — appending is the only
backward-compatible change.

| Field | Type | In leaf hash | Purpose |
| --- | --- | --- | --- |
| `address` | `String` | yes | EON address, the map key |
| `balance` | `u64` | yes | nanoQNC (1 QNC = 10^9 nanoQNC) |
| `nonce` | `u64` | yes | replay counter |
| `is_node` | `bool` | yes | set by the `NodeActivation` apply arm and read there to skip a second activation |
| `node_type` | `Option<String>` | no | metadata |
| `reputation` | `f64` | no | excluded: `f64` is not deterministic across platforms |
| `created_at` | `u64` | no | metadata |
| `updated_at` | `u64` | no | metadata |
| `is_contract` | `bool` | yes | true for a deployed contract account |
| `contract_code_hash` | `Option<String>` | conditional | SHA3-256 of the deployed WASM, hex |
| `contract_storage` | `HashMap<String,String>` | via `storage_root` | contract key/value storage |
| `heartbeat_epoch` | `u64` | yes | epoch the current liveness bitmask belongs to |
| `heartbeat_slots` | `u16` | yes | subwindow bitmask for `heartbeat_epoch` |
| `heartbeat_final_epoch` | `u64` | yes | most recently finalized epoch (set on rollover) |
| `heartbeat_final_slots` | `u16` | yes | bitmask for `heartbeat_final_epoch` |
| `last_claimed_epoch` | `u64` | yes | reward-claim anti-replay watermark |
| `storage_root` | `[u8; 32]` | conditional | root of this contract's storage tree |
| `dilithium_public_key` | `Option<Vec<u8>>` | no | raw 1952-byte ML-DSA-65 key cached for signature-key elision |
| `banned_at_height` | `u64` | yes | height at which an equivocation proof banned the identity; 0 = not banned |

`NodeType` has exactly two variants, `Light` and `Super`. `ActivationPhase` has two variants: `Phase1` (external 1DEV burn) and `Phase2` (QNC transferred to
Pool 3, not burned) — see [../economics/node-activation.md](../economics/node-activation.md).

The liveness fields work as follows. The 14,400-block epoch is split into 10 subwindows of 1,440
blocks; a valid on-chain `Heartbeat` transaction sets the bit of its subwindow in `heartbeat_slots`,
reward eligibility is `popcount(heartbeat_slots) >= 9`, and a heartbeat is admitted only within
`HB_ANCHOR_MAX_LAG_BLOCKS = 90` blocks of its declared anchor. The recency test runs at apply, against
the inclusion height: a heartbeat sets its bit when `anchor_height < h` and `h - anchor_height <= 90`,
and otherwise leaves all four fields as they were. `heartbeat_final_epoch` and `heartbeat_final_slots`
preserve the just-completed epoch across the rollover; both are bitmasks rather than counts, so a
heartbeat landing after the roll folds in idempotently and eligibility cannot depend on inclusion
order. The roll is one-way — a heartbeat for an epoch above `heartbeat_epoch` demotes the live mask
into the final pair and starts a fresh one; a heartbeat for the current epoch ORs into
`heartbeat_slots`; a heartbeat for the immediately preceding epoch ORs into `heartbeat_final_slots`.
The 90-block admission window and the one-epoch fold span the same boundary, so every heartbeat that
can still be included is one that can still be counted.

## Account leaf preimage

This is the exact byte sequence hashed with SHA3-256 to produce an account's leaf value. Any
implementation that reconstructs a leaf — the mobile light client included — must reproduce it byte
for byte. Integers are little-endian; strings contribute raw UTF-8 bytes with no length prefix and no
separator beyond the literal tags shown.

```
SHA3_256(
    b"QNET_ACCOUNT_V2:"
 || balance LE u64 || nonce LE u64 || address UTF-8 || [is_contract as u8]
 || if contract_code_hash is Some:  b"CODE:"  || code_hash UTF-8
 || if is_contract:                 b"SROOT:" || storage_root (32 bytes)
 || b"HB:"   || heartbeat_epoch LE u64 || heartbeat_slots LE u16
             || heartbeat_final_epoch LE u64 || heartbeat_final_slots LE u16
 || b"LCE:"  || last_claimed_epoch LE u64
 || b"BAN:"  || banned_at_height   LE u64
 || b"NODE:" || [is_node as u8]
)
```

Rules that follow from the schema:

- The `HB:`, `LCE:`, `BAN:` and `NODE:` sections are unconditional. A verifier that omits
  `last_claimed_epoch`, `banned_at_height`, `is_node` or any of the four heartbeat fields will fail on
  every wallet that has claimed a reward and every node that has ever heartbeated.
- The `SROOT:` branch is conditional on `is_contract` only, never on emptiness of the storage map, so
  a non-contract account's leaf carries no storage component and a native balance proof needs none.
- `reputation`, `node_type`, `created_at` and `updated_at` are deliberately excluded — reputation
  because `f64` is not deterministic across platforms, the rest because no apply path reads them.
- `dilithium_public_key` is deliberately excluded even though it is stored: the address already
  commits to the key (`address == format_eon(SHA512(pk))`), so folding it in would double-commit the
  same fact and force every proof to carry 1952 extra bytes. The stored key is instead self-certified
  by re-deriving the address from it, checked at verification and at snapshot apply.

`StateMerkleTree::hash_account` is the one authoritative implementation.

## State Merkle tree

The consensus state commitment is a binary sparse Merkle tree (`StateMerkleTree`,
`core/qnet-state/src/state.rs`) with its lowest 216 levels collapsed into buckets: the leaves that share
their leading 40 key bits form one bucket, folded as a small Merkle tree of tagged leaves, and only the
40 levels above the bucket layer are hashed as tree levels.

| Parameter | Value |
| --- | --- |
| `TREE_DEPTH` | 256 (full address-hash bit width, so all leaves converge at one fixed depth) |
| `BUCKET_DEPTH` | 216: the bucket layer; it and every depth below it are derived from the leaves and never stored as nodes |
| `PROOF_DEPTH` | `TREE_DEPTH - BUCKET_DEPTH` = 40 hashed tree levels, the fixed tail of every proof |
| `HASH_SIZE` / hash function | 32 bytes, SHA3-256 throughout |
| Leaf position key | `SHA3_256(b"QNET_ADDR:" \|\| address)` |
| Leaf value | the account leaf hash above |
| Bucket leaf | `SHA3_256(0xB5 \|\| leaf key \|\| leaf value)` (`BUCKET_TAG`); the 65-byte preimage cannot collide with a 64-byte internal-node preimage |
| Bucket hash | the bucket's tagged leaves in key order, folded pairwise as `SHA3_256(left \|\| right)` with an odd last element promoted unchanged; a single entry is its tagged leaf, an empty bucket is `default_hashes[216]` |
| Internal node | `SHA3_256(left \|\| right)` |
| Empty subtree at depth *i* | `default_hashes[i]`, the ladder from the all-zero 32-byte hash repeating `SHA3_256(cur \|\| cur)`; `default_hashes[256]` is the empty-tree root |
| Leaf container | `BTreeMap` (deterministic iteration, so the root is identical across nodes) |

Bit order is a cross-language compatibility hazard and is pinned by the mobile verifier:
`level_bit(depth) = TREE_DEPTH - 1 - depth`, so the bucket layer at depth 216 splits on bit 39 of the
key and depth 255 on bit 0, the first; a bucket is every key that shares bits 0..39. Every subtree and
every bucket therefore covers a contiguous key range, which is what makes bounded range reads enough to
classify one.

### Path compression

Compression applies to persistence, not to hashing: the fold always runs all 40 tree levels, and the
bucket layer is derived from the leaves, never stored. `recompute_root` stores an internal node only
when it is a branch or has a live sibling, so the interior of a single-bucket chain is never written.
On read, the hash of a subtree holding one bucket is derived by climbing that bucket's hash against
default siblings (`lonely_chain_hash`), and `subtree_probe` classifies a subtree as empty, one bucket or
two or more buckets with at most two bounded range reads, then reads a lone bucket's entries to hash it. A test asserts fewer
than four stored nodes per leaf.

Two passes produce the root and must agree. `recompute_root` is a full rebuild from the complete leaf
set; while a store is attached it emits the complete non-default node set and sets a wipe flag, so
the flush replaces (never merges) the node set and an evicted node orphaned by a removal cannot
survive. `recompute_levels`, the level-synchronous incremental pass, mirrors the same store rule and
explicitly *deletes* a node that no longer qualifies, because skipping the delete would leave a stale
pre-deletion hash that later folds back into the root. It folds the dirty leaves into their buckets
and climbs each dirty bucket against default siblings for as long as no other bucket shares its
subtree (`first_foreign_depth`), entering the level fold only where paths meet. With both caches
complete (below) and enough work, bucket hashing and the `first_foreign_depth` searches run in
parallel, and the levels below the top `PARTITION_BITS` = 6 fold as 64 independent key-prefix
partitions whose node puts and deletes are applied serially after the join;
`partitioned_tree_fold_matches_full_rebuild` pins that root to a from-scratch rebuild.

A missing branch node is never served as a default: `node_resolve` logs `branch_node_missing` and
rebuilds the subtree in place when it holds at most `REBUILD_SUBTREE_MAX_LEAVES = 4096` leaves,
otherwise setting `incremental_pass_invalid`, whereupon `finalize()` discards the incremental result
and redoes the work as a full `recompute_root` rather than sealing a guessed root. The root is also
stored as a node at `(TREE_DEPTH, all-zero key)` so the next incremental pass can read it back, and
that entry is deleted when the tree returns to the default root. `reset_preserving_store` lands every
queued write-behind job first (`flush_barrier`), then wipes the on-disk leaf set eagerly and panics on
failure — dropping only the in-memory map would leave
`recompute_root`'s `all_leaves()` seed folding the old state into the new root.

The `state_root` in a block is the raw Merkle root returned by `finalize_merkle()`. A restored snapshot is
bound by recomputing that root from the restored accounts (see
[Snapshots, staging and cold join](#snapshots-staging-and-cold-join)).

### Proofs

An inclusion proof is one walk of `(sibling_hash, is_right)` pairs: the path through the key's bucket
first, with positional flags and zero steps for a single-entry bucket, then exactly `PROOF_DEPTH` = 40
tree steps. The fold seeds from the tagged bucket leaf, which binds key and value. `verify_proof`
rejects a proof shorter than 40 or longer than 40 + 64 steps and re-checks each tree step's `is_right`
against the key's bit at that depth, so a proof cannot be re-pointed at another account. An all-zero
leaf value proves absence: the walk must be exactly 40 steps and seeds from the empty-bucket hash, so
absence is provable only while the key's bucket is empty, and the prover returns an empty proof when
it is not. During generation, `first_foreign_depth` binary-searches the depth below which no other
bucket shares the key's subtree, so those siblings are defaults and read nothing from the store. `BalanceProof` carries `address`, `balance`, `nonce`, the four
heartbeat fields, `last_claimed_epoch`, `banned_at_height` and `is_node` — every leaf input a
**non-contract** account needs, since for such an account `is_contract` is false,
`contract_code_hash` is `None` and the `SROOT:` branch is not taken — plus the proof, the
`state_root` it is valid against, and the block height.
`TokenBalanceProof` is a two-level proof: level 1 proves the contract *account* leaf (which carries
`storage_root`) in `state_root`, level 2 proves the `balance:{holder}` leaf in that `storage_root`,
and it carries every field `hash_account` reads for a contract leaf so both levels can be rebuilt.

## Per-contract storage tree

Contract accounts commit their storage through a second tree of the same `StateMerkleTree` type with
different leaf keying and valuing: the storage leaf key is `SHA3_256(b"QNET_STORAGE_KEY:" || key)` and
the storage leaf value is `SHA3_256(b"QNET_STORAGE_VAL:" || raw stored string)` — the raw string, so a
client reproduces it with no width or padding ambiguity (balances are decimal strings).
`compute_storage_root` is a pure, order-independent function of the `contract_storage` map, and
`EMPTY_STORAGE_ROOT` (the root of an empty storage tree) seeds the `Account` constructors.
`contract_storage_root_matches` is the single predicate both snapshot ingest paths use to reject a
contract whose restored storage does not hash to its committed `storage_root`. See
[../developers/smart-contracts.md](../developers/smart-contracts.md).

## Storage engine

Persistence is RocksDB 0.21, opened with `open_cf_descriptors`; a downgrade-safe path unions the
known column-family list with any extra families already on disk, so an older binary can open a newer
database. `StorageMode` has exactly two variants: `Light` (mobile-only pure API client that stores
zero chain data — its on-disk footprint is column-family metadata) and `Super` (complete history).
Microblock body pruning and failover-event writes are gated on `storage_mode == Super`.

### Column families

There are exactly 30, listed in `ALL_CF_NAMES` — the single source of truth for the flush and
compaction sweeps, since RocksDB releases a WAL segment only once every family has flushed past it:
chain data `blocks`, `microblocks`, `transactions`, `metadata`; state `accounts`, `contract_storage`,
`merkle_leaves`, `merkle_nodes`; consensus and liveness `consensus`, `attestations`, `heartbeats`,
`failover_events`, `ping_history`, `light_ping_keys`; rewards `pending_rewards`, `reward_agg`;
registry `node_registry`; indexes `tx_index`, `tx_by_address`, `wallet_token`; sync `sync_state`,
`snapshots`; cold-join staging `accounts_stage`, `node_registry_stage`, `pending_rewards_stage`,
`contract_storage_stage`; and `mempool`, `fcm_tokens`, `cross_shard_pending`, `cross_shard_receipts`.

Families are opened with one of five option profiles: cold (Zstd — `blocks`, `snapshots`), hot (Lz4,
small buffers), generic (Lz4), indexed (Lz4 plus partitioned filters and index), and merkle (Lz4 plus
partitioned). Each sets its own block-based table factory explicitly, because DB-level block options
do not reach a family that declares its own `Options`; all share one 512 MiB LRU block cache.
Each named family compresses with its profile's codec at every level; the DB-level options, which the
default family uses, compress Lz4 with Zstd at the bottommost level. The write path runs four
memtables per family of 16 MiB (hot), 32 MiB (generic, cold, merkle) or 64 MiB (indexed) under one
1 GiB `db_write_buffer_size` budget, with six background jobs and L0 slowdown and stop triggers at 20
and 36 files. Durability settings are `set_use_fsync(true)`, `bytes_per_sync` 1 MiB,
`max_open_files(-1)`, `max_total_wal_size` 512 MiB, `max_log_file_size` 64 MiB, `keep_log_file_num` 10. Key layouts:

| Family | Key | Value |
| --- | --- | --- |
| `accounts` | raw address bytes | bincode-serialized `Account` |
| `contract_storage` | `{contract_address}\x00{storage_key}` | raw value bytes |
| `merkle_leaves` | raw 32-byte address hash | 32-byte account leaf hash |
| `merkle_nodes` | 4-byte big-endian depth ++ 32-byte node key (36 bytes) | 32-byte node hash |
| `metadata` | `chain_height` | 8-byte big-endian height |
| `node_registry` | `node_{node_id}` | JSON registry row |

Every height-keyed metadata key is zero-padded to width 20 so byte order equals numeric order: RocksDB range
operations compare bytes, and an unpadded `microblock_9` sorts after `microblock_100`, which inverts a prune-time
`compact_range`. Width 20 covers all of `u64`, and a test asserts the padded keys sort numerically. One
`WriteBatch` per block carries its transaction and index rows, the body under `microblock_{h:020}` in
`microblocks`, the height-to-hash alias `microblock_hash_{h:020}` holding `MicroBlock::hash()`,
`microblock_fmt_{h:020}` holding the one-byte stored-format discriminator, the block's hash-keyed header
and child link, and `chain_height`, except for the backfill of an already-final slot, which leaves
`chain_height` untouched.

The non-destructive block tree keeps a losing or not-yet-winning block addressable by hash, with no canonical
alias and no chain-height write, so it cannot affect the canonical chain by construction:

| Key | Family | Value |
| --- | --- | --- |
| `block_body_key(hash)` | `microblocks` | the raw stored block bytes |
| `block_header_key(hash)` | `metadata` | `BlockHeaderIdx { height, previous_hash, producer, state_root, timestamp, tx_count }` |
| `chd_` ++ parent_hash ++ child_hash | `metadata` | empty; enumerates the branches leaving a block |
| `brn_{height:020}_` ++ hash | `metadata` | empty; the branch index, so pruning scans retained branches rather than every header |

`children_of` reads siblings by a `chd_` prefix scan — empty for a tip, more than one for a fork this node can see
in full — which is what lets fork choice compare branches instead of deleting one.

The index families `tx_index`, `tx_by_address` and `wallet_token` are keyed as described under
Indexes below. The primary block save path writes an `EfficientMicroBlock` (transaction hashes) into
`microblocks` and the full transaction bodies, Zstd level 3 compressed and lossless, into
`transactions`. Blocks are stored versioned as `StoredMicroBlock` — `V1Full` / `V2Efficient` /
`V3Light` with byte tags `0x01`/`0x02`/`0x03`; tag `0x04` is reserved. WASM contract logs
live *outside* the 30 named families, in the RocksDB default family under `blocklogs_{height:010}`
with a per-block sub-root at `blocklogsroot_{height:010}`.

### Caches, journaling and rollback

The disk-backed merkle node store (`RocksMerkleNodeStore`) is wired unconditionally at node startup
and is the authority from block 0. The in-memory `leaves`
and `intermediate_nodes` maps are bounded read-through caches (`DEFAULT_NODE_CACHE_CAP` = 2,000,000
entries, overridable with `QNET_MERKLE_NODE_CACHE_CAP`); this is consensus-neutral, since the root is
a pure function of the leaf set. While the leaf map
provably holds every live leaf and the node map every stored node (`leaves_complete`,
`node_cache_complete`: cleared when the store is attached and at each eviction, set by a full rebuild),
probes and misses are answered from RAM without a store read, and `finalize` hands its delta to a
dedicated `merkle-flush` thread over a channel bounded at four jobs; with either cache incomplete the
delta is written synchronously. Eviction runs only once every queued job has landed, and a full rebuild
that must read the store waits for the queue first. `StateManager` holds accounts in a DashMap acting as an LRU cache
over the RocksDB-backed `AccountStore`, with a soft `cache_capacity` (`QNET_ACCOUNT_CACHE_CAPACITY`,
default 500,000; 0 disables eviction), and the validator pipeline warms every address a block touches
that is not resident through one `multi_get` over the `accounts` family (`try_load_accounts_batch`).
The `accounts` family has one writer, a dedicated thread fed by one ordered queue: each applied block's
changed rows are queued under the lock that applied it, before the applied height is published, on the
validator path, the producer's inline apply and every verified replay alike, so the family follows the
state in apply order. Journal undos, true-ups, phantom purges and the reconcile write-back go through
the same queue and wait for their rows to land. Eviction is persist-before-evict: victims are written
through `AccountStore::persist_accounts`, which waits for the write, and removed only if it succeeded, so
a value whose row is still queued is never lost — the cache is not the authority, the column family is.
A failed write marks the writer stale until every row it left behind has been written again, by a later
write of the same address or by the periodic heal, which rewrites those addresses from the live state a page
at a time off the apply path; no snapshot is pinned meanwhile. A wholesale replacement (a snapshot promote)
closes the writer: every row queued before the rehydrate has replaced RAM is refused, and applies pause. Two dedup maps are in-RAM DashMaps on `StateManager` rather than their own families:
`committed_epochs` (commitment dedup) and `registered_nodes` (node_id to wallet dedup). After a snapshot
restore — at boot, in a reconcile or on cold join — `registered_nodes` is re-seeded from the durable
`node_registry` family with exactly the nodes whose registration applied at or below the restored state's
height (a registration marker records that height, since a row first stamped by an activation keeps the
earlier `reg_height`; a rolled-back registration's marker says so), so the replay that follows refuses what a from-genesis node refused.

`BlockSnapshot` is a per-block journal recording account pre-images, created-account keys, QRC-20
owns-index deltas, the `(total_supply, last_minted_emission_mb)` pair, the chain height before the block, whether this
apply took the height's fee-credit marker, the committed leaf of any account the block could not read,
and pre-images of the
commitment-dedup and registered-node entries the block writes. `rollback_block` restores chain-level
counters (supply, emission watermark, height), releases the fee-credit marker, restores the dedup
maps, removes created accounts, restores pre-images, applies an O(k) merkle update, which puts a known committed leaf
back for an account the block could not read instead of removing it, and clears the per-contract
storage-tree cache. `should_credit_fees` is a process-global marker set keyed by block
height with a 1000-entry eviction window; `release_credited_fees` restores the invariant when a
height's fee credit is rolled back — without it that height could never be re-applied.
`StateManager` retains the journals of the last `RECENT_JOURNALS` = 16 applied blocks within an
estimated `RECENT_JOURNAL_BYTES` = 96 MiB, kept by the validator path, the producer's inline apply and
the verified replay alike. A shallow reorg undoes `(target, tip]` from them newest first and proves
`finalize_merkle()` against the target block's committed `state_root`; when the target's root is
unavailable, a block was applied after the rollback parked the frontier, the journals do not cover the
range contiguously or the proof fails, the reconcile path (`reconcile_state_after_rollback`) rebuilds
the state instead.

Durable rows written *outside* the accounts map — registry rows, the committed burn binding, public-key
binds and per-height seals — are ordered against a rollback by a claim/drain barrier rather than by the
snapshot. An apply thread calls `try_claim_materialise(height)`, which registers the claim in the
`MATERIALISE_INFLIGHT` counter **before** re-checking whether a rollback bars that height, and declines
when it does. A rollback sets its flag first, so no new claim can succeed, then calls
`drain_materialise_inflight(timeout_ms)` and waits for the counter to reach zero — releasing the worker
through `block_in_place` on a multi-thread runtime, since the apply task it waits on is itself a task —
logging `[WARN][ROLLBACK] materialise_drain_timeout` if the wait expires. Registering the claim before the
re-check is what makes the pair race-free: a claim taken after the flag writes nothing, and one taken
before it lands ahead of the rollback's prune scans and is pruned as the orphan it is. Two further flags
bar the apply path in the same way: `ROLLBACK_IN_PROGRESS` with `ROLLBACK_TARGET_HEIGHT` and a
`ROLLBACK_TIMEOUT_SECS = 60` watchdog counted from the rollback's last recorded progress
(`note_rollback_progress`), and `SNAPSHOT_REHYDRATE_IN_PROGRESS`, held while the in-memory state
is being repopulated from the promoted snapshot family so no tail block is applied over un-rehydrated
state. A verified regression below finality, whether a coordinated recovery decree or a wholesale restore
proven against the QC-bound anchor, takes the same slot, target and drain through `claim_rollback_slot`,
without the finality check. The operator rollback at boot and the recovery decree retract every durable
marker that still names chain above the target through one function,
`Storage::retract_chain_position_above`: macroblock objects and the epoch roots they certify,
certified pairs by the window they certify, the seal watermark and latest-macroblock hash, the QC-strip
cursor, the consensus round, timeout certificates and the sync resume point among them.

## Indexes

| Index | Location | Purpose |
| --- | --- | --- |
| `tx_index` | own family, `tx_{hash}` | O(1) transaction hash to height. A miss is an authoritative not-found. |
| `tx_by_address` | own family, `addr_{address}_{height:016x}_{tx_hash}` | per-address history. The sender is always indexed; the recipient is indexed when `to` is `Some`. The efficient-microblock writer falls back to `tx.from` for a `to`-less transaction, which reproduces the sender key exactly, so no duplicate row results. Keys are stamped with the inclusion *height*, never the author-supplied `tx.timestamp`, so retention cuts on a field no author controls. |
| Token transfers | `tx_by_address` family, prefixes `xfer_{height:016x}_{log_index:08x}` (canonical row), `xfeadr_…` (address pointers), `xfectr_…` (contract pointers) | success-gated QRC-20/721 transfer feed; off-consensus and idempotent per `(height, log_index)`. |
| `wallet_token` | own family, `owns\|{wallet}\|{contract}` | non-consensus wallet-to-token reverse index, maintained from 0↔nonzero QRC-20 balance transitions. `OWNS_INDEX_READY` gates whether an empty result may be trusted instead of falling back to a full scan. |
| Roster indexes | `node_registry` family, `srtr_` / `lrtr_` prefixes | node rosters; see below. |
| Heartbeat liveness | `node_registry` family, `lhb_{subwindow:010}_{node_id}` | first inclusion height of a `Heartbeat` anchored in that subwindow, 8-byte big-endian; see below. |
| Registered API endpoint | `node_registry` family, `api_{node_id}` | the endpoint a chain-confirmed super registered with, read once from the `NodeRegistration` in its registration block and indexed, empty when it registered without one; a boot task backfills missing rows, and the public-node list is served from it. A side index, not a `registry_root` input. |
| Committed burn binding | `metadata` family, `cbw_{burn_tx}` | the node id a 1DEV burn is bound to on-chain. First-wins and immutable, read at block validation so a second registration cannot reuse the same burn under another identity. See [../economics/node-activation.md](../economics/node-activation.md). |
| Reward shards | `epoch_wshard_` / `epoch_shardmeta_` keys | sharded leaf-set cache for epoch reward roots; separately prunable. |

Wallet-to-node lookup is resolved by deriving the node id from the wallet and point-reading
`node_{id}`, so no mutable per-node slot can diverge across apply and gossip ordering.

The heartbeat index replaces a block-body scan, and its answer feeds `eligible_producers` and from there
the QC-signed `epoch_commitment`, so it is written and read under strict rules. The apply path writes a row
only when the heartbeat's anchor is strictly in the past and within `HB_ANCHOR_MAX_LAG` of the inclusion
height — the same freshness rule the reward bit enforces, applied at the single writer so the
producer-inline and peer-apply callers cannot drift apart. The write is first-wins, so the value is the
minimum inclusion height and a reader bounded by a scan end reproduces the body scan exactly. Pruning runs
once per subwindow advance as one range-delete below `sw - LHB_RETAINED_SUBWINDOWS`, with the watermark
written to the metadata key `lhb_pb` in the same batch; retention (`LHB_RETAINED_SUBWINDOWS`) is the
roster-derivation horizon in subwindows plus the reader's own current-and-previous span and one
subwindow for the boundary, so the answer is a function of the height
alone rather than of how deep this node's seal is. The reader fails closed: if either needed subwindow sits
at or below the watermark it returns `lhb_index_pruned` and the caller abstains and syncs instead of
deriving a partial roster. At every height reset (boot, snapshot apply, rollback)
`rebuild_registry_lthash` runs `canonicalize_heartbeat_index`, which drops rows included above the new
tip, re-indexes the retained subwindows from the stored bodies and lowers `lhb_pb` to the subwindow from
which those bodies run complete (a watermark already lower stays), so after the tip moves down readers
fail closed only below the subwindows the stored bodies cover.

## Node registry and registry_root

The forward row is `node_{node_id}` in the `node_registry` family, holding JSON with `node_type`,
`wallet`, `reputation`, `timestamp`, `reg_height`, `burn`, `vrf_pk_sha3` and `reg_index`. Two roster
index prefixes live in the same family and are written in the **same** `WriteBatch` as the forward
row, so they are atomic with it: `srtr_{node_id}` for ids beginning `super_` or `genesis_node_`, and
`lrtr_{node_id}` when `node_type == "light"`. The two predicates are independent — one keys on the id
prefix, the other on the type — matching two independent readers. Both values are `reg_height`
(8-byte big-endian) ++ `reg_index` (4-byte big-endian) ++ wallet. The chain-confirmed identity fields
`wallet`, `reg_height`, `burn`, `node_type` and `vrf_pk_sha3` are immutable once stamped by a chain
apply, and `reg_index` changes only when a height reset re-ranks the surviving rows (below); an RPC or discovery-cache write (which passes `reg_height` as `None`) preserves them
and never touches the accumulator below. A light row carries `vrf_pk_sha3` from
`LIGHT_KEY_COMMITMENT_GATE_HEIGHT` = 691,200: the SHA3-256 digest of the wallet key in the
registration's envelope, the key its device's attestation delegation is checked against; a light row
stamped below that height carries none.

The consensus key itself lives in its own row of the same family: `vrf_pk_{node_id}`, holding the raw
1952-byte ML-DSA-65 key hex-encoded, while the `node_` row carries only the `vrf_pk_sha3` digest. This row
is the durable consensus trust root. Checkpoint vote and QC verification and burn-attestor key resolution
read it through `committed_signer_pk`: when the `node_` row carries a `vrf_pk_sha3` commitment, the row
counts only if it hashes to that digest, then a RAM copy that does (written into the row when the row is
absent), then the binary-pinned genesis anchor; with no commitment, the row, then the anchor.
Producer-signature verification reads RAM, then the row, then the anchor, and `load_all_vrf_public_keys`
re-imports the whole `vrf_pk_` prefix at boot. It is therefore
write-once for every identity, not only for anchored genesis ones: re-writing the same bytes is idempotent,
while a differing value is refused with `[ERR][STORAGE] vrf_pk_rebind_refused` and nothing is written, which
is what stops a second registration naming an existing node id from silently taking the identity over. An
incoming key that does not byte-match a pinned genesis anchor is refused earlier still, as
`genesis_vrf_pk_overwrite_refused`. `registry_root` deliberately does not hash this key: the row is not
co-resident with the `srtr_` row it would be folded beside, so hashing it would split the digest per node.

`reg_index` is the node's permanent ordinal, drawn from `INDEX_SPACES` = 6 independent monotone
counters: space 0 for super and genesis identities, spaces 1..=5 for light shards 0..4, where the
light shard is a pure function of the immutable node id. The counters live under the metadata key
`registry_next_index` as six big-endian `u32`s, read-modify-written inside the registration batch. An
ordinal is meaningful only inside its own space; ranking per space keeps a light shard's eligibility
bitmap span proportional to that shard rather than to the whole registry. At every height reset
`rebuild_registry_lthash` prunes rows registered above the new height and re-ranks the survivors of
each space in canonical `(reg_height, node_id)` order, rewriting any `reg_index` that differs, so a
pruned orphan leaves no gap in the numbering; on a chain this node never reorged the ranks equal the
stamped values, because a block's rows are stamped in `node_id` order.

`registry_root` is an **LtHash multiset hash**, not a Merkle root:

```
registry_root = SHA3_256(b"qnet-registry-root-v2" || 2048-byte LtHash state)
row lanes     = SHAKE256(seed) split into LANES = 1024 little-endian u16 lanes
seed          = SHA3_256(b"qnet-registry-row-v4"
                  || len-prefixed node_id, wallet
                  || reg_height LE || reg_index LE
                  || len-prefixed node_type, burn, vrf_pk_sha3)
```

`add` and `remove` are component-wise wrapping add and subtract over the 1024 sixteen-bit lanes
(`STATE_BYTES` = 2048), making the accumulator order-independent and exactly reversible, so
maintenance is O(1) per registration instead of an O(N) recompute per checkpoint. Every row field
is length-prefixed and the domain tag is versioned: adding a field to a registry row is a breaking
change for every light client. The preimage is pinned by a Rust test asserting
`a3b7cbb3aa2e3a4829e98569c2e6bc63ba4a1480c09845fc5525c511b9c4b30a`, mirrored verbatim by a mobile
Jest test, so a divergence surfaces in the commit that causes it.

The running accumulator lives under the metadata key `registry_lt_state`, updated as
`add(new row) - remove(prior row)` inside the same `WriteBatch` as the `node_` put, so row and
accumulator cannot disagree across a crash. Per-checkpoint seals `rr_seal_{height BE}` give an O(1)
read; a missing seal falls back to a from-scratch scan of the `srtr_` and `lrtr_` prefixes (deduped by
node id), correct at any height. That recompute **fails closed** — it returns `None` on a missing
family or a mid-scan iterator error, because a partial scan would publish a different commitment
rather than a smaller registry. `dilithium_pk_root` uses the same primitive over per-account
(address → ML-DSA-65 public key) bindings, seeded by
`SHA3_256(b"qnet-dpk-row-v1" || len-prefixed address, pk)`, with accumulator key `dpk_lt_state` and
seals `dpkr_seal_{height}`; its scan folds only accounts whose `dilithium_public_key` is exactly 1952
bytes and likewise fails closed.

## Snapshots, staging and cold join

Cold-join ingest uses four parallel staging families (`accounts_stage`, `node_registry_stage`,
`pending_rewards_stage`, `contract_storage_stage`): a downloaded snapshot is restored there, verified,
and only then promoted, so a rejected snapshot leaves no orphaned live state.
`recompute_account_merkle_root_cf` rebuilds the account merkle root by streaming either `accounts` or
`accounts_stage` into a fresh `StateMerkleTree`, and `restore_accounts_streamed` applies the same
per-account `storage_root` check; both reject a contract whose restored storage does not hash to its
committed root. P2P cold join and local restart both read the stored frames described below.

### Taking and storing a snapshot

At a snapshot boundary the node that applied the block queues a pin of the database right behind the
block's account rows. The pin is a RocksDB snapshot taken on the writer thread, so it holds exactly the
state at that height, and producing or applying the next block never waits for it. One background thread
encodes the frame from the pinned view, `[sha3(32) | uncompressed_len(8) | zstd([0x02 | format(4) |
height(8) | timestamp(8) | accounts | REWARDS_V1 … | CONTRACT_STORAGE_V1 … | NODE_REGISTRY_V1 …])]`, and
drops it when the pinned accounts differ from the committed leaf count, or when a snapshot prune or another
block at that height arrived after the pin. The frame leaves out node-local rows a joiner never takes: the
light-eligibility index and the claim-serving reward shard cache, which differed between holders of one
height. `SNAPSHOT_FORMAT_VERSION` = 2; readers take formats 1 and 2 alike.

A frame is stored as 4 MiB chunk rows `snap_chunk_{height:020}_{i:06}` beside its manifest (per-chunk
SHA3-256) `snap_manifest_{height:020}` and an index row `snap_idx_{height:020}`. The index row and the
manifest land in the batch that completes the frame, so a frame exists exactly when its index row does.
The encoder writes chunks as they fill, so neither the uncompressed payload nor the compressed frame is
ever held whole. Retention, discovery and every height lookup read index rows only; serving the manifest
reads its row, serving a chunk reads the index row and the chunk row; readers stream the chunks from a pinned view and check the stream hash and
length at the end. A frame whose write stopped halfway leaves a `snap_wip_` marker the boot pass uses to
drop its rows; the same pass splits a single-value `full_snap_{height}` frame of an earlier build into
chunk rows and keeps the value until retention retires the frame, so that build can still restore from a
converted frame. It cannot read a frame written as chunk rows: after a binary rollback it advertises heights
it cannot serve and the chunk rows sit unused until this build returns. The format has no gate because the
wire bytes and the manifest protocol are unchanged. The chunked download writes each chunk as it passes its
manifest hash; the one-body and IPFS downloads write rows as the body arrives and check the header hash at
the end; memory holds a few chunks, never the frame. One height claim covers the held-frame check and every
fetch, and a frame that does not load is dropped, so the next attempt fetches afresh. A live fork rollback
and every lowered tip drop the frames above the new tip.

### Cadence and who holds a snapshot

| Constant | Value | Meaning |
| --- | --- | --- |
| `SNAPSHOT_FULL_INTERVAL` | 43,200 blocks (12 hours) | the frames that also go to IPFS when `IPFS_ENABLED=1` |
| `SNAPSHOT_INCREMENTAL_INTERVAL` | 3,600 blocks (1 hour, 40 macroblocks) | boundary snapshot cadence (every frame holds the whole state), and the holder-rotation period |
| `SNAPSHOT_EARLY_ANCHOR_HEIGHT` | 90 | the first consensus-bindable boundary, so a young chain has a servable snapshot long before the hourly interval |

Materialising a snapshot is sampled, so storage and CPU stay proportional to the network rather than to
every node holding every snapshot. `should_materialize_snapshot(node_id, height)` returns true for every
node at height 90, and true for every node while the mirrored active-node count is at or below 50 — a count
of 0 means unknown and also holds, so a read gap can never leave nobody holding. Above that threshold the
holder set is a deterministic one-in-five sample:
`SHA3-256("QNET_SNAP_HOLDER_V1:" || node_id || (height / SNAPSHOT_INCREMENTAL_INTERVAL) LE)[..8] % 5 == 0`,
which rotates the sample each interval. Holders advertise the snapshots they carry and joiners discover
them by peer fan-out.

### Rooting the join

A joining node roots its verification in the genesis-anchored live checkpoint rather than in the data the
snapshot server hands it. The capsule is a quorum-signed `(macroblock index, hash, committee digests)` tuple
verified against the genesis public keys embedded in the binary, and its index is the newest finalized
macroblock rounded to a multiple of 40 — deliberately the same 3,600-block grid the boundary snapshots
sit on, so the joiner's snapshot anchor is the capsule root and the lineage walk from root to anchor is
short at any chain age. The walk re-verifies the macroblock quorum certificates upward from that root;
only then does `adopt_snapshot_finality` promote the anchor to the local finality and weak-subjectivity
floor. See [consensus.md](consensus.md#the-genesis-anchored-live-checkpoint).

## Retention and pruning

Retention is set per artifact. All pruning is explicit `delete` /
`delete_range` calls plus range compaction.

| Artifact | Retention | Notes |
| --- | --- | --- |
| `transactions`, `tx_index`, `tx_by_address` | `TX_INDEX_RETENTION_BLOCKS` = 100,000 blocks | hourly pass prunes below `current_height - 100000` |
| Microblock bodies | `MICROBLOCK_BODY_RETENTION_BLOCKS` = 6 × 14,400 = 86,400 blocks | Super nodes only; block 0 is never pruned |
| Macroblock committee signatures | `QC_SIG_RETENTION_MB` = `SNAPSHOT_MAX_WS_WALK_MB` (13,440) + 1,440 = 14,880 macroblocks | the `sigs` list is the bulk of a macroblock; the checkpoint, the `signers` list and `sig_merkle_root` are kept, so the removed set stays committed |
| Registry and total-supply seals | `REGISTRY_SEAL_RETENTION` = 14,400 blocks | a missed seal falls back to the from-scratch recompute |
| Snapshots | newest `SNAPSHOT_KEEP_COUNT` = 3, plus the height-90 anchor | applied after every frame written and in the hourly pass; reads index rows only |
| Consensus rounds | last 1,000 | |
| Failover events | 24-hour timestamp cutoff, and bounded to 10,000 rows | |

Committee signatures are read only by `verify_v2_macroblock` at ingest and by the cold-join and
light-client lineage walks, both of which are budgeted by `SNAPSHOT_MAX_WS_WALK_MB`; every reader of a
stored macroblock takes the checkpoint half. `strip_macroblock_qc_sigs` therefore sweeps forward from a
`qc_sig_strip_cursor` in the metadata family, bounded per run, re-storing each macroblock in the same
framing it was found in and leaving an undecodable row exactly as found. The sweep is fork-free by
construction: `MacroBlock::hash()` excludes `consensus_data`, and `sig_merkle_root` still commits the
signature set. See [mobile wallet](../applications/mobile-wallet.md) for the light-client walk this
budget sizes.

Microblock body pruning keeps macroblocks, the `microblock_hash_{h}` height-to-hash alias, snapshots
and account state, so chain continuity remains a point lookup afterwards. Each run resumes from a
`body_prune_watermark` key in the metadata family and co-prunes each pruned block's `chd_` child link and
hash-keyed header plus the off-consensus `blocklogs_` and `blocklogsroot_` rows in the same window, and
the token-transfer rows below the same floor; retained branch blocks leave through the `brn_` index when
finality passes their height (`prune_branches_below_finality`); `log_prune_floor()` exposes that watermark so `getLogs` can report `pruned_below`,
distinguishing an aged-out height from a block that genuinely emitted no events. A compile-time
assertion enforces that `MICROBLOCK_BODY_RETENTION_BLOCKS` exceeds both `SNAPSHOT_SYNC_SWITCH_GAP`
(1,500) and `SNAPSHOT_KEEP_COUNT × SNAPSHOT_INCREMENTAL_INTERVAL` (3 × 3,600), so a cold or lagging
node can never need a pruned body — changing those constants is a compile error, not a silent sync
break. `prune_epoch_reward_shards` range-deletes only the sharded leaf-set cache
(`epoch_wshard_` / `epoch_shardmeta_`), leaving `epoch_root_`, `super_elig_` and `light_bm_` intact so
a pruned epoch's claim path still works. Compaction is selective: only families with at least
`COMPACT_MIN_ROWS` = 1,000 rows deleted are compacted, so a family holding no tombstones is not
rewritten.

## Transaction types

`TransactionType` has exactly 20 variants. Five are named by `is_retired_type` and rejected by
`validate()` immediately after the structural `enforce_wire_limits` check and before every semantic
check, so the RPC ingress, the gossip ingress and block packing all share one rule.
They remain in the enum so stored block bodies decode. Separately, the RPC
and gossip ingress whitelists in `node/transactions.rs` reject two further non-retired types,
`CreateAccount` and `Swap`, so those never reach the mempool either, and bound `BatchTransfers` to 1 to
1,000 transfers, each with a non-zero amount and a memo of at most 128 bytes.

| Variant | Status | Description |
| --- | --- | --- |
| `Transfer` | live | move QNC between two accounts |
| `EquivocationProof` | live | proof that a producer signed two different microblocks at the same height; verified on-chain against the offender's registry key and applied in the reputation fold (ban, no balance effect) |
| `VoteEquivocationProof` | live | proof of a same-round double checkpoint vote; carries both full checkpoint preimages because the vote signature covers only the checkpoint hash |
| `Swap` | dormant | token swap through a DEX contract. Rejected at both the RPC and the gossip ingress because no on-chain pool pricing is deployed; block apply is fail-closed as defence in depth |
| `NodeActivation` | live | activate a node; Phase 1 carries amount 0 (1DEV burned externally), Phase 2 transfers QNC to Pool 3 |
| `ContractDeploy` | live | deploy a WASM contract; unit variant, with the deploy metadata (including `code_hash`) carried as JSON in the transaction `data` field |
| `ContractCall` | live | invoke a deployed contract; unit variant, call payload in `data` |
| `RewardDistribution` | live | credit a reward to an account |
| `NodeRegistration` | live | on-chain binding of node_id to wallet; carries the consensus key `vrf_pk` inside the hashed body and the Phase-1 burn attestation quorum |
| `CreateAccount` | live, internal only | create an account with an initial balance. Constructed only by `genesis::create_genesis_block` and applied through block apply; rejected at both the RPC and the gossip ingress |
| `BatchRewardClaims` | retired | never instantiated; individual `RewardDistribution` transactions are used instead |
| `BatchNodeActivations` | retired | no route and no handler |
| `BatchTransfers` | live | multi-recipient transfer under one ML-DSA-65 signature: 1 to 1,000 transfers, each with a non-zero amount and a memo of at most 128 bytes. `validate()` requires `gas_limit` to cover `gas_limits::TRANSFER` (10,000) per transfer; the sender prepays the effective gas price × `gas_limit` once for the batch, and the gas-metering refund returns the price of the gas above `TRANSFER` × the transfer count |
| `PingAttestation` | retired | per-ping on-chain attestation |
| `PingCommitmentWithSampling` | retired | windowed ping merkle commitment with sampled proofs |
| `HeartbeatCommitment` | retired | self-attested per-epoch liveness commitment, replaced by `Heartbeat` |
| `Heartbeat` | live | one liveness transaction per subwindow, bound to a recent canonical block hash so it can be neither pre-signed nor backfilled |
| `LightNodeEligibilityBitmap` | live | one shard owner's compressed bitmap of the shard's eligible light nodes for an epoch, indexed by `reg_index`; each owner's bitmap is stored as its own row and the rows are bit-ORed at read, so no owner can clear a bit another set |
| `NodeReactivation` | live | returning node signals it is back online and synced, and republishes the API endpoint carried in its signed body: a non-empty value refreshes the committed endpoint at apply. Free system transaction, deduplicated per macroblock epoch |
| `KeyRotation` | dormant | rotate a node's ML-DSA-65 key. The shared system-transaction gate below rejects it on the RPC, gossip and block-validity paths alike, so a node's consensus key is the one stamped at registration for the life of the identity |

Post-quantum signing is mandatory network-wide. The `dilithium_public_key` account field is the
key-elision cache, bound once at the account's first on-chain transaction.

A block of 32 or more transactions that are all `Transfer` or `BatchTransfers` applies through
`apply_transfers_parallel` on the producer and the validator alike: each sender's transactions run in
order against that sender's pre-block state, senders in parallel, and every credit lands after all
debits as a per-recipient sum, so a credit received in such a block is not spendable within it. Each
verdict is a function of the sender's pre-block state and transaction order, and the path choice a
function of block content, so the resulting root does not depend on scheduling.

### Transaction envelope and hashing

`Transaction.dilithium_signature` is raw detached ML-DSA-65 bytes (3309) with no hex, base64 or
envelope wrapper; `Transaction.dilithium_public_key` is the elidable raw 1952-byte key, present only
on an address's first on-chain transaction. The hash preimage (`canonical_bytes`) is the bincode
encoding of the transaction with `hash`, `signature` and `dilithium_signature` cleared and
`dilithium_public_key` set to `None`, so an elided transaction hashes identically to its first-use
form; `calculate_hash` is SHA3-256 over those bytes, hex-encoded.

`enforce_wire_limits` imposes structural ceilings on every free-form field (address 128 bytes, data
262,144, signature 16,384, public key 4,096) plus per-variant limits, and runs on the block-validation
path because `validate()` does not run it there; `NodeRegistration.vrf_pk` must be empty (Light) or
exactly 1952 bytes. The one Ed25519 verification on the state path is the external burn-owner
signature over `burn_owner_bind_message`, made with a Solana burner key that is outside QNet identity.

Both block hashes bind `state_root`: `MicroBlock::hash` binds height, timestamp, previous hash, merkle
root, producer, `timeout_round`, carried baseline and `state_root` (not `fees_collected`, not
`vrf_output`), with `EfficientMicroBlock::hash` a byte-identical mirror; `MacroBlock::hash` covers
height, timestamp, previous hash, `state_root` and every included microblock hash, excluding
`consensus_data`. A microblock is rejected above 50,000 transactions, and `verify_v2_macroblock`
rejects a macroblock whose window is not exactly 90 microblock hashes.

### The shared system-transaction gate

Node-signed system transactions carry an extra identity binding, enforced by `verify_system_tx_binds` —
one function shared by the RPC ingress, the gossip ingress and block validity, so all three reach the same
verdict and a transaction it rejects can be neither admitted, gossiped nor block-included. It is a pure
function of the transaction bytes and a height (block validity passes the block's height, the two
ingress doors the local height) and reads no node-local or gossip-seeded state, which is what makes the
block verdict byte-identical on every node and therefore safe on the apply path.

| Type | Binding |
| --- | --- |
| `PingCommitmentWithSampling`, `LightNodeEligibilityBitmap`, `HeartbeatCommitment`, `Heartbeat`, `NodeReactivation` | a non-empty ML-DSA-65 signature is mandatory — it is the sole authenticator |
| `LightNodeEligibilityBitmap` | the declared `genesis_id` names the shard and the signer must own it: from `LIGHT_SHARD_BACKUP_OWNERS_GATE_HEIGHT` = 691,200 the shard's own genesis or one of its two backups, the next two genesis nodes in ring order (`light_shard_owners`); below it the shard's own genesis only |
| `PingCommitmentWithSampling` | the signer equals `tx.from`, matching the field apply deduplicates on |
| `Heartbeat` | `tx.from`, the declared `node_id` and the signer are all equal, so liveness credited on `from` is the liveness the signature attests to |
| `NodeReactivation` | `tx.from` equals the declared `node_id`, because apply writes the endpoint registry under `node_id` while the signature preimage is built from `from` |
| `KeyRotation` | rejected, as described in the type table above |

`NodeRegistration` and `NodeActivation` are outside this gate by design: they carry their own
authenticators — a Solana owner signature for an imported wallet, whose address does not derive from the
node's ML-DSA-65 key — and their Sybil anchor is the deterministic burn-attestation quorum rather than a
signature-presence check. See [../economics/node-activation.md](../economics/node-activation.md).

## Related documents

- [consensus.md](consensus.md) — production, rotation, finality, failover
- [cryptography.md](cryptography.md) — signatures, hashes, address derivation, transport
- [networking.md](networking.md) — P2P transport and message types
- [../economics/overview.md](../economics/overview.md) — emission, rewards, claims, fees
- [../economics/node-activation.md](../economics/node-activation.md) — activation and registration
- [../developers/rpc-api.md](../developers/rpc-api.md) — the HTTP/RPC surface over this state
- [../developers/smart-contracts.md](../developers/smart-contracts.md) — WASM contracts and tokens
- [../operators/configuration.md](../operators/configuration.md) — environment variables, cache caps
