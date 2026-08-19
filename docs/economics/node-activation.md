# Node activation

This document describes how a QNet node comes into existence: the node types the protocol defines,
the two-phase activation model, how a Phase 1 burn on the external Solana chain is verified and bound
to a single node identity, the Phase 2 native-token path, how the on-chain registration transaction
writes the node registry, the rules that keep one payment tied to one node, and the reputation values
that gate consensus.

## Node types

The protocol defines exactly two node types. `NodeType` in `core/qnet-state/src/account.rs` has the
variants `Light` and `Super`, and the same enum is mirrored in the P2P layer
(`development/qnet-integration/src/unified_p2p.rs`) and the integration crate
(`development/qnet-integration/src/node.rs`). The activation-code endpoint accepts the node-type
strings `light` and `super`, and a registry row stores `"super"` or `"light"`.

The difference is structural capability, not an economic tier:

| Property | Light | Super |
| --- | --- | --- |
| Consensus participation | Excluded by type. `PeerInfo::is_consensus_qualified()` returns `false` for `NodeType::Light` before any reputation check | Eligible, subject to the reputation gate |
| On-device chain data | A pure API client storing zero blockchain data (`max_storage_bytes = 0`), querying balances and history over REST from Super nodes | Full local chain |
| Consensus certificates | Cache size 0, persist limit 0 | Cache 5000, persist 2000 |
| Archival duty | The archive requirement returns 0 for Light | Per-node archival role |
| Consensus key in registry row | `vrf_pk` is empty | Required: raw ML-DSA-65 public key, exactly `D3_PK_BYTES` = 1952 bytes |
| Where the registration TX is built | Client-side, by the mobile wallet | Server-side, by the node itself at boot |
| Public API endpoint in the registry | Always empty (privacy) | Public by default; set to an empty string to hide |

A Super node aborts its own registration arm if `vrf_pk` is not exactly `D3_PK_BYTES`. This is
deliberate: a registry row is immutable once chain-stamped, so a keyless Super row would permanently
strand the identity — it could never vote, never produce, and never serve as a burn attestor. The
`vrf_pk` field lives inside the hashed body of the transaction, not in the elided envelope, so a
relayer cannot swap the consensus key without changing the transaction hash. The `/node/status` RPC
reports `consensus_participation` as `node_type != NodeType::Light`.

Archival is a role a Super node performs. See [consensus](../architecture/consensus.md) for how the
eligible-producer set is derived from the Super roster.

### Genesis identities

Five genesis nodes exist, with bootstrap identifiers `genesis_node_001` through `genesis_node_005`.
They are protocol-minted rather than burn-backed and are activated with five fixed 20-character
bootstrap codes of the form `QNET-BOOT-NNNN-STRAP` (`genesis_constants::GENESIS_BOOTSTRAP_CODES`),
which decrypt to node type `super`, a predefined genesis wallet, and the burn transaction placeholder
`genesis_bootstrap`. The burn exemption is bound, not open: a registration proof of `"genesis"` is
accepted only when the node id is one of the five real genesis ids (`is_legacy_genesis_node`); any
other node presenting `registration_proof == "genesis"` is rejected. Genesis registry rows are stamped
at `reg_height` 0 through the same canonical writer every other node uses, sorted by node id so index
assignment is deterministic.

### Node identity

A node id is a privacy-preserving pseudonym derived from the beneficiary wallet, so one wallet
resolves to the same node id across restarts, IP changes and host swaps; the wallet is not recoverable
from the id.

| Type | Format |
| --- | --- |
| Light | `light_mobile_<blake3("LIGHT_NODE_PRIVACY_<wallet>")[..16]>` |
| Super | `super_node_<blake3("SUPER_NODE_PRIVACY_<wallet>")[..16]>` |

The two domains are separated deliberately, so one wallet holds independent identities in each
namespace. `registration_identity_bound()` recomputes the expected id from the wallet and node type
and rejects any registration whose `node_id` does not match — the anti-squat check. It runs before any
height-dependent gate, so it applies at admission, producer-include and block validation alike.

## The two-phase model

`ActivationPhase` has two variants:

| Phase | Payment | Effect on the payer |
| --- | --- | --- |
| `Phase1` | 1DEV burn on Solana (external chain) | Burned on Solana; the on-chain `amount` field must be 0 |
| `Phase2` | QNC debited from the payer | Debited on QNet; `total_supply` is unchanged |

The phase is a pure function of burn progress and time.

### Phase transition condition

`Transaction::is_phase2(total_burned, current_supply, genesis_ts, now_secs)` is the single resolver.
It returns Phase 2 when either half holds:

- `burn_pct_tenths(total_burned, current_supply) >= 900` — at least 90.0% of the original 1DEV
  supply burned, the original being the sum of burned and remaining; or
- `now_secs - genesis_ts >= PHASE2_AGE_SECS`, five years of 365 days since the genesis block
  timestamp. `genesis_ts == 0` means block 0 is not applied on this node yet and keeps this half
  shut.

Otherwise it is Phase 1. Every price quote, the admission gate and the operator-facing phase display
read that one resolver through `live_activation_pricing`, so a quoted phase cannot disagree with the
phase admission enforces. The supply figures come from a live Solana `getTokenSupply` read behind a
short-lived cache; an unreadable supply is a retryable error, never a defaulted phase, because a
defaulted quote makes the payer burn the wrong amount irreversibly.

## Phase 1: burn of the external 1DEV token

Phase 1 pricing is **universal across node types** — Light and Super pay the same. The price endpoint
returns `"universal_price": true` and does not branch on node type in Phase 1. The formula is:

```
tiers = floor(burn_percentage / 10)          # each complete 10% of 1DEV supply burned, capped at 8
cost  = max(1500 - 150 * tiers, 300)         # whole 1DEV
```

Base cost is 1500 whole 1DEV, the reduction step is −150 1DEV per complete 10% of supply burned, tiers
are capped at 8, and the floor is 300 1DEV — which is also the minimum attested `burn_cost` accepted
on-chain. `Transaction::phase1_activation_cost` is the integer-deterministic chain-side form: it
reconstructs the original supply as `burned + current_supply` (the sum, not the remainder alone) and
computes the burn percentage to one decimal before bucketing to complete 10% steps. Each burn attestor
recomputes it from its own live Solana `getTokenSupply` read rather than from a caller-supplied hint.
Bucketing means attestors reading Solana at slightly different moments still agree on the cost except
exactly on a boundary, where the registration simply retries. The supply figure treats the 1DEV
genesis cap as 1,000,000,000 whole tokens at 6 decimals, deriving `total_burned = cap - current_supply`.
The 1DEV mint is pinned per network profile in `network_config.rs`, matching the literal both wallets
compile in, so a burn is measured against the same mint on every surface. See
[tokenomics-1dev](./tokenomics-1dev.md).

### Activation code

`POST /api/v1/generate-activation-code` verifies the burn transaction on Solana, rejects a declared
`burn_amount` below the current minimum price for the phase, enforces the one-wallet-one-node rule,
then emits a code.

| Property | Value |
| --- | --- |
| Length | 25 ASCII characters |
| Prefix | `QNET-` |
| Structure | four dash-separated segments |
| Node type | first character of segment 1 — `L` = light, `S` = super |
| Wallet binding | 5 bytes (10 hex characters) taken from segment 2 and the first 4 characters of segment 3 |
| XOR key | first 32 hex characters of `SHA3-256("{burn_tx}:{node_type}:{burn_amount}")` |

Ownership verification is stateless: the verifier rebuilds the XOR key, decrypts the bound bytes, and
compares them byte-exactly against the wallet's first N bytes, erroring if the wallet is shorter than
the binding. Because the exact burn amount is part of the key material, a mismatched declared amount
makes the code un-verifiable. The dedup authority for an activation is the on-chain registry root
committed in the QC checkpoint, not any node-local cache.

### Binding the burn to one node identity

The burn is bound to a node by four artefacts, all re-verified deterministically at block validation
with no external read. The consensus rule `burn_attestation_required` has activation height 0, so it
is live from genesis; only the five genesis identities bypass it.

1. **Identity bind.** `node_id` must equal the deterministic wallet pseudonym for the declared node
   type. Checked first and height-independently.
2. **Burner authorization.** An Ed25519 signature by the burning Solana wallet over
   `qnet_onchain_reg:{node_id}:{wallet}:{registration_proof}:{timestamp}:{attest_root_tag}:{burn_tx}`,
   where `attest_root_tag` is `hex(sha3-256(ML-DSA-65 public key))` or empty when the registration
   carries no key. The burn is the only Sybil cost, so its owner is the sole authority on which node it
   activates; without this a public burn transaction could be front-run. Binding the attestation root
   also stops a relayer swapping the key the node's liveness proofs are checked against.
3. **Committee attestation quorum.** A set of distinct committee ML-DSA-65 signatures over
   `burn_attest:{burn_tx}:{burn_wallet}:{wallet}:{amount}:{node_type_u8}:{cost}:{attest_epoch}`, with
   `node_type_u8` = 0 for Super and 1 for Light. The threshold is
   `checkpoint_bft::quorum_size(committee_size)` distinct members. Each attestor's public key is read
   from on-chain state or the binary-pinned genesis anchor, never from the RAM peer registry.
4. **Burn uniqueness index.** A committed `burn_tx -> node_id` binding: if an earlier block already
   bound this burn to a *different* node id the registration is rejected. The key is the node id, not
   the wallet — deliberately, because one wallet owns both a super and a light pseudonym and the Phase
   1 cost is tier-independent, so a wallet-keyed bind would let a single burn activate both tiers for
   one fee.

Beneficiary consent is enforced separately from burner authorization: `wallet_address` must derive
either from the ML-DSA-65 wallet key that signed the registration (with a valid lifecycle signature)
or from the burning Solana address itself. Otherwise a burner could name a victim's wallet and occupy
the pseudonym derived from it forever. Two cost checks close the loop without re-reading Solana:
`burn_cost >= 300` and `burn_amount >= burn_cost`. The cost is inside the quorum-signed message, so
validators agree on it by signature verification.

**Attestation epoch.** `attest_epoch` pins which committee's signatures count. It must be non-zero,
not in the future relative to `apply_epoch = (height - 1) / 90 + 1`, and at most
`MAX_ATTEST_EPOCH_LAG = 2` epochs behind it (an epoch is 90 blocks); a stale attestation must be
re-armed against the current committee. The committee is resolved at
`attest_rep_height = (attest_epoch - 1) * 90 + 1`. If that committee is unavailable post-genesis the
registration is rejected outright — the node is behind and must resync — rather than falling back to
the genesis set, which would diverge from synced validators.

**Attestor behaviour.** The `node_attestBurn` RPC verifies the burner's owner signature *before* any
epoch resolution or Solana I/O, rejects a `burn_tx` that is not a base58 Solana signature decoding to
64 bytes, recomputes the Phase 1 cost from its own supply read, and signs only its own observed
`(cost, actual_burned)` pair. Each attestor also persists a one-burn-to-one-node dedup keyed on the
node pseudonym and refuses to re-attest the same burn for a different node. Attestor eligibility is
committee-wide: the set is the deterministic consensus committee of `attest_epoch`, falling back to
the five genesis nodes only in the genesis era, so attestation decentralises as the network grows.

## Phase 2: native QNC activation

In Phase 2 the activation payment is native QNC, debited from the payer on the QNet chain. Phase 2
pricing is type-differentiated.

| Node type | Base cost | Chain floor constant | Chain floor |
| --- | --- | --- | --- |
| Light | 10,000 QNC | `PHASE2_LIGHT_MIN_NANO` | 5,000 QNC |
| Super | 7,500 QNC | `PHASE2_SUPER_MIN_NANO` | 3,750 QNC |

A network-size multiplier is applied to the base cost when a price is quoted:

| Active nodes | Multiplier |
| --- | --- |
| ≤ 100,000 | 0.5 |
| ≤ 300,000 | 1.0 |
| ≤ 1,000,000 | 2.0 |
| > 1,000,000 | 3.0 |

The chain floors are `base × 0.5`, the minimum over that table, because the discount tier covers the
whole early-network era; a floor set at the base would reject honestly-priced activations. The
multiplier itself is a quoting rule rather than a chain rule — it reads a process-local node counter,
and a consensus rule requires a committed count. Amounts are converted from whole QNC to nanoQNC at
transaction construction (`NANO_PER_QNC = 1_000_000_000`, `QNC_DECIMALS = 9`); Phase 1 sets
`amount = 0`.

One function, `check_node_activation_price`, carries the rule: a Phase 1 activation must carry
`amount == 0`, and a Phase 2 activation must reach its per-type nanoQNC floor. It is a pure function
of the transaction and the two compile-time constants — no state, no height, no node-local input — so
every node reaches the same verdict and enforcing it cannot split `state_root`.

The binding enforcement is on the **block-apply path**, the path every node runs when accepting a
block: the `NodeActivation` apply arm calls the check before the idempotency short-circuits and
before any mutation, so an underpaid activation can never be replayed in and a rejected transaction
leaves no partial state. A producer that seals its own activation is bound by exactly the same floor
as a submitted one. `Transaction::validate()` calls the same function at admission — from the
mempool, gossip, RPC submit and the producer's fill loop — so the two can never drift; that call
keeps an underpriced activation out of the mempool before a producer spends a slot on it.

## On-chain registration

Two distinct system transactions are involved.

**`TransactionType::NodeActivation { node_type, amount, phase }`** flips the account's node status.
Its apply arm checks the entry price first, then creates the sender account if absent, is a no-op
when `is_node` is already true (the single-use guard, which also makes sync replay idempotent),
requires `nonce == sender.nonce + 1`, debits `amount + fee`, and calls `activate_node(...)` to set
`is_node` and `node_type`. Both phases
are charged a zero fee: the arm reads `self.gas_debit()`, which returns 0 for every `NodeActivation`
because the variant is system-typed. The transaction is authenticated solely by the node's ML-DSA-65
key over a canonical message; Ed25519 appears only for the external Solana burner's signature.

**`TransactionType::NodeRegistration { .. }`** creates the on-chain node-id-to-wallet binding. Its
fields are `node_id`, `node_type`, `wallet_address`, `registration_proof`, `api_endpoint`, `burn_tx`,
`burn_wallet`, `burn_owner_sig`, `vrf_pk`, `burn_amount`, `burn_cost`, `burn_attestors` and
`attest_epoch`. Both are system transactions: `is_system_tx()` covers `NodeRegistration`,
`NodeActivation`, `NodeReactivation`, `Heartbeat`, `LightNodeEligibilityBitmap`, `RewardDistribution`,
`KeyRotation` and both equivocation proofs, and `gas_debit()` returns 0 for all of them.

Mempool dedup keys enforce one-shot semantics:

| Transaction | Dedup key | Meaning |
| --- | --- | --- |
| `NodeRegistration` | `(node_id, 0, 4)` | one-shot for the chain's lifetime |
| `NodeActivation` | `(from, phase_id, 6)` | one-shot per (wallet, phase), `phase_id` ∈ {1, 2} |
| `NodeReactivation` | `(node_id, last_macroblock_index, 5)` | one per macroblock epoch (90 blocks) |

State apply additionally rejects a duplicate `NodeRegistration` when `is_node_registered(node_id)` is
already true.

**`TransactionType::NodeReactivation { node_id, current_height, last_macroblock_hash, last_macroblock_index, api_endpoint }`**
is a separate fee-less system transaction letting a returning node re-enter the eligible-producer
set. It also republishes the node's address: when `api_endpoint` is non-empty, apply refreshes the
committed endpoint for `node_id` exactly as a registration does, writing both the persisted
`node_registry` row and the in-RAM endpoint registry that the QUIC identity gate and gossip address
binding read. An empty `api_endpoint` — the operator hiding the IP — leaves the stored value as it
stands. The endpoint is inside the signed canonical message, so the address that gets committed is
the one the returning node signed. Apply also installs the envelope's 1952-byte ML-DSA-65 key when no
key is registered for that identity yet.

### What the registry stores

The canonical writer `save_node_registration_inner` stamps `node_type`, wallet, `reg_height`, burn
transaction, `vrf_pk_sha3` and the permanent `reg_index` into the forward row `node_<node_id>`, and
treats all of them as **immutable once chain-stamped** — RPC and discovery-cache writes, which carry
no `reg_height`, can never rebind them. All six are hashed into the `registry_root` row preimage under
the domain tag `qnet-registry-row-v4`, in the order node_id, wallet, `reg_height`, `reg_index`,
`node_type`, burn, `vrf_pk_sha3`, each variable-length field length-prefixed. `reg_index` is covered
because every eligibility bitmap is indexed by it, and `node_type` because it selects which roster
index the row joins. A Rust test and a mobile Jest test pin the same root over the same three-row
vector, so any client reproducing `registry_root` must hash all seven fields in that order.

Reward-roster indices are written only on chain apply: `srtr_<node_id>` for ids
prefixed `super_` or `genesis_node_`, and `lrtr_<node_id>` when the node type is `light`. The
`registry_root` LtHash accumulator is updated in the same write batch as the row, so the row and the
accumulator cannot disagree across a crash. The block-apply pipeline materialises each row through
`save_node_registration_at_height_burn_vrf` and writes the burn-to-node binding with
`committed_burn_wallet_put`. The `registry_root_required` consensus gate is also active from height 0:
a checkpoint's `registry_root` must match each validator's independent recompute, and a snapshot's
node registry must match the anchor macroblock's committed root. See
[state](../architecture/state.md).

### Registration paths by type

Super and genesis registration transactions are created server-side by a boot-spawned convergence
driver. Light registration transactions are created client-side by the mobile wallet after
`POST /api/v1/light-node/register` returns a registration proof, and submitted through
`POST /api/v1/node-registration/submit`, which rejects any node type other than `light` and requires
`from == wallet_address`. Light registration requires a non-empty `burn_tx_hash`, a non-zero
`burn_amount`, a successful stateless XOR code-ownership match, and an Ed25519 signature proving
control of the burning Solana wallet. See [mobile wallet](../applications/mobile-wallet.md) and the
[RPC reference](../developers/rpc-api.md). Light-node reward eligibility is separately committed
on-chain through a `LightNodeEligibilityBitmap` transaction, one per genesis shard per epoch, indexed
by each node's permanent registration index; Light nodes are pinged on a randomized per-window slot
with a 2-slot grace and retry window out of 240 slots. A registration stamped at or below
`epoch_start + 14_350` joins that epoch's reward roster, including the node's own registration epoch;
one stamped in the closing 50 blocks joins from the next epoch. See
[economics overview](./overview.md).

## One node per payment, and device rules

- **One wallet, one node.** Enforced at code-generation time against persistent storage via
  `get_nodes_by_wallet`, checking both the QNet reward wallet and the Solana burner address. Code
  generation is deterministic from the burn transaction hash, so regenerating from the same burn
  returns the identical code — that is the recovery path.
- **One burn, one node.** The committed `burn_tx -> node_id` index rejects a second node backed by the
  same burn, and each attestor independently refuses to re-attest a burn for a different node.
- **The newest activation of a wallet-and-type pair is the live one.** Every activation first scans the
  active-node table for an entry with the same wallet address and node type. When one is found, the
  registry signals the incumbent to shut down — directly over HTTP for a single resolvable target, or
  as a blockchain-borne replacement notice when the device signature names several — and marks it
  replaced before recording the new activation. Activation proceeds either way, so an incumbent that
  cannot be reached still loses the record. Treat re-activating an existing wallet-and-type pair as a
  move of that node, not as a way to run a second one: bring the old host down first, so the two are
  never both trying to serve the identity.
- **Light devices.** At most 3 devices per Light node. A fourth registration first prunes devices that
  are inactive or unseen for 24 hours, and if 3 remain it is refused with
  `Maximum 3 devices per Light node.` Light nodes switch devices freely with no rate limit, subject to
  wallet ownership verification.
- **Super migration.** 1 migration per 24 hours, enforced in `handle_register_node`: a same-wallet,
  same-`node_id` re-registration is treated as a server migration and refused while fewer than
  86,400 s have elapsed since the last one. The timestamp map is process-local, so the limit is a
  per-node operating rule rather than a consensus rule and resets on restart.

## Reputation

Consensus reputation is binary.

| Constant | Value |
| --- | --- |
| `INITIAL_REPUTATION` | 70.0 |
| `MIN_CONSENSUS_REPUTATION` | 70.0 |
| Banned value | 0.0 |

The scale is 0–100; 70 is both the starting value and the eligibility threshold, so a node is either
at the floor and eligible, or at 0 and excluded. `compute_consensus_reputation_map` seeds every
consensus participant at `INITIAL_REPUTATION` and inserts `0.0` for identities whose
`Account.banned_at_height` is at or below the window head. That field is write-once, permanent, part
of the account leaf hash and therefore inside `state_root`, and a cryptographically proven
equivocation is the only thing that sets it.

`get_node_reputation_score` returns `MIN_CONSENSUS_REPUTATION / 100.0` (0.70) for any node, or 0.0 if
tombstoned. Consensus paths read only these values, because branching on a mutable per-node score
diverges across nodes and is a fork vector.

## Related documents

[Economics overview](./overview.md) · [1DEV token](./tokenomics-1dev.md) ·
[Consensus](../architecture/consensus.md) · [State](../architecture/state.md) ·
[Cryptography](../architecture/cryptography.md) · [RPC API](../developers/rpc-api.md) ·
[Running a node](../operators/running-a-node.md)
