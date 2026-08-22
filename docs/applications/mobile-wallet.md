# Mobile wallet and light node

This document describes the QNet mobile application in `applications/qnet-mobile`: a non-custodial
React Native wallet for Android and iOS that holds a post-quantum QNet identity, signs transactions
on device, verifies balances against a committee quorum certificate, and can register and operate a
Light node.

## What the app does

- Creates or imports a BIP39 mnemonic and derives three independent keys from it (QNet, Solana, EVM).
- Displays QNC balances, QRC-20 token balances and transaction history; sends native QNC and
  QRC-20/QRC-721 tokens; deploys token and NFT contracts.
- Verifies balances and token transfers against a quorum certificate produced by the consensus
  committee, using proofs served by a node but checked entirely on device.
- Burns 1DEV on Solana, derives a node activation code, registers a Light node on chain, and answers
  the liveness challenges that keep that node reward-eligible.
- Claims accumulated node rewards.

The UI is a single wallet screen with six tabs: assets, receive, activate, history, node, settings.
It includes QR receive, clipboard copy, hideable balances, spam-token hiding and a QNet/Solana
network switch. Interface strings are localised into 11 languages in `src/i18n/translations.js`, with
the language selected in settings.

## Identity and key derivation

One mnemonic yields three keys with strictly separated roles.

| Key | Algorithm | Derivation | Used for |
| --- | --- | --- | --- |
| QNet wallet key | ML-DSA-65 (FIPS 204) | `SHAKE-256("QNET_WALLET_MLDSA65_v1:" + hex(bip39_seed))` truncated to a 32-byte keygen seed | Every QNet signature: transfers, contract calls, node registration, ping delegation, reward claims |
| Solana key | Ed25519 | `m/44'/501'/{account}'/0'` (ed25519-hd-key) | Solana burn transaction and Solana wallet-ownership proofs only |
| EVM key | secp256k1 | `m/44'/60'/0'/0/0` | An EVM address only; derivation failure leaves the field null rather than failing wallet creation |

The EON address is `SHA512(raw ML-DSA-65 public key)` rendered as 19 hex characters, the literal
`eon`, 15 hex characters and an 8-hex SHA3-256 checksum over the first 37 — 45 characters total.
Recipient addresses are validated against that layout (or a 64-character hex address) before anything
is signed. Key sizes are 1952-byte public key, 4032-byte secret key, 3309-byte detached signature.

## Key storage and custody

- The mnemonic and secret keys live in a password-encrypted vault: AES-256-GCM with a PBKDF2-SHA256
  key at 600,000 iterations.
- Failed password attempts back off exponentially starting at the third failure:
  `1000 * 2^(n-3)` ms, capped at 300,000 ms, persisted across restarts.
- Biometric unlock stores the wallet **password** (not a key) in the OS keychain under service
  `com.qnet.wallet.biometric`, with `BIOMETRY_CURRENT_SET` and `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
- A **separate**, randomly seeded ML-DSA-65 keypair is generated at node registration for signing
  liveness pings. Its secret key is stored in the keychain under service `qnet_ping_sk_{node_id}`
  with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, so a background push handler can answer a challenge
  without the wallet password. It is bound to the wallet by a delegation certificate: the wallet
  ML-DSA-65 signature over `delegate_ping:{ping_pubkey}:{node_id}`.
- Deleting the wallet tears the node down: the scheduled wake is stopped and the keychain ping secret
  and cached certificate are wiped, so a removed wallet cannot keep attesting.

## Light client

The app is a thin client: it stores no blocks, no headers and no chain state. Chain data is fetched
from a node over HTTP and checked on device against a committee quorum certificate.

### Verified on device

1. **Checkpoint hash.** The device recomputes the SHA3-256 checkpoint hash byte for byte from the
   served checkpoint fields under the domain tag `qnet-checkpoint-v2`, in the same field order as the
   node (`core/qnet-consensus/src/checkpoint_bft.rs`), down to the final tag byte. The ordering is
   pinned by cross-language tests.
2. **Quorum certificate.** It counts *distinct valid* committee signatures over the message
   `QNET_BFT2_VOTE:{checkpoint_hash}` until the quorum `n - floor((n-1)/3)` is reached. Every
   signature is opened against the public key bound to that signer id by the certified registry, which
   is what ties a signature to its signer: a signer outside the derived committee, or one whose
   signature fails under that key, is skipped and never counted.
3. **Committee derivation.** For macroblock index `j >= GENESIS_ERA_MAX_INDEX`, the committee is
   derived by the device from the *already-verified* eligible-producer set and randomness beacon of
   macroblock `j-2` (domain tag `COMMITTEE_VRF_v3.36`, window `j`). Because each committee depends on
   `j-2`, the even and odd indices form two independent chains; verifying macroblock `j` walks only
   `j`'s own chain up from the anchor.
4. **Committee public keys.** Served registry entries are re-folded into an LtHash root (tags
   `qnet-registry-row-v4` / `qnet-registry-root-v2`, 1024 u16 lanes / 2048 state bytes) that must
   equal the `registry_root` of the already-verified `j-2` checkpoint, and each key must satisfy
   `sha3_256(pk) == entry.vrf_pk_sha3`. Individual members that cannot be bound are skipped, which
   reduces the signatures that can count toward quorum; if fewer members bind than the threshold this
   checkpoint is judged at, the whole macroblock is rejected (`pubkeys_unresolved`), and because the
   walk is bottom-up that also stops every higher index on the same parity chain until the
   negative-cache TTL expires.
5. **Epoch commitment.** After the QC verifies, `epoch_commitment` (tag `qnet-epoch-v2`) is
   recomputed over the served raw eligible bytes, the derived committee and the served banned list,
   and must equal the QC-signed value before the eligible set is carried forward to `j+2`.
6. **Account balance.** A sparse-Merkle proof is folded to the certified `state_root`. The
   leaf preimage is rebuilt locally and mirrors the Rust `hash_account` `QNET_ACCOUNT_V2` schema
   exactly: balance (u64 LE), nonce (u64 LE), address bytes, `is_contract = 0`, `HB:` plus four
   zeroed heartbeat fields, `LCE:` plus `last_claimed_epoch`, `BAN:` plus zero, `NODE:` plus the
   is-node flag. The zeroed heartbeat and ban fields hold because heartbeat tallies key on `node_id`
   and equivocation bans are written to the offender node account, so neither lands on a wallet
   account. A balance counts as verified only if the proof folds to the served `state_root` *and*
   that `state_root` is independently certified by a committee QC.
7. **QRC-20 balance.** A two-level proof: a storage proof and an account proof, each required to be
   exactly 256 entries, bound to the requested (contract, holder) pair, with a zero balance treated
   as the 32-zero-byte empty leaf and the contract leaf folded with `SROOT:` plus the raw 32-byte
   storage root.
8. **Token transfers.** Each row's leaf is recomputed from the row's own fields (tx hash, log index,
   contract, sorted-key event JSON), folded to a block sub-root (`log-leaf` / `log-node`), then to
   the window `logs_root` (`logw-leaf` / `logw-node`), and that `logs_root` is anchored to a
   committee QC.

The SMT fold lives in its own module (`src/crypto/SmtFold.js`) so the cross-language jest pins
exercise the shipped code: depth `i` splits on key bit `255-i`, an entry whose `is_right` disagrees
with that bit is rejected, and the pair is hashed `SHA3-256(sibling || current)` ordered by
`is_right`.

### What the verified badge covers

A verified result is a statement about *inclusion and certification*, not about recency. The device
establishes that the served value is committed by a macroblock whose checkpoint it recomputed, whose
quorum certificate it opened signature by signature, and whose committee it derived and key-bound back
to the pinned genesis identities — the answering node contributes bytes, never trust. The height that
proof is anchored at is the `block_height` the answering node chose to serve, and the device verifies
the macroblock covering that height rather than requiring it to be the chain tip. Recency comes from
the polling cadence and the WebSocket push, which is why the app re-reads on wallet-screen focus and
takes its nonce from a fresh confirmed read before signing.

### Trust anchor

The five genesis `node_id -> ML-DSA-65 consensus public key` bindings are compiled into the binary
(`src/config/genesisConsensus.js`), mirroring the node's `GENESIS_CONSENSUS_PKS`. Rotating them ships
as a new release. For macroblock index `< GENESIS_ERA_MAX_INDEX` the committee *is* those five ids
with those pinned keys. `GENESIS_ERA_MAX_INDEX` is 3: it marks the indices whose committee comes
from the embedded genesis keys rather than from a served registry. The verification walk is
genesis-rooted, and `trustFloorIndex()` returns 1.

`WS_CHECKPOINT` is the walk root and ships in the same binary, mirroring the node's weak-subjectivity
pin: a macroblock index `K`, that macroblock's `MacroBlock::hash()`, and the committee-derivation
anchors — eligible-producer bytes, randomness beacon and certified `registry_root` — for **both** `K`
and `K-1`, since each parity chain roots on its own `j-2` predecessor. The verifier fails closed on a
half-filled pin, and a pinned anchor is never seeded into the verified cache, because it carries what
`K+2` needs to derive its committee but not `K`'s own `state_root` or `logs_root`. With a pin at `K`,
verifying index `idx` walks `(idx - K)/2` steps instead of `idx/2`, and `trustFloorIndex()` rises to
`K+1`: indices at or below the pin are history the device takes on the pinned hash rather than
re-proves, and a proof anchored there reports `consistent` rather than `verified`.

The pin also keeps the walk inside the window where the material it needs exists. Nodes retain
committee signatures for the most recent `QC_SIG_RETENTION_MB` = 14,880 macroblocks and keep the
checkpoint, signer list and `sig_merkle_root` for everything older; below that horizon
`/api/v1/macroblock/{index}/proof` answers `qc_sigs_pruned` with `action: "repin_recent_anchor"`. A pin
is therefore refreshed by app release on a cadence inside that window, which is what
`SNAPSHOT_MAX_WS_WALK_MB` — the shared cold-join and light-client walk budget — is sized for. See
[state](../architecture/state.md).

### Constants mirrored from the node

| Constant | Value |
| --- | --- |
| `MACROBLOCK_INTERVAL` | 90 |
| `COMMITTEE_THRESHOLD` / `COMMITTEE_SIZE` | 1000 / 1000 (at or below the threshold the whole eligible set is the committee) |
| `DILITHIUM_SIG_LEN` | 3309 |
| LtHash `LANES` / `STATE_BYTES` | 1024 / 2048 |

### Served by the connected node

The values below are supplied by the node the app is connected to and are displayed as received. The
verified badge is earned only by the checks above.

- **The node discovery list.** `/api/v1/validators/proof` is checked by `verifyValidatorSetProof`,
  which recomputes the response's `merkle_root` from the same response's validator array and compares
  the two. That establishes the response's internal consistency. The digest is a single flat
  SHA3-256 over `QNET_VALIDATOR_SET:`, the epoch as u64 LE, then — for each validator, sorted by
  `node_id` — the node id, address and node-type strings, the reputation as an IEEE-754 f64 LE, the
  last-seen timestamp as u64 LE and the active flag as one byte; the device mirrors that byte layout.
- **Native QNC transaction history.** Rows from `/api/v1/account/{addr}/transactions` are rendered as
  served; QRC-20/721 transfer rows carry logs-root inclusion proofs.
- **WebSocket balance pushes.** A `BalanceUpdate` event addressed to this wallet is applied directly
  to the displayed balance. On the polled path the UI holds the last known balance and refuses to
  lower it from an unverified source.
- **The transport.** The five bootstrap genesis endpoints are hardcoded host:port entries on TCP
  port 8001 and default to plain HTTP; HTTPS is opt-in via `QNET_FORCE_HTTPS=1`. The Android manifest
  declares only the `INTERNET` permission and sets `allowBackup="false"` and
  `usesCleartextTraffic="true"`.

Proof results use a four-way vocabulary that keeps "cannot prove now" distinct from "proven forgery":
`verified`, `consistent` (real but below the trust floor or the macroblock is unreachable),
`rejected` (the leaf or fold does not match, or the QC-certified root differs from the node-claimed
one), and `pending` (transient fetch or finality miss). Only `verified` earns the badge. Verified
proofs and a 60-second negative cache are held in memory for the life of the app process.

## Requests, signing and sending

Balance, token, token-transfer, reward-claim, transaction-submit and contract calls go through a
hedged path: two health-ranked nodes, a per-attempt timeout and a hedge timer, first success wins and
the rest are aborted. Single plain requests against one node are used for the light client's
macroblock-proof and registry fetches, node discovery, the native transaction-history list, the 1DEV
burn-progress read against the Solana RPC, and every push, ping and self-attestation call. Requests
where the **server builds the transaction** go to exactly one node, since hedging them would produce
two distinct on-chain transactions for one logical operation.

Node selection for the hedged path is weighted-random by reputation over the discovered set, filtered
on reputation ≥ 0.7, `last_seen` younger than 300 s and `isSynced !== false`, with recently failing
nodes skipped; discovery caches for 5 minutes.

Two signature wire formats come from the same native module:

- Raw detached hex (3309 bytes) for value transactions and contract calls.
- The envelope `dilithium_sig_{node_id}_{base64}` for lifecycle, ping and claim messages, where the
  base64 payload is `[u32LE len(sig||msg)][sig||msg]` optionally followed by `[u32LE pk_len][pk]`.

Canonical signed messages. Every transaction preimage carries the chain tag `q{chain_id}|`
(`q1337|` on testnet); the reward-claim and ping-delegation messages are RPC authorisation
messages, not transactions, and carry no tag:

| Operation | Message |
| --- | --- |
| Native transfer | `q{chain_id}\|transfer:{from}:{to}:{amount}:{nonce}:{gas_price}:{gas_limit}` |
| Contract call | `q{chain_id}\|contract_call:{from}:{sha3_256_hex(dataStr)}:{nonce}`, `dataStr` being JSON with keys ordered `args, contract, method` |
| Reward claim, step 1 (node ownership) | `claim_rewards:{node_id}:{wallet}` |
| Reward claim, step 2 (batch) | `qnet_claim_v1:{wallet}:{claim_timestamp}:{sha3_256(claims_data)}` |
| Node registration | `q{chain_id}\|client_node_reg:{node_id}:{wallet}:{registration_proof}:{timestamp}` |
| Node-registration identity proof | `{wallet}` |
| Ping delegation | `delegate_ping:{ping_pubkey}:{node_id}` |

A Light-node registration carries two of these. The identity proof is a wallet-key ML-DSA-65 signature
over the bare wallet address, sent as `quantum_signature` with the wallet public key as
`quantum_pubkey`; `/api/v1/light-node/register` verifies it before it will gossip the registration, and
it is the sole gossip authenticator, mirroring the check every peer node applies. The
`client_node_reg` message above then authorises the on-chain registration transaction built from that
response.

Transfers default to `gas_price = 10` nanoQNC per gas and `gas_limit = 10000`. Amounts and token ids
are normalised to decimal strings so full u64 values survive the signed digest, and balances are
re-extracted as exact decimal strings from the raw response text because `JSON.parse` loses precision
above 2^53. A send is reported successful only on an affirmative `tx_hash` or `success === true`; an
ambiguous empty 200 is treated as failure.

The 1952-byte public key is carried on the wire until a confirmed chain read reports
`has_dilithium_pk`, after which it is elided and the node rehydrates it from state. A `pk_unresolved`
rejection forces a fresh nonce read that re-attaches the key.

The wallet exposes the full token surface: QRC-20 transfer, approve, transferFrom, mint, burn;
QRC-721 mint, transfer, approve, transferFrom; plus `deployToken` and `deployNftCollection`. See
[smart contracts](../developers/smart-contracts.md).

## Reward claims

Claiming is two-step, and each step carries its own wallet-key ML-DSA-65 signature: step 1 proves
node ownership over `claim_rewards:{node_id}:{wallet}`, step 2 signs the quoted batch. The node quotes
a batch; the client then:

- rejects a quote whose epochs are not strictly ascending above the reported watermark;
- cross-checks the batch's head epoch against `/api/v1/rewards/pending/{node_id}` on a **different**
  node and fails closed if that cannot be confirmed;
- **rebuilds the sign message locally** and refuses to sign the node's `sign_message` verbatim,
  aborting loudly on any mismatch. The same ML-DSA-65 key also signs transfer messages, so signing a
  server-supplied string would let any node in the hedged pool obtain a transfer signature.

The minimum claim is 1,000,000,000 nanoQNC (1 QNC). See [economics](../economics/overview.md).

## Node activation from the app

Phase 1 activation burns 1DEV on Solana with an SPL burn instruction plus the memo
`QNET_NODE_TYPE:{TYPE}`; the activation code is then derived locally by an XOR/SHA3-256 scheme that
mirrors the server generator. Phase 1 pricing in the app is 1500 1DEV at zero burn, reduced by 150
per 10% of supply burned, floored at 300. At or above 90% burned the app switches to Phase 2 pricing:
10,000 QNC for Light and 7,500 QNC for Super, multiplied by 0.5 (up to 100k nodes), 1.0 (up to 300k),
2.0 (up to 1M) or 3.0 above that, transferred to Pool 3 rather than burned. See
[node activation](../economics/node-activation.md) and [the 1DEV token](../economics/tokenomics-1dev.md).

Operating parameters:

- The app activates **Light** nodes end to end. For a Super node it produces the activation code and
  the UI directs the operator to complete activation on the server. See
  [running a node](../operators/running-a-node.md).
- The Light node pseudonym is `light_mobile_{first 16 hex of blake3("LIGHT_NODE_PRIVACY_{wallet}")}`
  and carries no region.
- On-chain registration is submitted to a single node, because the server builds and hashes the
  transaction. A failure is persisted per wallet and retried on later unlocks with exponential
  backoff, giving up after 12 attempts; an "already registered" rejection is treated as success.

## Liveness: pings and self-attestation

Push provider selection degrades in order: UnifiedPush, then FCM, then a BackgroundFetch polling
fallback configured with a 240-minute minimum interval, `stopOnTerminate = false`, `startOnBoot = true`
and headless mode enabled. The FCM background handler is registered at top level in `index.js` so
pushes to a killed app are not lost.

Two paths prove liveness:

- **Push challenge.** The node pushes a challenge; the app signs it with the keychain-held delegation
  key and POSTs `node_id`, the challenge, the `ping_dilithium:`-prefixed signature, the ping public
  key and the delegation certificate as a JSON body to `/api/v1/light-node/ping-response`. The route
  takes POST with a 64 KB body limit because each enveloped ML-DSA-65 signature embeds its own
  message, so the response is far larger than a query string will carry. If the keychain is
  unavailable the ping window is missed and retried in the next window.
- **Pull self-attestation.** On any wakeup the app builds the challenge `selfattest:{height-2}:{hash}`
  from the `previous_hash` of block `height-1`, deduplicated per 14,400-block epoch, and submits it
  through the same ping-response endpoint. This proves same-epoch liveness without depending on push
  delivery. It is skipped only on a definitive `onChainRegistered === false`.

Either path counts the same: **one** recorded attestation makes the node eligible for that epoch's
reward bitmap. The two paths also carry different guarantees over a long absence. The node that owns
the device's shard wakes it while it has attested within the last 3 epochs, or while it is inside that
same span from registration. Past that span the shard owner stops waking it, and pull self-attestation
is what brings it back: the first wakeup after a long offline stretch attests for the current epoch and
restores the device to the wake roster. A device that fails 5 consecutive pings, or whose registration
is marked inactive, likewise returns through self-attestation. Keeping the BackgroundFetch fallback
enabled is therefore what makes a device that misses pushes still earn. See
[economics](../economics/overview.md).

## Platforms and build

- React Native 0.81.4 with React 19.1.0 on Hermes, `newArchEnabled=false`, Node ≥ 20.
  `crypto.subtle` comes from `react-native-quick-crypto`, installed before any other module.
- Android: application id `com.qnetmobile`, minSdk 24, compileSdk and targetSdk 36, NDK 27.1.12297006,
  Kotlin 2.1.20; release builds enable R8 minification and resource shrinking. iOS deployment target
  is 15.6 for the app target.
- ML-DSA-65 is native: PQClean reference C compiled through the NDK by CMake for `armeabi-v7a`,
  `arm64-v8a`, `x86` and `x86_64`, exposed through a Kotlin JNI module on Android and an Objective-C
  module on iOS with byte-identical return shapes. The library load is fail-soft: a failed
  `System.loadLibrary` marks the module unavailable and every method rejects with
  `DILITHIUM_NATIVE_UNAVAILABLE` instead of crashing.
- Release signing reads `keystore.properties`, falling back to the `QNET_KEYSTORE_PASSWORD` and
  `QNET_KEY_PASSWORD` environment variables; both are operator-supplied. Keystores and signing
  properties are never committed. An F-Droid reproducible-build metadata file points at the `android`
  subdirectory.
- Cross-language jest pins assert that the JavaScript registry-root fold and the SMT account-proof
  fold reproduce roots emitted by the Rust node, importing the shipped modules rather than copies.

## Related documents

- [Consensus](../architecture/consensus.md) — checkpoints, committees, quorum certificates.
- [Cryptography](../architecture/cryptography.md) — ML-DSA-65, hashes, address format.
- [State](../architecture/state.md) — account leaf schema and state commitment.
- [RPC API](../developers/rpc-api.md) — the endpoints the app calls.
- [Browser wallet](browser-wallet.md) — the extension that shares the same derivation.
