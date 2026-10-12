# GALC v2 capsule

Status: normative, version 2. The client side ships in the QNet Wallet app and the QNet Wallet browser extension (one
implementation, `applications/qnet-mobile/src/crypto/QcLightClient.js`, compiled into the extension's
`dist/lib/qnet-core.js`); the node side (mint and HTTP route) comes with a later node release. Until then every node
answers `GET /api/v1/galc/capsule` with 405 and the clients behave exactly as without capsules. Test vectors:
[`galc-capsule-v2.vectors.json`](galc-capsule-v2.vectors.json), produced by
[`tools/galc-capsule-v2-vectors.mjs`](tools/galc-capsule-v2-vectors.mjs) (section 8). MUST, MUST NOT, SHOULD and MAY are
used as in RFC 2119.

## 1. Purpose

A light client proves a balance by walking the committee lineage of QNet Blockchain from a trusted macroblock up to the
certified head: macroblock j is verified with the committee derived from the verified macroblock j-2 and with keys
bound to its `registry_root`. The walk starts at the build's pin (`WS_CHECKPOINT` in
`applications/qnet-mobile/src/config/genesisConsensus.js`), and each day of pin age adds 480 steps per parity.

A capsule is a small object signed by at least four of the five embedded genesis consensus keys that names a recent
macroblock K and the checkpoint hashes of K and K-1. A client that verifies it can root its walk at K and K-1, a few
steps below the head, at any pin age.

GALC v1 (the nodes' capsule, `development/qnet-integration/src/galc.rs`) cannot root a wallet: it signs
`MacroBlock::hash` and the committee field digests, not `registry_root`, and a wallet binds the committee keys of step
K+2 to `registry_root(K)`. Version 2 signs `Checkpoint::hash` of K and K-1, which folds `registry_root`, `state_root`,
`logs_root`, `beacon`, `epoch_commitment`, `reward_root`, `reward_epoch_root` and the window's block hashes.

## 2. The capsule

| Field | Type | Value |
| --- | --- | --- |
| `version` | u16 | 2 |
| `network_id` | 32 bytes | the hash of block 0 (`NETWORK_ID`, section 7.8) |
| `mb_index` | u64 | K, a multiple of `GALC_V2_MINT_INTERVAL` (10), at least 2 |
| `mb_hash` | 32 bytes | `MacroBlock::hash` of K |
| `committee_digest_anchor` | 32 bytes | `committee_fields_digest` of K (as in v1) |
| `committee_digest_pred` | 32 bytes | `committee_fields_digest` of K-1 |
| `minted_at_height` | u64 | K × 90 |
| `cp_hash_anchor` | 32 bytes | `Checkpoint::hash` of K's certified checkpoint (cpA) |
| `cp_hash_pred` | 32 bytes | `Checkpoint::hash` of K-1's certified checkpoint (cpP) |
| `sigs` | list of [id, signature] | 4 or 5 genesis signatures over the preimage (section 4) |

The JSON form (the HTTP body, the form clients keep) writes the 32-byte fields as lowercase hex, the integers as JSON
numbers and `sigs` as a list of two-element lists:

```json
{
  "version": 2,
  "network_id": "e5dbb7429eca37d346e9c41113403520fca83f354d6ce160cf57e06d9a92241f",
  "mb_index": 39060,
  "mb_hash": "…",
  "committee_digest_anchor": "…",
  "committee_digest_pred": "…",
  "minted_at_height": 3515400,
  "cp_hash_anchor": "…",
  "cp_hash_pred": "…",
  "sigs": [["genesis_node_001", "dilithium_sig_genesis_node_001_…"], ["genesis_node_003", "dilithium_sig_genesis_node_003_…"]]
}
```

A body larger than 64 KiB is refused unread.

## 3. Preimage

The genesis keys sign the UTF-8 text

```
QNET_GENESIS_CHECKPOINT_v2:2:<network_id>:<K>:<mb_hash>:<committee_digest_anchor>:<committee_digest_pred>:<minted_at_height>:<cp_hash_anchor>:<cp_hash_pred>
```

with integers in decimal without leading zeros and hashes in lowercase hex. A verifier builds the preimage itself from
the fields; nothing in a signature is taken as the message.

## 4. Signatures

- Each signature is a consensus signature string as the nodes write them: `dilithium_sig_<id>_` followed by the
  standard base64 of `[u32 LE length][ML-DSA-65 signature, 3309 bytes][the preimage][u32 LE 1952][public key]`. The
  signature is pure ML-DSA-65 (FIPS 204) with an empty context.
- Keys come only from the embedded genesis set (`GENESIS_CONSENSUS_PKS`, five keys). A signer that is not a genesis node
  counts for nothing.
- The id inside the string MUST equal the id it is listed under.
- At least `quorum_size(5)` = 4 distinct genesis ids MUST carry a valid signature; an id listed twice counts once.
- The HTTP body MAY drop the key trailer (`[u32 LE 1952][public key]`): clients verify against the embedded key and
  ignore a trailer. The stored and P2P forms keep it, since node verification checks it.

## 5. Node side (the node release)

This is a node release, not a block rule: no consensus field changes, and v1 stays as it is.

1. **Type.** A separate `GenesisCheckpointV2` with the fields of section 2 and the domain `QNET_GENESIS_CHECKPOINT_v2`.
   The v1 struct gets no fields: its bincode is read on disk, at boot, at rollback and over P2P.
2. **State.** v2 keeps its own partial signatures, held capsule, last minted index and monotonic index. It never raises
   `GALC_MB` and never calls `adopt_verified`, so v1 minting and v1 roots are unaffected.
3. **Cadence.** `GALC_V2_MINT_INTERVAL` = 10 macroblocks; K = (finalized macroblock / 10) × 10. `GALC_MINT_INTERVAL`
   (40, tied to the snapshot cadence) does not change.
4. **Mint.** A genesis node signs K only when the `checkpoint_qc` of K and of K-1 decode, `cp.hash() ==
   qc.checkpoint_hash` for each, `window_head_height == K × 90` and neither checkpoint carries a `recovery_anchor`. It
   broadcasts `GenesisCheckpointSig { version: 2, … }` with the v1 fields; a receiver recomputes cpA and cpP from its
   own K and K-1. Nodes without v2 drop version 2.
5. **Receive.** A cheap filter first: the sender is a genesis node, `K % 10 == 0`, K is at most one above the node's own
   finalized macroblock and above its v2 index. Then cpA and cpP are recomputed, the signature verified and the partial
   aggregated. Partials for a K not stored yet wait in a bounded buffer (newest K, at most 5) and are retried on the
   15-second tick.
6. **Persistence.** The assembled capsule is stored under `galc_v2_held` on every assembly path, P2P included, and is
   reloaded and verified again at boot.
7. **Rollback.** A rollback below K deletes `galc_v2_held` and clears the v1 and v2 holders in memory.
8. **Transport.** P2P serving stays v1; v2 travels over HTTP only.

## 6. HTTP route: `GET /api/v1/galc/capsule`

| Answer | When |
| --- | --- |
| 200, the JSON of section 2 | the node holds a v2 capsule whose K decodes, on the node, to a checkpoint hashing to cpA, with K at most its finalized macroblock |
| 404 `{"error": "no_capsule"}` | no capsule yet |
| 503 `{"error": "capsule_unbound"}` | the self-check above fails (after a rollback, for example) |
| 405 | a node from before this release |

The serialized body is cached by (K, cpA) with `Cache-Control: public, max-age=60` and the ETag `"2-<K>-<first 8 hex of
cpA>"`. The route has its own rate-limit bucket and is a light route of the wallet plane. With four compact signatures
the body is about 31 KB.

## 7. Client rules

### 7.1 Cheap checks

Before any ML-DSA verification, in this order (the reason each refusal is named by in the client and the vectors):

| Check | Reason |
| --- | --- |
| a JSON object | `shape` |
| `version == 2` | `version` |
| `network_id == NETWORK_ID` | `network_id` |
| K is a whole number of at least 2 | `index` |
| `K % GALC_V2_MINT_INTERVAL == 0` | `interval` |
| `minted_at_height == K × 90` | `minted_at_height` |
| the five hashes are lowercase hex of 32 bytes | `shape` |
| 4 or 5 entries in `sigs` | `signature_count` |
| each entry is [string, string] | `shape` |
| K above the build's pin | `below_pin` |
| K at most the certified head + 2 | `above_head` |

The certified head is `certifiedHeadHint`: the second highest of the genesis nodes' certified frontiers, at least three
answering. A kept capsule (section 7.7) is checked without the head.

### 7.2 Signatures

As section 4, with the preimage built by the client and the keys of the build. Fewer than 4 valid distinct genesis ids:
`signatures` (the network fetch reports it as `invalid`).

### 7.3 Roots K and K-1

For j = K with cpA and j = K-1 with cpP, the client fetches `GET /api/v1/macroblock/<j>/proof` from two distinct nodes at
a time, in the order its caller names, and confirms j once two nodes served a proof that passes all of:

- the proof's fields have the types the walk reads, every 32-byte hash of the checkpoint (its roots, the parent and
  recovery hashes, the window's block hashes) is lowercase hex and `eligible_raw` is hex, and `committee` is a list of
  strings (`root_shape`): the checkpoint hash decodes hex in any case, so another spelling would hash the same;
- `index == j` and `window_head_height / 90 == j`;
- `checkpointHash(checkpoint)` equals cpA (cpP);
- the checkpoint carries no `recovery_anchor` (refused as every node refuses it: `recovery_anchor`);
- `epochCommitment(eligible_raw, committee, banned) == checkpoint.epoch_commitment`;
- `eligible_raw` decodes to a non-empty set.

Two nodes whose proofs of j hash to other checkpoints drop the capsule (`conflict`) and no node is blamed; one such node
is not enough. Too few confirming answers leave the capsule unused for now (`unrooted`). The verified entries of K and
K-1 are built as for any walk step: `stateRoot`, `logsRoot`, `checkpointHash`, the eligible set, `beacon`,
`registryRoot`, `timestamp`, the window's block hashes, `rewardRoot` and `rewardEpochRoot`.

### 7.4 The held capsule

- One capsule is held, apart from the cache of verified macroblocks: it is not evicted by that cache's bound and not
  dropped when anchors kept from an earlier session prove to be another lineage's.
- It is replaced only by a capsule with a higher K.
- A capsule naming a checkpoint other than one the device verified (or kept with its roots) for K or K-1 is refused; a
  held one is dropped when a walk later verifies another checkpoint at K or K-1, or when two nodes refuse the first step
  above its root for what ties that step to the root (its committee's signatures, its keys, its registry). Dropping
  costs a longer walk, never trust, and the same capsule is not taken again for 10 minutes.
- A rewind of the chain (the pinned nodes serve another chain) clears it (`clearCapsule`).
- K and K-1 answer state and log queries at their own index. The trust floor stays at the pin + 1, so log proofs
  between the pin and K keep verifying by the walk from the pin.

### 7.5 The walk root

A walk to j starts at the highest anchor below j on j's parity chain. The capsule's root (K or K-1) is used only when it
is higher than the device's own anchor (a macroblock verified now or kept from an earlier session, or the pin) and the
walk from the device's own anchor would take more than 16 steps (`OWN_ROOT_WALK_STEPS`). A device that keeps following
the head walks by committee signatures from what it verified; the capsule shortens long walks. From a capsule the walk
to the head takes at most ⌈10 / 2⌉ + 1 = 6 steps per parity.

### 7.6 Fetching

- Two nodes are asked at once (the genesis names); the highest K that passes sections 7.1 to 7.3 is taken: an offer
  whose roots cannot be confirmed now leaves the next one.
- A node answering 404 or 405, an oversized or refused capsule, or none newer than the held one is not asked again for
  10 minutes (`CAPSULE_MISS_TTL_MS`): probing costs at most one request per node per 10 minutes. A node that did not
  answer (timeout, server error) waits 60 seconds. A rate-limit answer only pauses that node.
- No request is made while no newer capsule can exist (certified head below the held K + 10), or while the walk from
  the device's own anchors to the head is 16 steps or shorter on both parities.
- With no capsule every walk, proof and badge is exactly what it is without capsules.

### 7.7 Keeping a capsule

`exportCapsule()` gives `{ capsule, roots }`: the capsule's JSON and, for K and K-1, the parts of the proof that bind it
(`index`, `checkpoint` with the fields its hash reads only, `eligible_raw`, `committee`, `banned`). The record needs no integrity protection:
`importCapsule()` verifies it again with no network (section 7.1 without the head, section 7.2, and section 7.3's
checks on the kept parts). A wallet keeps it under its chain identity.

### 7.8 Network identity

`NETWORK_ID` is the hash of block 0 as `GET /api/v1/blocks/headers?from=0&limit=1` serves it (never `/block/0`, tens of
MB); `scripts/ws-pin.js` writes it in the pin block, with every answering genesis node agreeing, and refuses a block 0
other than the committed one when it proves a new pin. `chainIdentity()` folds it in, so records a wallet sealed under
a build without it are dropped once, and a capsule or an anchor of another chain is never taken for this one's.

## 8. Test vectors

[`galc-capsule-v2.vectors.json`](galc-capsule-v2.vectors.json) holds:

- `keys`: five genesis keys and one outsider key, all **test keys** (ML-DSA-65 key generation from SHA3-256 of
  `qnet-galc-capsule-v2/test-key/<id>`). No capsule in the file verifies under the keys QNet Blockchain embeds, and its
  `networkId` is a label, not the hash of block 0.
- `roots`: the proof parts of K = 38960 and K-1, with `checkpointHashes` and `epochCommitments`.
- `preimages`: fields and the exact preimage text.
- `capsule`: the accepted capsule in its wire form.
- `signatures` and `cases`: each case lists its capsule's fields and its signatures by name, the head it is judged
  against, its stage (`accepted`, `checks`, `signatures`, `roots`) and the expected outcome (`accepted` or the reason of
  section 7). A case with `httpOnly` uses the compact signature form, which only the HTTP body may carry.

`node docs/protocols/tools/galc-capsule-v2-vectors.mjs --check` exits 1 when the file differs from a fresh run; the
generator judges every case with an implementation of the rules of its own. The app's `__tests__/GalcCapsule.test.js`
checks the file against the client.
