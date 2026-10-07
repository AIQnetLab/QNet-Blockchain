# Node activation

This document describes how a QNet node comes into existence: the node types the protocol defines,
the two-phase activation model, how a Phase 1 burn on the external Solana chain is verified and bound
to a single node identity, the Phase 2 native-token path, how the on-chain registration transaction
writes the node registry, the rules that keep one payment tied to one node, and the reputation values
that gate consensus.

## Node types

The protocol defines exactly two node types. `NodeType` in `core/qnet-state/src/account.rs` has the
variants `Light` and `Super`, and the same enum is mirrored in the P2P layer
(`development/qnet-integration/src/unified_p2p/mod.rs`) and the integration crate
(`development/qnet-integration/src/node/mod.rs`). The price endpoint (`GET /api/v1/activation/price?type=`)
and the burn attestation (`node_attestBurn`, parameter `node_type`) take the node-type strings `light` and
`super`, and a registry row stores `"super"` or `"light"`.

The difference is structural capability, not an economic tier:

| Property | Light | Super |
| --- | --- | --- |
| Consensus participation | Excluded by type. `PeerInfo::is_consensus_qualified()` returns `false` for `NodeType::Light` before any reputation check | Eligible, subject to the reputation gate |
| On-device chain data | A pure API client storing zero blockchain data (`max_storage_bytes = 0`), querying balances and history over REST from Super nodes | Full local chain |
| Consensus certificates | Cache size 0, persist limit 0 | Cache 5000, persist 2000 |
| Archival duty | The archive requirement returns 0 for Light | Per-node archival role |
| Consensus key in registry row | `vrf_pk` is empty. For a registration at or above height 691,200 (`LIGHT_KEY_COMMITMENT_GATE_HEIGHT`) the row's `vrf_pk_sha3` is the SHA3-256 of the wallet's ML-DSA-65 key from the transaction envelope, the key the device's ping delegation is verified against | Required: raw ML-DSA-65 public key, exactly `D3_PK_BYTES` = 1952 bytes |
| Where the registration TX comes from | Submitted by the aiqnet.io node cabinet or the browser extension with the wallet's consent and the burner's owner bind; the receiving node builds it from those fields | Server-side, by the node itself at boot |
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
The 1DEV mint is pinned per network profile in `network_config.rs`. The browser extension compiles both
mints and burns against the devnet one; the node cabinet and the mobile app compile the devnet mint only. See
[tokenomics-1dev](./tokenomics-1dev.md).

### Activation code

The Phase 1 burn is made in one of two places:

- The QNet [browser extension](../applications/browser-wallet.md) burns with the wallet's own Solana key, from
  its Activate tab or when the node cabinet at aiqnet.io/node asks it (`qnet_activateNode`,
  [QNet Link](../protocols/qnet-link-v1.md) section 10).
- The node cabinet at aiqnet.io/node burns in the browser with a one-time payment key it creates there, for a Light
  node only and for the wallet QNet Wallet confirms first: before the page shows the payment address, QNet Wallet
  signs the wallet's reservation of that light node, paid from that address (a QNet Link `reserve` request,
  [QNet Link](../protocols/qnet-link-v1.md) section 14). The key is non-extractable and signs only the burn of exactly
  the activation amount, under that wallet's reservation (below); the owner bind v2 naming that wallet's light node
  and the burn, right after the burn is signed and before it is sent; and the refund of what is left, to one Solana
  address: the wallet's own when the extension or QNet Wallet shared it, else one the user enters. Before a burn the
  key lives at most 24 hours in the same browser: then the cabinet sends the 1DEV and SOL that arrived back and
  deletes it; on testnet, test tokens go back only when the page knows the wallet's Solana address, and otherwise
  stay on the payment address. After a burn the key is kept only to send back what is left, once the network records
  the node or at once when the user asks: the burn is the wallet's activation for good, and its registration is
  finished with QNet Wallet's fresh consent from any browser where the wallet is connected, with no payment key;
  burned 1DEV never comes back. On mainnet a payment address with nothing on it keeps its key until the user deletes
  it, in case a transfer to it is still on its way.

Either reads the price from `GET /api/v1/activation/price`, burns that whole number of 1DEV with a
`QNET_NODE_TYPE:LIGHT` or `QNET_NODE_TYPE:SUPER` memo, and derives the code from the node type, the address the
code names, the burn signature and the amount, byte-identical to the node's generator. The code names the wallet
the burn is for: the extension's own Solana address for its burn, the wallet's QNet address for a payment-key burn
([QNet Link](../protocols/qnet-link-v1.md) section 3), which is found through the node's registration record (burn
to wallet), never through the payment key's address. A wallet gets one code. A Light node needs no code of its
own: its registration carries the burn, the wallet's consent and the owner bind ([registration
paths](#registration-paths-by-type)), and the cabinet shows the code as a receipt. A Super node needs its code:
the operator enters it on the node's server as `QNET_ACTIVATION_CODE`, with the burn's hash and amount (see
[running a node](../operators/running-a-node.md)). The [mobile wallet](../applications/mobile-wallet.md) signs
the wallet's consent to a Light registration and runs the node on its device.

### One wallet, one code

A wallet gets one activation: one burn and one code, for a Light node or a Super node, chosen once. A Light node's
burn is made by the cabinet's payment key or by the extension; a Super node's only by the extension that holds the
wallet, since the node's server runs with the same recovery phrase (the cabinet's payment key burns for Light nodes
only, and no phone activates a Super node). The cabinet, the extension and QNet Wallet keep that rule together
through the site's activation record (`applications/qnet-explorer/frontend/src/server/cabinet/activation-registry.ts`,
one row per QNet wallet in the explorer database; [block explorer](../applications/explorer.md#activation-registry)):

- **Before a burn, every source.** A client offers or builds a burn only when every source it has answered "none":
  the network (a node of either type for the wallet, `/api/v1/verify-activation` and the Light node's status), the
  site's record of the wallet, the extension when the wallet is the extension's, and the search of the wallet's own
  Solana address for an activation burn (the extension's kept search, or the site's). A source that is loading,
  locked or unreachable means no burn, and the client says which check did not answer.
- **A reservation per wallet, signed by the wallet.** The payment key and the extension sign a burn only under the
  wallet's reservation, and only the wallet itself can make one: the reservation carries the wallet's ML-DSA-65
  signature (FIPS 204 context `QNET_OFFCHAIN_MSG_v1`, inside the envelope the wallets build for aiqnet.io) over
  `QNet node reservation v1` with the wallet, the node type, the way (extension or payment), the burner and the time.
  The extension signs it with the wallet's own keys right before it burns, and the site takes it up to 10 minutes old;
  QNet Wallet signs a payment address's reservation before the address exists, and the site takes it up to 24 hours
  and 10 minutes old, the payment key's lifetime before a burn; up to 5 minutes ahead in either case. An unsigned,
  forged, stale or other wallet's reservation is refused (`invalid_proof`, `stale_proof`), so a stranger can neither
  hold a wallet nor make a burn in its name. One statement in the database takes it (`INSERT … ON CONFLICT (wallet)
  DO UPDATE … WHERE` the row is an expired reservation without a burn), so two browsers or devices racing for one
  wallet cannot both hold it. It lasts 10 minutes, and a client signs only while at least 2 minutes of it are left.
  The burn is announced under it before it is sent: the extension's with a proof made with the wallet's own keys, a
  payment key's with its owner bind v2 of the reserved wallet's light node, which the site verifies against the key of
  the wallet's signed reservation. An announced burn that Solana still does not know 10 minutes later can no longer
  land and frees the wallet.
- **A verified, permanent record.** A burn becomes the wallet's record only once Solana holds it final and valid (the
  fee payer is the burner and signed; exactly one burn of the 1DEV mint by that burner of exactly the amount; exactly
  one `QNET_NODE_TYPE:LIGHT` or `QNET_NODE_TYPE:SUPER` memo of the node type) and with a proof that it is the
  wallet's: for a burn of the extension, the wallet's ML-DSA-65 signature and the burner's Ed25519 signature over one
  message naming the wallet, the node type, the burner, the burn and the amount; for a payment key's burn, the
  wallet's signed reservation and the payment key's owner bind v2, which came with the announce. Without the wallet's
  keys nobody can make a record for it. A payment address's burn is the wallet's record as soon as it is final,
  exactly like an extension burn: nothing releases it and no second burn is possible. When the same burner has an
  older burn, that one is the code, as the extension's Recover has it.
- **Every browser and device.** The record is read by the wallet's address (`GET /api/cabinet/activation/{wallet}`),
  so any browser or device connecting the wallet shows its code and next step; the extension also answers the site
  without a window (`qnet_getActivation`).

Every way a wallet could get a burn or a code, and what closes it:

- **The extension**: its Activate tab, a request of the cabinet (`qnet_activateNode`), or the same wallet in another
  browser or profile. The extension makes every check above itself before anything is signed, then holds the
  reservation, announces the burn with the wallet's proof and only then sends it.
- **The cabinet's one-time payment address**, also from several addresses, tabs or browsers at once, or from an
  activation started again. The page offers a burn only while every source says none; the address exists only after
  QNet Wallet signed the wallet's reservation of it; the payment key signs a burn only under that wallet's reservation
  with at least 2 minutes of it left; the site forwards the burn only after it was announced under that reservation
  with the payment key's owner bind v2, and a refund carries no burn. The cabinet's one-time payment key burns for
  Light nodes only.
- **An extension reset and restored, or installed again, with the same phrase.** Its search of the phrase's Solana
  address finds the burn, and the site's record refuses a new one before the search gets there.
- **A Super node's server.** It registers with the code of an existing Super burn and the wallet's recovery phrase.
- **QNet Wallet.** It signs the wallet's reservation of a payment address's light node and the wallet's consent to a
  Light registration, and refuses both while the network or the site holds a Super node or a Super burn for the
  wallet.

Solana itself cannot refuse a burn that someone makes by hand, outside these clients. The network refuses a second
node for one burn (the burn uniqueness index), and from its one-node rule (the `wallet_one_node` gate,
[consensus](../architecture/consensus.md)) a second node of either type for one wallet: a registration is refused at
every door and at block validation when its wallet already has another node registered on chain, and a block may
not carry two registrations of one wallet. A wallet registered with both types before that rule keeps both. Before
the rule, a burn of the other type made before any node of the wallet registers is kept out by the cabinet, the
extension and the record.

A code is derived from its burn by the same algorithm on every side, and anyone can derive it from the public burn:
the extension, the cabinet and the node (at a Super node's start, from the code, the burn and the wallet's phrase)
check it; no node route hands one out.

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
   also stops a relayer swapping the key the node's liveness proofs are checked against. For a Light
   registration from the `wallet_one_node` gate the bind may also take its form without a time,
   `qnet_burn_owner_v2:{node_id}:{wallet}:{registration_proof}:{attest_root_tag}:{burn_tx}`: the cabinet's
   payment key signs it once, when the burn is made, and the registration is finished later with a fresh
   consent of the wallet.
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
`(cost, actual_burned)` pair. The observed burn is net destruction on the 1DEV mint: the decreases
across the transaction's token balances less any increase that is retained, an increase on the
incinerator account not counting as retained, so tokens moved between two accounts of one owner net
to zero. The transaction must also carry a burn indicator — a parsed `burn` or `burnChecked`
instruction, or the incinerator among its account keys; a plain transfer to any other destination
does not qualify. Each attestor also persists a one-burn-to-one-node dedup keyed on the
node pseudonym and refuses to re-attest the same burn for a different node. Attestor eligibility is
committee-wide: the set is the deterministic consensus committee of `attest_epoch`, falling back to
the five genesis nodes only in the genesis era, so attestation decentralises as the network grows.
First-sight Solana lookups are metered per burner and per node; each committee caller (a member's submit
door) spends its own share of them, so a flood of burns that do not exist, pushed through one door, never
starves the others. The collector (a submit door or a super node's own registration) counts an answer only
from the member it asked, once, with a signature that verifies under that member's committed key (the
binary-pinned key for a genesis node) over the message the registration will carry, exactly as block
validation counts it: a member answering with a junk signature or under another member's id spends only its
own vote. A submit door asks its own attestor in-process first and the other members only once that burn
has verified there, and a door and a super node's driver pool the registration only after it passes the same
judge the producer and block validation run, at the next height.

## Phase 2: native QNC activation

In Phase 2 the activation payment is native QNC, debited from the payer on the QNet chain. Phase 2
pricing is type-differentiated.

| Node type | Base cost | Chain floor constant | Chain floor |
| --- | --- | --- | --- |
| Light | 10,000 QNC | `PHASE2_LIGHT_MIN_NANO` | 5,000 QNC |
| Super | 7,500 QNC | `PHASE2_SUPER_MIN_NANO` | 3,750 QNC |

A network-size multiplier is applied to the base cost when a price is quoted:

| Registered nodes | Multiplier |
| --- | --- |
| ≤ 100,000 | 0.5 |
| ≤ 300,000 | 1.0 |
| ≤ 1,000,000 | 2.0 |
| > 1,000,000 | 3.0 |

The chain floors are `base × 0.5`, the minimum over that table, because the discount tier covers the
whole early-network era; a floor set at the base would reject honestly-priced activations. The
multiplier itself is a quoting rule rather than a chain rule — it reads the chain-confirmed
registered-node count (`registered_node_count`, the sum of the registry's per-index-space counters),
which each node refreshes periodically into `GLOBAL_REGISTERED_NODES`, so its value depends on when
that node last refreshed, and a consensus rule cannot read such a value. Amounts are converted from whole QNC to nanoQNC at
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
`NodeActivation`, `NodeReactivation`, `PingAttestation`, `PingCommitmentWithSampling`,
`HeartbeatCommitment`, `Heartbeat`, `LightNodeEligibilityBitmap`, `RewardDistribution`, `KeyRotation`
and both equivocation proofs, and `gas_debit()` returns 0 for all of them.

Mempool dedup keys enforce one-shot semantics:

| Transaction | Dedup key | Meaning |
| --- | --- | --- |
| `NodeRegistration` | `(node_id, 0, 4)` | one-shot for the chain's lifetime |
| `NodeActivation` | `(from, phase_id, 6)` | one-shot per (wallet, phase), `phase_id` ∈ {1, 2} |
| `NodeReactivation` | `(node_id, last_macroblock_index, 5)` | one per macroblock epoch (90 blocks) |

A key included in a block stays marked in the mempool for three reward epochs (43,200 blocks) from its
inclusion height; marks are pruned by that age once per 1,440 blocks. The RPC and gossip doors also ask the
state: a commitment it already records is refused, an activation from a wallet that is already a node
included. State apply additionally rejects a duplicate `NodeRegistration` when
`is_node_registered(node_id)` is already true; after a snapshot restore that record is rebuilt from the
registrations stamped at or below the restored height.

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
driver. A Light registration is submitted through `POST /api/v1/node-registration/submit`, which rejects
any node type other than `light` and requires `from == wallet_address`:

- by the node cabinet after its payment key's burn, with the wallet's consent that QNet Wallet signed on its
  link sheet ([QNet Link](../protocols/qnet-link-v1.md) section 14) and the owner bind v2 the payment key signed
  when it burned, which the site keeps with the wallet's record and adds to the consent, from any browser where
  the wallet is connected;
- or by the browser extension after its own burn, with both signed by the extension.

The messages are in [light node messages](../protocols/light-node-messages.md) section 4. The submit endpoint
checks from the request alone that the node id is the wallet's pseudonym, that the owner bind verifies under
the burning Solana key, that the wallet derives from the consent's ML-DSA-65 key (whose consent must then
verify) or from the burning address, that the consent time is inside its window (up to 24 hours old), and that
`burn_tx_hash` (a base58 Solana signature) and a non-zero `burn_amount` are present and match the proof the
consent signed. A sound owner bind v2 before the `wallet_one_node` gate, on a submit that passes every other
check, is refused retryably (`bind_v2_pending`); the node lists `owner_bind_v2` once it takes that form. It
then gathers the committee's burn attestations itself and refuses retryably, arming nothing, while its tip
trails the corroborated head by more than `DEFICIT_BOUND` (45 blocks), while it cannot read the attest epoch's
committee, while fewer than a quorum have attested, or while the gathered registration does not pass block
validation's judge at the next height. It serves requests with no `Origin` header and those from aiqnet.io,
its sandbox and the browser extension; any other web page gets 403. The node runs on one device,
linked separately through `POST /api/v1/light-node/bind` (light node messages sections 4 and 5). See
[mobile wallet](../applications/mobile-wallet.md) and the [RPC reference](../developers/rpc-api.md).
Light-node reward eligibility is separately committed
on-chain through a `LightNodeEligibilityBitmap` transaction, at most one per shard and owner per epoch, with a shard's owner rows bit-ORed, indexed
by each node's permanent registration index; a light node's first push falls in a randomized per-window
slot among the first 138 of 240, with repeats 15 and 30 slots later and a retry round of the same shape an
hour after the first, each only while the node is not counted, so the last push and its answer end before
the commit window opens (light node messages section 5.10). A registration stamped below
`epoch_start + 14_250`, when the commit window opens, joins that epoch's reward roster, including the
node's own registration epoch; one stamped in the closing 150 blocks joins from the next epoch. See
[economics overview](./overview.md).

## One node per payment, and device rules

- **One wallet, one node.** From the `wallet_one_node` gate the network refuses a registration of either
  type for a wallet that already has another node registered on chain, at every door (`wallet_has_node`) and
  at block validation. The extension refuses a second burn when its vault already holds an activation, when
  the wallet's Solana history already contains a valid activation burn, when `/api/v1/verify-activation`
  reports a node for the wallet, or when the site's activation record names a burn or a reservation of it
  ([one wallet, one code](#one-wallet-one-code)). Code generation is deterministic from the burn, so the same burn always gives the
  identical code — that is the recovery path: "Recover my code" in the extension re-derives the code of the
  wallet's oldest valid burn, and the node cabinet shows the code from the site's record of the wallet in any
  browser, or from the wallet's registration record.
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
- **One device per Light node.** A Light node runs on one phone or tablet at a time, bound to a hardware
  key of one app install; one device runs one node, never several devices at once. "Use this device" (or the link
  sheet) on another device replaces the binding, and the earlier device stops. The binding goes to
  `POST /api/v1/light-node/bind` at the node's shard owners, signed by the wallet key (delegation and attach) with a
  sequence that must beat the stored one, and carries the device's enrolment ([light node
  messages](../protocols/light-node-messages.md) sections 4, 5 and 8). The node is counted only while QNet Wallet
  runs on that device (open, in the background or behind the lock screen) and answers the network. The device leaves
  the node when another device takes it over, when it unlinks itself, or, once the genesis nodes list `unbind_wallet`,
  when the wallet unlinks it with its own key from any device (the node cabinet's "Unlink the device"); the node and
  its balance stay with the wallet. Everything here is self-service: the node moves to another device, with no review
  step.
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
