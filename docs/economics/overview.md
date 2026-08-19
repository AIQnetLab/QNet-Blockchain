# Economics overview

This document describes the native QNC token, the emission schedule, reward epochs and eligibility, how each epoch's distribution is computed and certified, the reward pool account and the conservation invariant it enforces, the pull-based claim flow, and transaction fees. Node activation payments are covered in [node-activation.md](node-activation.md); the external Phase 1 token is covered in [tokenomics-1dev.md](tokenomics-1dev.md).

## The native token

QNC is the chain's only native asset. All protocol arithmetic is in nanoQNC, the smallest unit.

| Name | Value | Defined in |
| --- | --- | --- |
| `QNC_DECIMALS` | 9 | `core/qnet-state/src/transaction.rs` |
| `NANO_PER_QNC` | 1_000_000_000 | `core/qnet-state/src/transaction.rs` |
| `MAX_QNC_SUPPLY` | 4_294_967_296 QNC (2^32) | `core/qnet-state/src/state.rs` |
| `MAX_QNC_SUPPLY_NANO` | `MAX_QNC_SUPPLY * 1_000_000_000` | `core/qnet-state/src/state.rs` |

Genesis sets `chain_state.total_supply = 0`. The only statement anywhere in the workspace that increases `total_supply` is inside `StateManager::emit_rewards`; every other assignment to that field is a snapshot restore or a reset.

The genesis block carries exactly two `CreateAccount` transactions, applied through the ordinary block-apply pipeline so every node materialises the same state at height 0:

| Account | Initial balance | Role |
| --- | --- | --- |
| `genesis` | the sum of the configured distribution set | source account for genesis distributions |
| `system_rewards_pool` | 0 | the reward pool every emission credits and every claim debits |

On a production genesis the distribution set is empty, so `genesis` is created with a zero balance, no transfer transactions follow the two account creations, and every QNC that ever exists is minted later by the emission schedule. A benchmark or load-test genesis populates the set from `QNET_BENCHMARK_MODE` or the `QNET_LOADTEST_ACCOUNTS` / `QNET_LOADTEST_ALLOW` pair, sizing the `genesis` account to their total and emitting one `Transfer` per prefunded address; those balances are written by `CreateAccount`, which does not touch `total_supply`, so a chain started that way reports a supply figure that excludes them. Both mechanisms are development-and-test only — see [configuration.md](../operators/configuration.md).

`CANONICAL_BURN_ADDR` (`0000000000000000000eon00000000000000036877022`) is a well-known unspendable EON address: its body is all zeros with a valid checksum, and no public key hashes to it. Native QNC sent there accumulates unspendably. Circulating supply is reported off-consensus as `total_supply` minus the balance of that address; the subtraction is a reporting convenience and is not a consensus quantity.

## Emission schedule

Emission is a pure function of block height. `qnet_consensus::lazy_rewards::pool1_base_emission_at_height(height)` computes

```
years          = height * EMISSION_SLOT_SECS / EMISSION_SECS_PER_YEAR
halving_cycles = years / 4
```

and then evaluates `pool1_base_emission_for_cycles(halving_cycles)` over a fixed base.

| Name | Value |
| --- | --- |
| `BASE_EMISSION_NANO` | 251_432_340_000_000 nanoQNC (251,432.34 QNC) |
| `EMISSION_SLOT_SECS` | 1 (seconds of chain time per microblock slot) |
| `EMISSION_SECS_PER_YEAR` | `365 * 24 * 60 * 60` = 31,536,000 |
| Halving cycle length | 4 emission-years |

The curve has four branches, evaluated in this order:

| Condition | Emission per event |
| --- | --- |
| `halving_cycles >= 50` | 0 |
| `halving_cycles == 5` | `BASE / 160` — the sharp drop: four halvings (÷16) followed by an extra ÷10 |
| `halving_cycles > 5` | `BASE / (160 * 2^(cycles-5))`, shift exponent clamped to 63 |
| `halving_cycles <= 4` | `BASE / 2^cycles` |

The sharp drop is a one-time additional ÷10 applied at cycle 5 (approximately year 20 of chain time); normal halving resumes from that lower base afterwards.

Deriving the cycle from height rather than from the wall clock is deliberate: block timestamps are slot-anchored (`block_ts = genesis_ts + height * SLOT`), so height is an exact node-independent measure of elapsed chain time. Reading the local clock would make the minted amount depend on each node's clock and split the network across a halving boundary. Producer and validator both call the same function, so the emission amount is verified rather than asserted.

## Emission events

| Name | Value | Defined in |
| --- | --- | --- |
| `EMISSION_BLOCK_INTERVAL` | 14_400 microblocks (4 hours of chain time) | `development/qnet-integration/src/reward_epoch.rs` |
| `MACROBLOCK_INTERVAL` | 90 microblocks | `core/qnet-consensus/src/checkpoint_bft.rs` |
| `MB_PER_EPOCH` | `EMISSION_BLOCK_INTERVAL / MACROBLOCK_INTERVAL` = 160 | `development/qnet-integration/src/reward_epoch.rs` |

`expected_emission_amount(height)` is the single rule every node applies. An emission is due only when all of the following hold:

- `height % 14_400 == 0` and `height != 0`;
- `height / 14_400 > 1` — the first two epochs mint nothing, because the rewarded epoch's macroblock must already be finalized;
- the schedule at that height is non-zero. A scheduled amount of zero is reported as `NoneDue`, not `Exact(0)`, so producer, validator and the checkpoint recompute all agree that no emission transaction must be present once the curve floors to zero.

The function performs no storage read, so a freshly synced node and a long-running node reach the same verdict.

Emission is delayed by two epochs: an emission at height `h` rewards the epoch keyed `emission_mb_index(h) = (h/14400 - 1) * 160`, computed only when `h/14400 >= 2`.

The producer builds one emission transaction per emission block:

| Field | Value |
| --- | --- |
| `tx_type` | `RewardDistribution` |
| `from` | `system_emission` |
| `to` | `system_rewards_pool` |
| `amount` | `pool1_base_emission_at_height(next_block_height)` |
| `gas_price` / `gas_limit` | `u64::MAX` / 0 (ordered first in the block; pays no fee) |
| `data` | JSON `{"v":3, "epoch", "root", "per_node", "count", "total"}` |

`select_emission_at` accepts a block's emission transaction only if the type, the `system_emission` sender, the height-derived amount and a `{"v":3}` payload all match. Duplicates are last-wins. The amount is never read from the transaction body — it is re-derived by every node — and the v3 payload is required because accepting on type and amount alone would let a producer mint a full epoch while leaving `reward_root` zero, which reads as "this epoch distributed nothing" and would make the epoch permanently unclaimable. A `RewardDistribution` from `system_emission` arriving over P2P gossip is rejected; it is a block-level transaction only. Effect is bounded by derivation rather than by ingress: `select_emission_at` reads the block's own transaction list, and only a transaction whose amount equals the height-derived schedule and whose payload is `{"v":3}` is treated as that block's emission.

Apply Phase 1 mints through `state.emit_rewards(amount, emission_mb)` and then credits `system_rewards_pool` with the value that was **actually** minted. `emit_rewards` is watermark-idempotent (for any `emission_mb > 0` it returns 0 when `emission_mb <= chain_state.last_minted_emission_mb`; `emission_mb == 0` falls outside the watermark entirely and is never produced, since the first epoch key is 160), so a re-applied or bulk-synced block cannot double-mint, and it clamps the mint to `MAX_QNC_SUPPLY_NANO - total_supply`, so emission stops at the cap. Both the supply watermark and the pool pre-image are journalled for rollback.

## Reward epochs and certification

A reward epoch key is a macroblock index, not a block height:

- `emission_height_of(E) = (E / 160 + 1) * 14_400`, returning `None` on overflow so an unauthenticated epoch number cannot alias a real height;
- `certifying_mb_index(E) = E + 160` — exactly one macroblock certifies each epoch. Epoch 0 is on the grid and macroblock 160 certifies it, but it always certifies an all-zero root: `expected_emission_amount(14_400)` is `NoneDue` because `height / 14_400 <= 1`, so no producer ever keys a distribution to epoch 0, and `emission_mb_index` first returns 160 at height 28,800;
- `canonical_total(E)` is the halving schedule evaluated at that epoch's emission height. The amount an epoch distributes is a formula over height and is never read from a transaction.

Epoch `E`'s authoritative reward root is the `reward_root` field of the checkpoint sealed inside macroblock `E + 160`. That field is folded into `Checkpoint::hash()`, which the 2f+1 quorum certificate signs, so a differing `reward_root` produces a different signed hash and cannot reach certification. Every other reward table in the node is a cache of that value. See [consensus.md](../architecture/consensus.md) for how checkpoints are certified.

The checkpoint builder refuses to publish rather than publish a well-formed root that pays nobody: when a window is an emission boundary and the leaf set is not locally derivable, `compute_window_reward_root` returns `None` and the caller defers. A separate `Checkpoint.reward_epoch_root` is an LtHash commitment over every epoch root certified at or below the N-2 macroblock; the builder defers and triggers a repair fetch rather than fold a shorter set. The fold is append-only — a certified epoch root never changes — so the walk resumes from a persisted prefix (`epoch_fold_head`) instead of re-walking the whole grid at every checkpoint, and the prefix is persisted even on a deferring walk so the next attempt starts where this one stopped. When the macroblock a deferred commitment waits on is held locally but unreadable, the node emits `epoch_root_mb_no_usable_qc … action=operator_resync` and keeps the macroblock: it is QC-certified and below the weak-subjectivity floor, so a resync is the repair. See [maintenance.md](../operators/maintenance.md).

`root_for_apply` is the only reward read permitted on a consensus path. It returns `RuleInvalid` for an off-grid epoch number or a claim at or below its own emission height, `Root(..)` when the epoch is certified, and `LocalFault { certifying_mb }` when this node does not hold the certifying macroblock.

## Reward eligibility

Eligibility is per epoch and is read from committed on-chain state, never from self-reported counters.

**Super and genesis nodes.** A node is eligible for epoch `E` when `Account.banned_at_height == 0` and its on-chain heartbeat popcount for that epoch is at least 9. `Account.heartbeat_slots` is a `u16` subwindow bitmask (subwindow = 1440 blocks, so an epoch has 10 subwindows); bit `i` is set when at least one validated Heartbeat transaction was anchored in subwindow `i`. `account_heartbeat_count` reads `heartbeat_slots` when `heartbeat_epoch` matches, otherwise the finalized `heartbeat_final_slots`, otherwise 0. The tally is written by validated Heartbeat transactions, so liveness cannot be self-attested.

Anchor recency is a **state** rule, applied when the transaction lands, not only a producer-side filter. A Heartbeat included at height `h` sets a bit exactly when `anchor_height < h` and `h - anchor_height <= HB_ANCHOR_MAX_LAG` (90); a heartbeat outside that window leaves the tally untouched, so an old heartbeat cannot be replayed into an epoch after that epoch settled, and a future anchor cannot roll the mask forward. Producer and validator run the same predicate, so the tally is identical on every node.

The epoch mask rolls forward only. A heartbeat for an epoch above `heartbeat_epoch` moves the live mask into `heartbeat_final_slots` and starts a fresh mask; a heartbeat for the current epoch ORs its bit in; a heartbeat for the immediately preceding epoch folds into `heartbeat_final_slots`, so arrival order across the boundary does not change the count. Combined with the 90-block admission window, this makes an epoch's popcount converge to one value regardless of inclusion order.

Mempool dedup keys a Heartbeat on `(node_id, epoch * 10 + subwindow, 7)`, where `subwindow = (anchor_height % 14_400) / 1_440`, so one heartbeat per node per subwindow reaches a block; apply is idempotent on the bitmask either way.

The super set is sampled at the epoch **settle point** — `h % 14_400 == HB_ANCHOR_MAX_LAG` (90) — rather than at the epoch boundary, because heartbeats anchored in the closing epoch remain admissible for `HB_ANCHOR_MAX_LAG = 90` more blocks. A boundary sample would produce a set that no later observer could reproduce.

Registration is bounded by the same settle point. Epoch `E`'s leaf set is built from `super_registrations_as_of((E + 1) * 14_400 + 90)`: a super whose registration row is stamped above that height contributes to the following epoch instead. The roster that decides an epoch's reward leaves is committed inside `reward_root`, so it must be a function of chain data that is already final when the epoch settles.

**Light nodes.** Eligibility is committed on-chain as per-epoch bitmaps. Each of the five genesis nodes publishes a `LightNodeEligibilityBitmap` transaction for its hash-shard, where bit `i` corresponds to the light node whose **permanent** `reg_index` is `i`, set when that node attested during the epoch. The bitmap is per-shard; the bit position is the global registration ordinal, and `index_span` is the highest `reg_index` in the shard plus one. Using the permanent registration index rather than a scan-relative ordinal matters: under a scan-relative ordinal a truncated roster shifts every later node, which yields a different payout set rather than a smaller one.

The shard is a pure function of the node id: `light_shard_of(node_id) = u64::from_le_bytes(blake3(node_id)[..8]) % 5`. It is roster-size-independent, so a node's owning genesis never changes as the registry grows, and the genesis that received an attestation is always the one that commits it. Genesis node `00N` owns shard `N-1`.

The eligibility gate is **one attestation in the epoch**. A single successful ping reply — or a pull self-attestation — records the node in that epoch's set, keyed `block_height / 14_400`, and the whole set becomes the epoch's eligible ids. There is no per-epoch count threshold on the light path; the 9-of-10 subwindow requirement applies to supers only.

A light node's roster membership for epoch `E` is frozen at `light_roster_cutoff(E) = E * 14_400 + 14_350` — the moment the commit window opens, 50 blocks before the epoch ends. A node whose registration is stamped at or below that height is in the epoch's roster, including in its own registration epoch and in epoch 0; a node registered in the closing 50 blocks joins from the next epoch. The bitmap builder and every reward reader call the same function, so creator and reader index the same roster.

Pings are scheduled on the block clock, one epoch of 240 slots of 60 blocks: `slot = (height % 14_400) / 60`. A node's slot is re-randomized every epoch as `hash(node_id, epoch) % 240`, so it is not predictable across epochs, and it is woken in its primary slot plus the two following slots, with wrap-around at 240. Anchoring the schedule to height rather than the wall clock puts exactly one primary slot inside every reward epoch.

The wake roster carries light nodes that are active and below 5 consecutive ping failures. A node that has attested in one of the last 3 epochs, or that registered within that grace span, is woken by its shard owner; a node dormant longer than that returns by submitting a pull self-attestation, which both records eligibility for the current epoch and restores it to the wake roster. See [mobile wallet](../applications/mobile-wallet.md).

The bitmap transaction is system-typed: `gas_limit` 0 and `gas_price` `u64::MAX`, so it is free and ordered into the block's system lane. Its nonce is `epoch + 1` rather than an account sequence, and nonce ordering is skipped for the type; uniqueness is enforced at state level, one committed bitmap per `(genesis_id, epoch)`.

`gather_epoch_reward_sets` returns `None` (abstain) rather than an empty set when the local absence is snapshot-anchor-local, so a node without the data never votes for a root that pays nobody.

## How rewards are computed

Each epoch's `canonical_total` is split across two pools:

| Name | Value |
| --- | --- |
| `OPERATOR_POOL_BP` | 2_500 basis points (25%) to eligible super and genesis operators |
| Remainder | 75% to eligible light nodes |

The split arithmetic is exact integer math: `op_pool = total/10_000*2_500 + (total%10_000)*2_500/10_000`, and `user_pool = total - op_pool`.

If one side has no eligible recipients, its whole share goes to the other side — supers empty yields `(0, total)`, lights empty yields `(total, 0)`. At launch, with no light clients registered, eligible super nodes receive the entire emission. Minting a share that nobody could ever claim would silently strand it.

**Within** each pool the share is exactly equal per eligible `node_id`: `per_node = pool / count`, and the first `pool % count` nodes in `node_id`-sorted order each receive one additional nanoQNC, so the sum is exactly conserved. Reputation, node age, burn size and uptime beyond the eligibility gate do not affect the amount. Shares are keyed per `node_id` but accumulated per **wallet** in a `BTreeMap`, so a wallet holding both a super and a light identity yields one aggregated leaf rather than two.

The reward merkle leaf is

```
leaf = hex(SHA3-256(wallet_bytes || epoch.to_le_bytes() || amount.to_le_bytes()))
```

and this single hasher is shared by the root build, the sharded structure and the claim-proof builder, so every derivation is byte-identical.

At scale the leaf set is built streamed: recipients are aggregated per wallet through a RocksDB scratch column family (which orders bytewise, matching `BTreeMap` order) and hashed one shard at a time, so peak memory is one shard rather than the whole recipient set. `REWARD_SHARD_SIZE` is 4096 leaves. The shard-meta roots are re-combined and compared against the committed `reward_root` before any proof is served; a mismatch returns a divergence signal rather than a wrong amount. The shard leaf cache is pruned to the newest `SHARD_CACHE_RETAIN_EPOCHS = 256` epochs, while the epoch roots, super-eligibility index and light bitmaps are retained so an older claim self-heals by rebuilding.

## The reward pool and its invariant

`StateManager::REWARDS_POOL` is the literal account address `system_rewards_pool`. It is a real account: its balance is inserted into the state merkle tree, so it is committed inside `state_root`. `credit_rewards_pool` warms the account through the disk store before mutating it, because `accounts` is a bounded LRU and an `entry()` on a cold key would fabricate a zero-balance pre-image over the real balance.

The invariant is

```
pool_balance == (everything minted into the pool) - (everything claimed out of it)
```

and it is enforced structurally rather than by an audit job:

- the only mint is `emit_rewards`, and the pool is credited exactly what that call returned, not what was requested;
- a claim is a **move**: `claim_reward` debits `system_rewards_pool` and credits the wallet in the same call, so a credit without the matching debit — a second mint of the same emission, invisible in `total_supply` — is impossible;
- both leaves are in the merkle tree, so the pool balance is part of `state_root` and every node reaches the same verdict about whether a claim is payable;
- a claim larger than the pool balance is refused fail-closed and does **not** advance the claim watermark, so the wallet may retry later;
- below the supply cap, what an emission mints into the pool at height `h` is exactly what the epoch keyed at `h` distributes — both sides are the same pure function of height, and a unit test walks the epoch grid comparing them. In the final epochs, where `emit_rewards` clamps the mint to `MAX_QNC_SUPPLY_NANO - total_supply`, the pool receives the clamped amount while the epoch's leaf set is still sized by the schedule; the fail-closed short-pool branch is what governs there, so a claim that the pool cannot cover is refused without advancing its watermark rather than paid from nothing.

Unit tests pin the conservation property directly: after two claims, `pool_after + credited_a + credited_b == minted`, and `total_supply` is unchanged by a claim.

Because the pool balance and every wallet's claim watermark live in the state root, a node that mis-credits a claim diverges its own `state_root` and its blocks stop reaching quorum.

## The claim flow

Rewards are strictly **pull**. Emission credits only `system_rewards_pool`; a wallet is credited only when a signed, proof-carrying claim transaction is included in a block.

`Account.last_claimed_epoch` is the claim watermark. It is part of the account merkle leaf, so it is consensus-bound, and it is **monotonic** — which drives the whole flow: batches must run oldest-first and must **stop**, never skip, at the first unservable epoch, because crediting a later epoch after skipping an earlier one advances the watermark past the skipped epoch and forfeits it permanently on every node.

### Step 1 — quote

A wallet POSTs to `/api/v1/rewards/claim` with `node_id`, `wallet_address`, and a mandatory ML-DSA-65 signature over `claim_rewards:{node_id}:{wallet_address}`. The request is rejected outright if that signature is missing, and `wallet_address` must pass full EON-address validation before any state is read. The claimant wallet must equal the on-chain registered wallet for the `node_id`; an unregistered node cannot claim. A per-node in-progress lock rejects concurrent claims for the same node.

Without `claims_data`/`claims_signature`, the node quotes a batch. It enumerates epochs strictly greater than the wallet's `last_claimed_epoch` in ascending order, generates each merkle proof from the locally stored shard, and stops at the first epoch it cannot serve, reporting `stopped_at_epoch` and `stopped_reason`. Bounds on the quote:

| Name | Value |
| --- | --- |
| `MAX_BATCH` | 512 epochs per quote |
| `CLAIM_QUOTE_BYTE_BUDGET` | 128 * 1024 bytes |
| `MAX_CLAIMS_DATA` (submit) | 256 * 1024 bytes |
| `MAX_CLAIM_ENTRIES` (mempool admission) | 512 entries |
| `CLAIM_PROOFGEN_SEM` | 16 concurrent proof generations node-wide |
| `rebuild_budget` | one leaf-set rebuild per request |
| `REBUILD_RETRY_SECS` | 3600 s before a diverged epoch is retried |
| `claim_rewards` rate limit | 10 requests per 3600 s window, 1800 s block duration |

`stopped_reason` takes one of six values, and each tells the wallet what to do next:

| Value | Meaning |
| --- | --- |
| `batch_full` | `MAX_BATCH` reached — re-call for the remainder |
| `quote_byte_budget` | `CLAIM_QUOTE_BYTE_BUDGET` reached — re-call for the remainder |
| `root_not_here` | this node does not hold the epoch's certified root — retry against another node |
| `rebuild_budget` | the one permitted leaf-set rebuild was already spent this request — re-call |
| `local_corruption` | this node's inputs are present but do not reproduce the certified root; the epoch is memoised for `REBUILD_RETRY_SECS` and this node resyncs — claim elsewhere |
| `epoch_unservable` | the epoch resolves to no servable proof here — claim elsewhere |

The response carries `claims_data`, a `sign_message`, `claim_timestamp`, `last_claimed_epoch`, and `amount_nano` as a decimal **string** — nanoQNC exceeds 2^53, so a JSON number would round and the wallet's own cross-check would then reject an honest quote. Returning `last_claimed_epoch` lets the wallet verify the batch shape (starts at the watermark, strictly ascending) rather than only its total.

An epoch whose certified root is all-zero distributed nothing and is skipped without error.

### Step 2 — signed submit

The wallet signs

```
qnet_claim_v1:{wallet}:{claim_timestamp}:{hex(SHA3-256(claims_data))}
```

with its ML-DSA-65 key and re-POSTs the same `claims_data` bytes plus `claims_signature`. The message is built from the exact bytes that go on the wire, so there is no canonicalization gap between signer and verifier. Binding the timestamp is what stops an endlessly re-emittable no-op replay: without it the payload could be re-sent forever with a bumped timestamp, each copy a fresh hash passing every gate.

The node constructs the transaction verbatim: `RewardDistribution`, `from = system_rewards_pool`, `to = wallet`, `data = claims_data`, `gas_price = 0`, `gas_limit = 0`. A reward claim pays no fee. One transaction can cover all of a wallet's unclaimed epochs.

The envelope's `amount` carries the batch total and its `nonce` is 0; both are envelope metadata. What is credited comes only from the per-entry `amount` inside `claims_data`, each of which is bound into the merkle leaf and proven against the certified root, and nonce ordering is skipped for the type — the anti-replay authority is `last_claimed_epoch`, not a sequence number.

A merkle reward claim is fee-less but does **not** ride the consensus priority lane. `gas_price = 0` is the real ordering weight: the lane is reserved for consensus-carrying system transactions, and packing free claims into it would place them ahead of every paying transaction in the block.

### Mempool admission

Admission bounds entries at `MAX_CLAIM_ENTRIES`, requires at least one entry above the wallet's watermark (so a credited payload cannot be re-flooded as a free no-op), checks `claim_authorized`, and verifies every entry's proof against the epoch's certified root. Admission is fail-closed on resolution: a claim naming an epoch this node cannot resolve to a certified root is refused here, so a node only relays and packs claims it has itself verified. A wallet whose claim is refused for that reason submits it to a node that holds the epoch. Apply re-runs the same authorization and proof checks and is the final authority.

The producer runs one further check before it builds a block. `claims_resolvable` scans every `RewardDistribution` from `system_rewards_pool` in the candidate list and reports the first epoch that resolves to `LocalFault`, so the producer declines the block rather than discovering the fault inside its inline apply, which has no snapshot to roll back.

### Apply

`apply_merkle_claims` runs in Phase 2b of block apply, after ordinary transactions, so the claim's pre-images already exist. For each claim transaction it:

1. verifies `claim_authorized` — the ML-DSA-65 public key on the transaction must derive to the recipient address (`eon = SHA512(pk)`), and the signature must cover the exact payload bytes, so a signature lifted from a past claim cannot be re-aimed at a shorter one;
2. sorts entries by epoch ascending and journals pre-images for **both** the wallet and `REWARDS_POOL`, since both leaves move;
3. resolves each epoch through `root_for_apply`, recomputes the leaf hash, and verifies the proof against the certified root;
4. on a proof failure, **breaks** the batch rather than skipping the entry;
5. calls `claim_reward`, which debits the pool, credits the wallet and advances the watermark, returning false on replay (`epoch <= watermark`) or a short pool.

Every outcome except one is scoped to a single transaction, so one wallet's claim can never change what another wallet's claim does. A transaction whose payload the recipient's key does not authorize, or whose `claims` array is absent or empty, is passed over and the block continues; an entry that is not a well-formed `{epoch, amount, proof}` triple is dropped from that transaction's batch; an epoch whose certified root is all-zero distributed nothing and is skipped without advancing the watermark; an epoch that `root_for_apply` rules invalid is skipped; and a proof that fails verification breaks that batch at the failing epoch, leaving the watermark below it so the wallet can claim it later.

The one block-level outcome is `LocalFault` — the certifying macroblock is missing locally. It aborts the whole block and returns the missing macroblock index for fetching. Crediting or skipping instead would fork `state_root` against nodes that hold the macroblock. This is the anti-fork rule of the claim path.

A `RewardDistribution` transaction that reaches `apply_to_state` is a no-op for both arms: the emission arm is handled by apply Phase 1 and the claim arm by `apply_merkle_claims`, so no balance moves there.

## Transaction fees

Fees are entirely separate from emission.

| Name | Value |
| --- | --- |
| `BASE_FEE_NANO_QNC` | 100_000 nanoQNC (0.0001 QNC) |
| `MIN_GAS_PRICE` | `BASE_FEE_NANO_QNC / gas_limits::TRANSFER` = 10 nanoQNC per gas unit |
| `PRIORITY_MULTIPLIER` | 10 |
| `gas_limits::TRANSFER` | 10_000 |
| `gas_limits::REWARD_CLAIM` | 25_000 |
| `gas_limits::NODE_ACTIVATION` | 50_000 |
| `gas_limits::CONTRACT_CALL` | 100_000 |
| `gas_limits::CONTRACT_DEPLOY` | 500_000 |
| `gas_limits::MAX_GAS_LIMIT` | 1_000_000 |
| `GAS_METERING_ACTIVATION_HEIGHT` | 100_000 |
| Quantum-signature premium | +50% (`effective_gas_price = gas_price + gas_price/2`) |

`MIN_GAS_PRICE` is derived so the floor is self-consistent: a standard transfer at that price costs exactly `BASE_FEE_NANO_QNC`. It is the single source of truth for the mempool admission filter, the gas-price hint endpoint and the RPC submit path.

`effective_gas_price` adds the 50% premium whenever the transaction carries an ML-DSA-65 signature, compensating for the larger transaction and its verification cost. The gate is the **signature**, not the public key, because the public key is legitimately elided after first use; gating on the key would split nodes on the fee.

**Charging and refund.** At apply, the sender is debited `effective_gas_price * gas_limit` in addition to the transferred amount. From `GAS_METERING_ACTIVATION_HEIGHT = 100_000` onward, `apply_gas_refund` credits the sender back `(gas_limit - compute_gas_used) * effective_gas_price` minus the WASM fuel fee (`wasm_fuel * effective_gas_price`, zero for non-WASM transactions). Below that height the full `gas_limit * price` is charged. The refund is deterministic because `compute_gas_used()` is a pure function of the signed transaction — the type for most variants, and the type plus `data.len()` for `ContractDeploy` (+10 per byte) and `ContractCall` (+5 per byte).

**System transactions are free.** `gas_debit()` returns 0 for system-typed transactions — `NodeActivation`, `NodeRegistration`, `NodeReactivation`, `Heartbeat`, `LightNodeEligibilityBitmap`, `RewardDistribution`, `KeyRotation` and both equivocation proofs. Their authorization or payment is proven elsewhere, and a node coming online for the first time holds no QNC, so charging a fee would be a hard chicken-and-egg.

**Where fees go.** 100% of the net fee is credited to the block producer's on-chain registered wallet. The credited amount is **recomputed** from the transactions that actually applied, never read from the block header's `fees_collected`, so a malicious producer cannot inflate it; the header legitimately exceeds the credit when a transaction failed, and only an excess over the whole-list upper bound produces a warning log. Per-transaction accrual counts `compute_gas_used()` at or above the metering height and `gas_limit` below it, and excludes `system_*` senders. WASM compute is billed as an additional `wasm_fuel * effective_gas_price` accruing to the same credit. The payout wallet is resolved from the on-chain node registration for the block's producer id; if no wallet is found, no fee is credited at all. `credit_producer_fees_once` applies the credit exactly once per block height, with the marker journalled for rollback.

**Storage deposits.** Creating a new contract-storage entry moves `STORAGE_DEPOSIT_PER_ENTRY_NANO_QNC = 10_000_000` nanoQNC (0.01 QNC) from the sender to `STORAGE_RENT_ESCROW_ADDR` (`system_storage_rent_escrow`), and back when the entry is removed. This is a pure account move — never minted, never burned — and it is the economic bound on state-growth spam. The refund is paid to the **caller of the removing operation**, not to whoever created the entry: burning a QRC-721 token refunds the owner pointer, the zeroed balance entry and any cleared approval to the account that sent the burn. Deposits are therefore a rent bond attached to state, not a per-creator ledger. Because every refundable entry was charged on creation, the escrow always covers a removal; a shortfall is rejected deterministically on every node rather than paid out short. See [smart-contracts.md](../developers/smart-contracts.md).

## Reward split summary

There is exactly one split in the protocol, and it is a two-pool split of each epoch's emission:

| Recipient class | Share | Gate |
| --- | --- | --- |
| Super and genesis operators | 25% (`OPERATOR_POOL_BP` = 2500 bp) | `banned_at_height == 0` and heartbeat popcount >= 9 for the epoch |
| Light nodes | 75% | in the epoch's roster (registered at or below `epoch_start + 14_350`) and bit set in the epoch's `LightNodeEligibilityBitmap` for its shard, which one attestation in the epoch achieves |
| Block producer | 100% of the block's net transaction fees | on-chain registered wallet resolvable |

The 25/75 figure is a pool ratio, not a per-node weighting. Within each pool every eligible node receives the same amount.

## Activation payments

A Phase 2 node activation debits `amount` from the payer's balance and pays no fee, since `NodeActivation` is system-typed. The debited QNC leaves circulation while `total_supply` is unchanged. A Phase 1 activation is paid by burning 1DEV on the external Solana chain and carries `amount = 0` on the QNet transaction. See [node-activation.md](node-activation.md).

## Related documents

- [State and transactions](../architecture/state.md) — account fields, state commitment, transaction types
- [Consensus](../architecture/consensus.md) — macroblocks, checkpoints, quorum certificates
- [Node activation](node-activation.md) — Phase 1 and Phase 2 activation and on-chain registration
- [RPC API](../developers/rpc-api.md) — the claim and supply endpoints
