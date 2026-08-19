# Cryptography

This document describes the cryptographic primitives the QNet node runs: the post-quantum signature
scheme used end-to-end, key derivation from an operator's mnemonic, how the on-chain address binds to
a signing key, which hash function is used where, the domain separation strings that keep those uses
from colliding, the three accumulator constructions behind the chain's commitments, and transport
security.

## Signature scheme

There is one signature primitive on every signing path: **ML-DSA-65** (CRYSTALS-Dilithium3,
FIPS 204), through the `pqcrypto-mldsa` crate's `mldsa65` module, aliased as `dilithium3` at call
sites (`core/qnet-consensus/src/consensus_crypto.rs`). Key generation uses the `fips204` crate's
deterministic `keygen_from_seed`; signing and verification always use the `pqcrypto-mldsa` path.
A fail-closed startup self-test proves the two backends are byte-compatible, asserts the parameter
sizes, runs a tampered-message negative control, and calls `std::process::exit(3)` on any failure.

| Parameter | Value | Constant |
| --- | --- | --- |
| Public key | 1952 bytes | `MLDSA65_PK_LEN`, `D3_PK_BYTES` |
| Secret key | 4032 bytes | `MLDSA65_SK_LEN`, `D3_SK_BYTES` |
| Detached signature | 3309 bytes | `D3_SIG_BYTES` |

These sizes are enforced, not merely documented: consensus verification rejects any embedded public
key whose length is not exactly `dilithium3::public_key_bytes()`, and value-transaction verification
requires a signature of exactly 3309 bytes with a public key of exactly 1952 bytes. ML-DSA-65 signs
microblocks; checkpoint votes, view-change timeouts and every quorum-certificate or
timeout-certificate signer slot (see [consensus](consensus.md)); all value-class and all system
transactions; VRF proofs; the QUIC peer-identity handshake proof; and ephemeral `PqCertificate`s.

**Per-signature verification.** A certificate carrying up to 1000 signer slots opens each signature
individually. Certificate verification is parallelised with `rayon` and dispatched off the consensus
loop under a semaphore of 2 concurrent verifies.

**Structural pre-checks.** Before the ML-DSA math runs, a candidate signature is rejected if it is
all zeros, or if the first 3309 bytes contain fewer than 200 distinct byte values.

**Verification finish.** Envelope verification calls `dilithium3::open()` on a `SignedMessage`, then
compares the recovered message against the expected bytes with a constant-time helper (`ct_eq`) whose
length-mismatch branch still walks the full length to avoid a length-timing leak. Raw detached paths
call `verify_detached_signature` directly.

## Key derivation and node identity

Identity is a pure function of the operator's BIP-39 mnemonic. Keys are **never randomly generated
and never written to disk**. Two *independent* ML-DSA-65 keypairs are derived from the same BIP-39
64-byte seed on two distinct domains.

| Key | KeyGen seed `xi` | Used for |
| --- | --- | --- |
| Consensus / block-signing key | `SHA3-256(XI_DOMAIN \|\| bip39_seed64)` | block signatures, consensus messages, VRF, handshake proofs |
| Wallet key | `SHAKE-256("QNET_WALLET_MLDSA65_v1:" \|\| hex(bip39_seed64))` truncated to 32 bytes | the on-chain EON address and value transactions |

where `XI_DOMAIN = "QNet/ML-DSA-65/consensus-identity/v1"`. Both seeds feed
`ml_dsa_65::KG::keygen_from_seed(xi)`, producing standard FIPS 204 encodings. The **wallet** key
determines the account address: `WalletIdentity::derive_wallet_address` derives it from the wallet
public key.

The SHAKE-256 wallet path is byte-identical to the mobile client's native `derive_seed_from_string`,
so node, mobile wallet and browser extension derive the same keypair — and therefore the same
address — from the same mnemonic. A cross-client known-answer test in
`development/qnet-integration/src/crypto/genesis_key.rs` pins the seed, the public-key digest and the
resulting address for the standard all-`abandon` test mnemonic.

**Fail-closed derivation.** `DilithiumKeyManager::get_keypair` returns `identity_not_installed` on a
process-cache miss. The canonical install happens once, via `get_keypair_from_mnemonic` called from
`initialize_wallet_identity`. There is no keyfile to back up: a wiped node re-derives the identical
identity from the mnemonic. Secret-key buffers are zeroized on drop through `write_volatile` plus
`black_box` in `ZeroizingVec`, `DilithiumVrf`, `WalletIdentity` and `CachedKey`.

## Address format

An account address ("EON address") is 45 characters and is derived from the raw wallet public key:

```
sha512_hex = hex(SHA-512(raw 1952-byte ML-DSA-65 wallet public key))
body       = sha512_hex[0..19] + "eon" + sha512_hex[19..34]
address    = body + hex(SHA3-256(body))[0..8]
```

So: 19 hex characters, the literal string `eon`, 15 hex characters, and an 8-hex-character SHA3-256
checksum over the body. This is the only place raw SHA-512 is used as a hash function; SHA-512 also
appears as the PRF inside BIP-39's PBKDF2 and SLIP-10's HMAC chain (see the hash table below).

Because the address commits to the public key, **the address is the address-to-key binding**. Value
transaction verification enforces `eon_from_qnet_dilithium_pubkey_bytes(pk) == tx.from` on every
verification path — gossip admission, RPC submission, block validation and producer-local checks —
preventing a Byzantine producer from including a transfer signed by an attacker key over a victim's
canonical message. It is also why the public key is *elidable* on the wire: it appears only on an
address's first on-chain transaction and is rehydrated from committed account state afterwards. The
public key is excluded from `Transaction::canonical_bytes`, so an elided transaction hashes
identically to its first-use form. The same formatter also derives an address from an external-chain
account (`SHA-512(address_string + "qnet-eon-bridge")`); see
[1DEV tokenomics](../economics/tokenomics-1dev.md).

## Consensus signature envelopes and identity binding

The base wire format produced by `create_consensus_signature` is:

```
dilithium_sig_<signer_id>_<base64(combined)>
combined = [signed_msg_len u32 LE][SignedMessage][pk_len u32 LE][public_key 1952]
```

`verify_consensus_signature` dispatches on prefix and rejects anything else as
`unknown_signature_format`. Accepted signature strings must be between 100 and 18000 characters.

| Prefix | Encoding | Notes |
| --- | --- | --- |
| `compact_bin:` | bincode + zstd | production compact form |
| `compact:` | JSON | JSON form of the compact envelope |
| `pq_bin:` | bincode + zstd | with embedded certificate |
| `pq:` | JSON | parse-only |
| `dilithium_sig_` | raw base64 | base format above |
| `pq_p2p_bin:` / `pq_p2p:` | bincode + zstd / JSON | handled only in the P2P layer, which decodes and re-routes into the consensus verifier |

All envelope forms verify a re-rooted preimage `hex(message_hash || signed_at.to_le_bytes())`, where
`message_hash` is SHA3-256 of the message bytes (or the message itself when it is already a hash).
zstd decompression of `compact_bin:` payloads is bounded at `MAX_COMPACT_BIN_DECOMPRESSED` = 256 KiB.
Two verification regimes exist with **different trust roots**:

- **Gossip-level** (`verify_consensus_signature`) consults an in-RAM public-key registry with three
  tiers. Tier 1, the registry holds this `node_id` bound to this key, proceeds to the math. Tier 2,
  the registry holds a *different* key, rejects the message and takes no further action against the
  presented key. Tier 3, no binding at all, hard-rejects `genesis_node_*` identities — their keys
  are pinned from embedded constants at startup; other identities are admitted
  trust-on-first-verify, with the signature math as the gate.
- **Certificate-level** (`verify_consensus_signature_bound`, `verify_consensus_signature_compact`)
  resolves the key from consensus state, never from the registry. The caller supplies an
  `expected_pk` taken from committed on-chain state (`storage.load_vrf_public_key`) or from the
  binary-pinned genesis anchor, and the embedded key must byte-match it before the math runs.

A committed VRF public key is additionally cross-checked against the registry-root-covered commitment
`vrf_pk_sha3` (SHA3-256 of the key) before it may authenticate a consensus message. Quorum-certificate
votes are stored public-key-stripped: `strip_embedded_pk` drops the trailing `[pk_len][pk]` and the
verifier re-supplies the key from committee state, so every node produces byte-identical certificate
bytes. Registry and anchor parameters:

| Parameter | Value |
| --- | --- |
| `DEFAULT_PK_REGISTRY_CAP` / `MAX_PK_REGISTRY_CAP_HARD` | 1,000,000 entries; `QNET_PK_REGISTRY_CAP` clamped to the same hard bound |
| `DEFAULT_IDLE_THRESHOLD_SECS` | 2,592,000 s (30 days); override `QNET_PK_REGISTRY_IDLE_DAYS` |
| `PK_REGISTER_CHALLENGE_PREFIX` | `qnet-pk-register-v1:` |
| Genesis anchors | five 1952-byte public keys compiled into the binary as `GENESIS_CONSENSUS_PKS` |
| `ATTACKER_PK_BLACKLIST_CAP` | 12,288 entries, oldest 25% evicted at cap |

Post-genesis proof-of-ownership registration requires an ML-DSA-65 signature over
`qnet-pk-register-v1:{node_id}`. Registry entries are immutable for the process lifetime:
re-registering a `node_id` under a different key is rejected; the same key is an idempotent no-op.
`register_genesis_pk` refuses any key that does not byte-match its anchor and pins the entry so it is
never idle-evicted. The attacker-key blacklist feeds telemetry and peer selection. Ephemeral
`PqCertificate`s are self-signed with ML-DSA-65 over `node_id || issued_at_le`, have a
`CERTIFICATE_LIFETIME_SECS` of 270 s with rotation at 80% of that, and are accepted within a
`CERTIFICATE_GRACE_PERIOD_SECS` of 60 s past expiry. Each certificate is verified independently
against its issuer's key. The certificate cache holds `MAX_CERTIFICATE_CACHE_SIZE` = 50,000 entries,
evicting the oldest 10%.

## Domain separation

Every hash that feeds a signature or a commitment is prefixed with a literal tag, so a preimage valid
in one context can never be replayed as a valid preimage in another. The main inventory:

| Tag | Where |
| --- | --- |
| `Block_Sig_v23.1` | microblock producer signing digest |
| `pkdg2` | per-block digest of transaction wire public keys / signatures |
| `qnet-checkpoint-v2` | `Checkpoint::hash()` |
| `QNET_BFT2_VOTE:` / `QNET_BFT2_TMO:` / `QNET_BFT2_CKPT:` | checkpoint vote, view-change timeout and checkpoint-proposal signing strings |
| `qnet-timeout-v2` | timeout signing body prefix (the driver's timeout bytes) |
| `QNET_TIMEOUT_V2:` / `QNET_TIMEOUT_V2R:` | P2P failover `TimeoutVote` preimage, unanchored / anchored — distinct from the driver prefix above |
| `leaf` / `node` | quorum-certificate signature merkle tree |
| `log-leaf` / `log-node`, `logw-leaf` / `logw-node` | event-log tree, level 1 and window level 2 |
| `qnet-registry-root-v2`, `qnet-registry-row-v4`, `qnet-dpk-row-v1`, `qnet-reward-epoch-root-v1` | LtHash digests and row seeds |
| `QNet_VRF_v7_OUTPUT` / `QNet_VRF_v7_PROOF`, `QNet_VRF_SlotSeed_v4`, `QNET_LEADER_V4.5` | VRF output and proof, slot seed, deterministic leader selection |
| `COMMITTEE_VRF_v3.36` | per-member checkpoint-committee selection score, seeded from the eligible set and beacon of macroblock `j-2` |
| `qnet-epoch-v2` | `epoch_commitment` over the eligible bytes, the derived committee and the banned list |
| `QNET_VALIDATOR_SET:` | flat digest of the node-discovery validator set served to light clients, over the epoch and the sorted per-validator fields |
| `QNET_ADDR:`, `QNET_ACCOUNT_V2:`, `QNET_STORAGE_KEY:`, `QNET_STORAGE_VAL:` | state SMT leaf positions and values |
| `qnet-pk-register-v1:` | proof-of-ownership challenge |
| `qnet-quic-handshake-v2:`, `qnet-quic-channel-binding-v1` | QUIC peer proof and TLS exporter label |
| `q{chain_id}\|` | chain tag prefixed onto every transaction sign-preimage |
| `QNET_HEARTBEAT:` | heartbeat transaction preimage (after the chain tag) |
| `QNET_HEALTH_PING_V1:` | signed health-ping preimage |
| `QNET_BLOCK_REJECTION_V1:`, `QNET_PRODUCER_READY_V1:`, `QNET_READY_ACK_V1:`, `QNET_PRODUCER_HEARTBEAT_V3:` | signed consensus-adjacent P2P messages |
| `QNet_Seed_FP_v1` | wallet seed fingerprint |
| `qnet_onchain_reg:`, `burn_attest:` | burn-owner binding and burn-attestation quorum messages |
| `QNET_SECRET_INTEGRITY_V1`, `QNET_DB_ENCRYPTION_V1`, `qnet-light-challenge-secret-v1` | key-file integrity tag, database key derivation, light-client RPC challenge MAC |

Transaction signing preimages are type-tagged ASCII strings, and every one of them is prefixed with
the chain tag `q{QNET_CHAIN_ID}|` (`q1337|` on testnet). `build_canonical_verify_message` selects the
body per transaction class and `chain_bind` applies the tag once at that function's single exit
point, so no class can be left unbound and signer and verifier — node, mobile wallet, browser
extension — reconstruct the same bytes. The bodies, each carrying the tag in front:

| Transaction class | Canonical message body |
| --- | --- |
| `Transfer` | `transfer:{from}:{to}:{amount}:{nonce}:{gas_price}:{gas_limit}` |
| `BatchTransfers` | `batch_transfer:{from}:{total_amount}:{count}:{batch_id}` |
| `ContractDeploy` | `contract_deploy:{from}:{code_hash}:{nonce}`, `code_hash` read from the `tx.data` JSON |
| `ContractCall` | `contract_call:{from}:{hex(SHA3-256(raw tx.data))}:{nonce}` |
| `NodeRegistration`, client-signed | `client_node_reg:{node_id}:{wallet}:{registration_proof}:{timestamp}`, with `:{hex(SHA3-256(vrf_pk))}:{api_endpoint}` appended for a Super |
| `NodeRegistration`, node-signed | `node_reg_v2:{from}\|{to}\|{amount}\|{nonce}\|{gas_price}\|{gas_limit}\|{timestamp}\|{node_id}\|{wallet_address}\|{node_type}` |
| `NodeActivation` | `node_act_v2:{from}\|{to}\|{amount}\|{nonce}\|{gas_price}\|{gas_limit}\|{timestamp}\|{node_type}\|{payload_amount}\|{phase}` |
| `NodeReactivation` | `node_reactivation:{node_id}:{timestamp}:{api_endpoint}:{current_height}:{last_macroblock_hash}:{last_macroblock_index}` |
| `Heartbeat` | `QNET_HEARTBEAT:{node_id}:{anchor_height}:{anchor_hash}` |
| `LightNodeEligibilityBitmap` | `light_bitmap:{genesis_id}:{epoch}:{index_span}:{eligible_count}:{hex(SHA3-256(bitmap_compressed))}` |
| every other class, including `HeartbeatCommitment` and `PingCommitmentWithSampling` | `{from}\|{to}\|{amount}\|{nonce}\|{gas_price}\|{gas_limit}\|{timestamp}` |

`ContractCall` hashes the literal calldata rather than a re-serialised parse, so number formatting
and key order cannot diverge between implementations. The registration and reactivation bodies carry
the announced `api_endpoint` inside the signature, and a reactivation additionally binds its height
and macroblock fields: the transaction hash is not signed, so binding them is what stops a relayer
rewriting the address that gets committed as the node's — or the epoch its apply dedup keys on. The
consensus-relevant payload fields of an activation — node type, payload amount and phase — are inside
the body for the same reason. See [state and transactions](state.md).

`QNET_CHAIN_ID` is a compile-time constant in `core/qnet-state/src/transaction.rs`, never read from
the environment: two nodes disagreeing on it would compute different preimages and partition. It is
also carried in the `chain_id` transaction field, which is inside `canonical_bytes()` and therefore
inside the transaction hash, and `Transaction::validate()` rejects any other value on both the RPC
and the gossip ingress path. Because the tag is inside the signature as well as the hash, the field
cannot be rewritten in flight to mint a second valid hash for one signature.

## Hash functions

| Function | Used for |
| --- | --- |
| SHA3-256 | block hashes, transaction hashes, all merkle and SMT nodes, all domain-tagged digests, LtHash row seeds and committed digests, checkpoint hash, leader selection, database key derivation |
| SHA3-512 | VRF output derivation only (truncated to 32 bytes) |
| SHAKE-256 | LtHash lane expansion (2048-byte stream) and the wallet KeyGen-seed derivation |
| SHA-512 | as a raw hash, address derivation only; also the PRF inside BIP-39's PBKDF2 and the SLIP-10 `ed25519 seed` HMAC chain |
| BLAKE3 | non-consensus derivations only: node pseudonyms, device-token hashing, activation-code hashing, and a reward-shard index |
| PBKDF2-HMAC-SHA512 | BIP-39 mnemonic-to-seed only |
| PBKDF2-HMAC-SHA256 | mobile wallet secret-key encryption only |

The `sha3` crate is used for FIPS 202 SHA3-256, SHA3-512 and SHAKE-256. Transaction hashes are
`SHA3-256(bincode(canonical struct))` with `hash`, `signature`, `dilithium_signature` and
`dilithium_public_key` cleared before serialisation.

## VRF and leader selection

The VRF is a Dilithium3 construction:

```
output = SHA3-512("QNet_VRF_v7_OUTPUT" || pk || sk || input)[0..32]
proof  = ML-DSA-65 detached signature over ("QNet_VRF_v7_PROOF" || pk || input || output)
```

The output is deterministic and secret-key-bound, so a producer re-producing a height after a
rollback emits a byte-identical value. `verify_static` establishes that the producer authenticated
this `(input, output)` pair. Consensus values are derived independently of `vrf_output`: the window
beacon folds QC-signed block hashes, and `vrf_output` is excluded from `MicroBlock::hash()`.

Leader selection is fully deterministic from on-chain inputs:

```
slot_seed = SHA3-256("QNet_VRF_SlotSeed_v4" || mb_hash || round_le)
index     = SHA3-256("QNET_LEADER_V4.5" || slot_seed || height_le
                     || leadership_round_le || timeout_round_le)[0..8] as u64 mod candidates
```

## Accumulators

Three constructions coexist, with different properties and different jobs.

**Binary merkle tree** (`core/qnet-core/src/crypto/rust/merkle.rs`) — transaction and reward proofs.
Leaves are `SHA3-256(0x00 || leaf)`, internal nodes are `SHA3-256(0x01 || left || right)`, and an odd
tail is duplicated; the prefixes prevent second-preimage substitution of an internal node for a leaf.
A one-leaf tree still yields `H(0x00 || leaf)`, so it remains verifiable under the same rule.
`PARALLEL_THRESHOLD` = 10,000 leaves switches to parallel hashing; reward-tree sharding
(`shard_subtree_root`, `merkle_continue_root`) is a proof-serving optimisation and produces
byte-identical roots and proofs. The quorum-certificate signature tree and the event-log trees use the
same shape with their own byte tags.

**Sparse merkle tree** (`core/qnet-state/src/state.rs`) — account and contract state. Fixed
`TREE_DEPTH` = 256 with 32-byte nodes, so every leaf converges to a root at a fixed depth. Leaf
*positions* are `SHA3-256("QNET_ADDR:" || address)` for accounts and
`SHA3-256("QNET_STORAGE_KEY:" || key)` for contract storage; storage leaf *values* are
`SHA3-256("QNET_STORAGE_VAL:" || raw value string)`. Path direction at depth `i` uses key bit
`255 - i`, which is what makes any subtree a contiguous key range. Internal nodes are plain
`SHA3-256(left || right)`; domain separation lives entirely in the leaves. Default (empty) hashes are
built by iterating `SHA3-256(h || h)` from a 32-byte zero seed. The account leaf is a fixed-schema
`SHA3-256("QNET_ACCOUNT_V2:" || ...)` digest whose fields exclude reputation and the account public
key, which the address already commits to. See [state](state.md).

**LtHash** (`development/qnet-integration/src/registry_lthash.rs`) — a multiset hash used for
`registry_root`, `dilithium_pk_root` and the reward-epoch commitment. `LANES` = 1024 lanes of 16 bits
(`STATE_BYTES` = 2048). Each row is seeded with a domain-tagged, length-prefixed SHA3-256, the seed
is expanded through SHAKE-256 into 1024 little-endian `u16` lanes, and rows are combined by
component-wise wrapping addition; `remove` is the exact inverse, which is what makes reorg rollback
possible. The committed digest is `SHA3-256("qnet-registry-root-v2" || state_bytes)`.
Because the registry row seed includes `vrf_pk_sha3`, `registry_root` binds the consensus signer keys,
letting a light client verify a served committee public key against the certified root. Cross-language
pinned vectors lock the registry-root preimage in both the Rust and mobile test suites, so any
preimage change must regenerate both pins in the same commit.

## Transport security

Peer transport is QUIC via `quinn`, with `rustls` restricted to TLS 1.3 and the `aws-lc-rs` crypto
provider. ALPN is `qnet-p2p-v1`.

- **TLS carries confidentiality.** The server presents an `rcgen` self-signed certificate with SAN
  `qnet-{node_id}`, persisted to `{data_dir}/tls/cert.der` and `key.der` (mode 0600 on Unix) and
  regenerated if the SAN no longer matches the node id. The certificate is bound to the node id after
  the handshake: `verify_peer_cert_node_id` parses it with `x509-parser`, requires an exact
  `qnet-{node_id}` dNSName SAN, and pins its SHA3-256 fingerprint trust-on-first-use; a SAN, parse or
  pin mismatch closes the connection. The binding is enforced on connections this node dials, where
  the server certificate is present.
- **Peer identity is proved at the application layer**, by a mandatory ML-DSA-65 signature over
  `qnet-quic-handshake-v2:{node_id}:{timestamp}:{block_height}:{channel_binding}`. The channel binding
  is a 32-byte TLS keying-material export with label `qnet-quic-channel-binding-v1`; if the exporter is
  unavailable the code refuses the connection rather than substituting a default, so a proof can never
  be verified against an empty binding. Each side verifies the peer's proof before sending its own, and
  a node whose local crypto cannot sign its own proof refuses the connection.
- **A peer that cannot present a valid proof is refused.** An empty proof, a proof whose bytes are not
  valid UTF-8, and a proof that fails under the claimed identity's registered key each close the
  connection. Where the proof is not checkable at all — the claimed `node_id` has no key in the
  consensus registry, or the local verifier is not yet published — the peer is admitted as
  unauthenticated transport, and nothing it asserts is trusted until a message of its own verifies.

See [networking](networking.md).

## Symmetric encryption and secret handling

| Use | Construction |
| --- | --- |
| Mobile wallet vault (mnemonic and secret keys) | AES-256-GCM under a PBKDF2-SHA256 key, 600,000 iterations, per-vault random 32-byte salt, random 12-byte IV; a vault written at a lower iteration count is re-encrypted at 600,000 with a fresh salt and IV on first unlock |
| Database value encryption | AES-256-GCM, key = `SHA3-256(activation_code \|\| "QNET_DB_ENCRYPTION_V1")`, random 12-byte nonce |
| Key-file integrity tag | `[key(32) \|\| SHA3-256(key \|\| "QNET_SECRET_INTEGRITY_V1")[0..8]]` = 40 bytes, mode 0600 |
| Light-node RPC challenge stamp | 16-byte truncated MAC, `SHA3-256("qnet-light-challenge-secret-v1" \|\| wallet_seed \|\| node_id \|\| nonce \|\| expiry_be)[0..16]` |

Mobile ML-DSA-65 operations run through a native module (`DilithiumModule`); the mobile light client
independently recomputes the checkpoint hash, the registry root and the committee selection score, and
verifies each committee vote as `QNET_BFT2_VOTE:<checkpoint_hash>` — its SMT proof verifier mirrors the
Rust fold rule at every level of the served path, checking each entry's side against key bit `255 - i`
before hashing, and the two-level QRC-20 proof additionally requires exactly 256 entries at each level.
See [mobile wallet](../applications/mobile-wallet.md).

## Where each signature scheme is used

ML-DSA-65 authenticates everything QNet itself produces: consensus messages, blocks, node identity,
and all transactions, including every system transaction type.

The Phase-1 burn credential is external, so it is verified with the host chain's own signature
scheme. `verify_ed25519_signature` validates the burn wallet owner's signature over
`qnet_onchain_reg:{node_id}:{wallet}:{registration_proof}:{timestamp}:{attest_root_tag}:{burn_tx}`
during node registration, authorising which node a given burn may activate; `attest_root_tag` is
`hex(SHA3-256(ML-DSA-65 pk))` or the empty string. It requires a 128-hex-character (64-byte)
signature and a base58 address decoding to exactly 32 bytes, with a length gate applied before base58
decoding. The related burn-attestation quorum message, signed with ML-DSA-65 by QNet nodes, is
`burn_attest:{burn_tx}:{burn_wallet}:{wallet}:{amount}:{node_type_u8}:{cost}:{attest_epoch}`, with the
node type encoded as a stable integer so all signers produce identical bytes. See
[node activation](../economics/node-activation.md).

## Related documents

[Consensus](consensus.md) | [state](state.md) | [networking](networking.md) | [node activation](../economics/node-activation.md) | [mobile wallet](../applications/mobile-wallet.md)
