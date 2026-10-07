# Light node messages

Status: normative, version 1. This document defines the bytes that the QNet app, the web cabinet on aiqnet.io,
the QNet browser extension, the genesis nodes and the device oracle sign and check for a light node:

- the node's identity (section 3);
- the messages signed with the wallet key and with the node's ping key (section 4);
- the device layer, which binds a light node to one phone or tablet (sections 5 to 8).

The QNet Link requests that carry some of these messages between aiqnet.io and the app are defined in
[QNet Link v1](qnet-link-v1.md), section 14. Test vectors: [`light-node.vectors.json`](light-node.vectors.json),
produced by [`tools/light-node-vectors.mjs`](tools/light-node-vectors.mjs) (section 10). MUST, MUST NOT, SHOULD and
MAY are used as in RFC 2119.

## 1. Parties and device classes

| Party | Role |
| --- | --- |
| **App** | QNet Wallet on iPhone, iPad, Android phones and Android tablets: the wallet, the node client and every confirmation |
| **Cabinet** | aiqnet.io/node in a browser: payment, activation code, claim, devices (link, move, unlink), "I'm back"; it opens requests that the app confirms and never handles device evidence |
| **Extension** | the QNet browser extension: burn, record on the network, claim; it never runs a node |
| **Genesis nodes** | the five genesis nodes: shard owners of the light nodes and, with a quorum of 4, the attestors of device statements |
| **Device oracle** | a service run by the network operator: holds the vendor credentials, keeps the per-device slot lease and signs lease statements; its hosts are configuration |

A light node runs on a phone or tablet whose security hardware proves the device:

- **iOS and iPadOS**: an App Attest key in the Secure Enclave of an iPhone or iPad. Every device the app installs
  on supports it; a Mac, an Apple Vision Pro and the Simulator do not.
- **Android**: a hardware-backed key (TEE or StrongBox) whose attestation chain ends at a Google root, on a device
  with locked, verified boot, running the app Google Play recognizes, in the device's main profile, on a phone or
  tablet (on a licensed store install Google's app-access-risk verdict must be present: section 9). Remote-provisioned attestation chains are the normal case; factory-provisioned chains are accepted with the
  stricter lease and limits of section 9.

There is no operating-system version minimum. A device that cannot prove its hardware (a computer, an emulator, a
device without hardware attestation) keeps the full wallet; its Node tab says "This device can't run a node." One
device runs one node, and one wallet has one node.

## 2. Conventions

- Every preimage is UTF-8 text without spaces. Node messages (section 4) separate fields with `:`, as the node's
  existing formats do; device messages (sections 5 and 6) with `|`.
- `chain_id` is `1337`, the decimal network id; the chain tag is `q1337|` (`chain_tag()` of `qnet-state`).
- `hex()` is lowercase hex. `sha3()` is SHA3-256. `b64url` is RFC 4648 section 5 without padding and canonical: a
  decoder refuses other characters, `=`, a length of 1 mod 4 and non-zero padding bits.
- `epoch(h)` = `floor(h / 14400)`.
- **ML-DSA-65** (FIPS 204): 1952-byte public keys, raw 3309-byte signatures, empty context. The wallet key `K` and
  the ping key sign this way. In node RPC bodies keys and signatures are hex; between the wallets and the site they
  are b64url.
- **Device key** `hw`: ECDSA P-256 with SHA-256, created in the device's secure hardware and never exported.
  `hw_pub` is its 65-byte uncompressed SEC1 point (`0x04 ‖ X ‖ Y`). The device key proves only that a reply comes
  from the hardware of one device; it controls no funds and no identity. App Attest keys are P-256, and P-256 is the
  hardware key type every Android device offers, so the device layer uses it on both platforms.
- **Integers**: node RPC bodies carry integers as JSON numbers (all below 2^53); QNet Link answers carry every u64 as
  a decimal string (no sign, no leading zero).

## 3. Identity

| Value | Definition |
| --- | --- |
| Seed string | `QNET_WALLET_MLDSA65_v1:` ‖ hex of the 64-byte seed of the recovery phrase (PBKDF2-HMAC-SHA512 of the phrase's NFKD text, salt `mnemonic`, 2048 rounds: an empty passphrase) |
| `xi` | SHAKE256(seed string), 32 bytes: the ML-DSA-65 KeyGen seed |
| `K` | the wallet's ML-DSA-65 public key, `KeyGen(xi)` |
| `W` | the wallet's EON address: SHA-512(`K`) as hex → first 19 characters ‖ `eon` ‖ next 15 ‖ first 8 hex of SHA3-256 of those 37 characters |
| `N` | the light node id: `light_mobile_` ‖ first 16 hex of BLAKE3(`LIGHT_NODE_PRIVACY_` ‖ `W`) |
| `proof` | first 32 hex of BLAKE3(`{burnTx}:{N}:{W}`), where `burnTx` is the base58 signature of the burn |
| Attest root tag | `hex(sha3(K))` |
| `walletHash` | first 16 hex of SHA3-256(`qnet-link-wallet:` ‖ `W`) (QNet Link requests) |

The ping key is an ML-DSA-65 key the app creates when it links the node on a device; it signs the node's answers
so that the wallet key stays locked. `pp` is its public key.

## 4. Wallet-key and ping-key messages

| Message | Preimage | Signer | Checked by |
| --- | --- | --- | --- |
| Consent | `q1337\|client_node_reg:{N}:{W}:{proof}:{T}` | `K` | the node at submit and in the block |
| Owner bind | `qnet_onchain_reg:{N}:{W}:{proof}:{T}:{hex(sha3(K))}:{burnTx}` | the burner's Ed25519 key: the cabinet's one-time payment key, the extension's Solana key, or for a burn made from the wallet's own Solana address QNet Wallet's Solana key (the same recovery phrase's) | the node at submit and in the block |
| Owner bind v2 | `qnet_burn_owner_v2:{N}:{W}:{proof}:{hex(sha3(K))}:{burnTx}` | the burner's Ed25519 key | the node at submit and in the block, from the `wallet_one_node` gate |
| Delegation | `q1337\|delegate_ping:v2:{hex(pp)}:{N}:{seq}` | `K` | `/light-node/bind` |
| Attach | `q1337\|light_attach:{N}:{hex(sha3(pp))}:{hex(sha3(push_target))}:{seq}:{ts}` | `K` | `/light-node/bind` |
| Token refresh | `q1337\|token_refresh:{N}:{hex(sha3(push_target))}:{seq}:{ts}` | ping key | token refresh route |
| Unbind | `q1337\|light_unbind:{N}:{seq}:{ts}` | ping key, `seq` equal to the stored one | `/light-node/unbind` |
| Wallet unbind | `q1337\|light_unbind_wallet:{N}:{seq}:{ts}` | `K`, `seq` equal to the stored one | `/light-node/unbind` |
| Answer challenge | `selfattest:{h}:{hash}` | ping key | ping reply (section 5.8) |
| Claim quote | `q1337\|claim_rewards:{N}:{W}` | `K` | `/rewards/claim`, step 1 |
| Claim payload | `q1337\|qnet_claim_v1:{W}:{ts}:{hex(sha3(claims_data))}` | `K` | `/rewards/claim`, step 2 and the block |
| Signed status | `q1337\|light_status:{N}:{ts}` | ping key or `K` | `POST /light-node/status` |
| Signed poll | `q1337\|light_poll:{N}:{ts}` | ping key | `GET /light-node/pending-challenge` (section 5.10) |

- `T` is the consent time in Unix seconds. The node accepts a consent with `now − 86400 ≤ T ≤ now + 300` once two
  genesis nodes advertise `consent_24h`, and `|now − T| ≤ 300` before.
- Both owner binds are the raw preimage, signed with Ed25519 and carried as 128 lowercase hex (`owner_signature` at
  submit, `burn_owner_sig` in the block). The v1 bind shares `T` with the consent, so the burner signs it together
  with one consent. The v2 bind names no time: the burner signs it once, right after it signs the burn, and the
  registration is finished later with any fresh consent of the wallet. The node accepts v2 only for a light
  registration and only from the `wallet_one_node` gate (the height the submit door, the attestor and the producer
  judge for is the node's tip + 1; a block, its own height); v1 stays valid at every height. The node tries v1 first.
  Before that height a v2 bind that verifies is answered `bind_v2_pending`, a retry, never a refusal of the burn
  (section 8); the node lists `owner_bind_v2` (section 7) while the height it judges for takes v2, so a client
  that can sign only v2 waits until two genesis nodes list it before it takes a burn.
- A burn made from the wallet's own Solana address (by the extension, or by an older app) is registered from any
  browser with QNet Wallet's consent ([QNet Link v1](qnet-link-v1.md) section 14): the burner is the Solana key the
  wallet's recovery phrase makes on `m/44'/501'/0'/0'`, which QNet Wallet holds, so the app signs that burn's v1 owner
  bind with the consent's `T` beside the consent. The node checks it as any v1 bind: nothing in the node is particular
  to it. The app signs no other burner's bind.
- From the `wallet_one_node` gate one wallet has one node of either type: a registration is refused when its wallet
  already has another node on chain (its genesis, super or light id, registered below the block), and a block may
  not carry two registrations of one wallet under different node ids. A wallet registered with both types before the
  gate keeps both.
- `push_target` is the device's push token or push endpoint as the UTF-8 string the app registers, or the empty
  string when the device has none; the hash of the empty string is `sha3("")`.
- `seq` is the binding sequence: a new binding takes `max(now, binding_seq + 1)`; in the QNet Link sheet the app
  takes `seq = ts = T`. `ts` of the attach, token refresh, unbind and signed status lies within ±300 s of the
  node's clock (the attach of a first binding within `[now − 86400 − 600, now + 300]` when `seq = ts`: the span in
  which the app re-sends a pre-signed binding and the node keeps it pending).
- Beside the signed fields, a `/light-node/bind` body may carry two unsigned display hints of the device it binds:
  `platform` (`"android"` or `"ios"`) and `model`, a short marketing name of the device the app builds on it (never a
  serial number, IMEI, user name or other identifier): 1 to 40 ASCII letters, digits, spaces and `. , + ( ) / -` once
  trimmed. Anything else is no platform or no model, never a reason to refuse, and a node of an earlier version
  ignores both. The node keeps them with the binding's push record: the token sync carries them to the other genesis
  nodes (as `platform` and `model`), a pending binding keeps them until it is promoted, a re-send that names none
  keeps the ones its binding holds, the next binding replaces them, and the unbind deletes them. No block rule reads
  them; the public status shows them (section 7).
- The unbind ends the binding stored now, at its sequence (`binding_seq` of the signed status while `device_bound` is
  true). The bound device signs it with its ping key (`"signer": "ping"`): the app sends it when the user confirms the
  cabinet's `unlink` request on that device ([QNet Link v1](qnet-link-v1.md) section 14), or when the wallet is
  deleted there; only this form carries the device's release (section 5.7). Any device that holds the wallet signs
  the wallet unbind with `K` (`"signer": "wallet"`), so a lost device is unlinked from another one; its body is
  exactly `{"node_id", "seq", "ts", "signer": "wallet", "sig", "identity_pubkey": "<hex(K)>"}`; `K` must be the key
  the registration's commitment vouches for and `N` the node id of `K`'s address `W`, and the device record then
  ends with its binding. A client sends the wallet unbind only once two genesis nodes list `unbind_wallet`.
  Either answer is `{"success": true, "unbound": true, "node_id": N, "binding_seq": seq, "device_released": b}`
  (`device_released` is always false for the wallet form). The other genesis nodes take the unbind from its own
  signature.
- A pending binding (a `/light-node/bind` for a node whose registration has not applied yet) is stored only for a
  burn the genesis has evidence of: it attested that burn for this very node, its pool holds the node's registration,
  or a submit for the node is collecting attestations there. Without that (the QNet Link sheet posts its binding
  before the site submits the registration) the genesis holds the binding in memory only, at most 2,000 of them and
  2,000 new ones an hour, and promotes it when the chain applies the node's registration; the answer is the same
  `pending` one. A restart or a flood may drop a binding held in memory, and the app sends it again once the chain
  lists the node. While the genesis serves the device layer, such a binding is held nowhere and answered
  `rate_limited` with `"retry_after_seconds": 60`, as is any pending binding once the genesis stored 6,000 within the
  hour; the app sends it again later, and once the chain lists the node the same binding is taken as a fresh one. A
  re-send of a binding already pending needs no evidence. When the genesis's store of pending bindings (20,000) or
  its memory of them is full, expired entries go first, then the network holding the most (an IPv4 /24, an IPv6 /64)
  loses its oldest entry, and a binding from a network that would then hold the most is refused `rate_limited`.
- `/light-node/bind` (a pending binding included), `/light-node/unbind` and the token refresh count per address only
  the requests they refuse before or at the signature check (a pending binding with no burn seen included), an IPv6
  address by its /64: 60 such refusals within 60 s block the address for 60 s, answered `rate_limited` with
  `retry_after_seconds`. A request whose signatures verify spends nothing there and is limited per node instead (bind
  and unbind 5 an hour, the token refresh 6; bind and the token refresh count only a request that changes something).
- `h` is the height of a canonical block of the current epoch at most the node's tip and `hash` its 64-hex hash.
- `claims_data` is the exact string the node quoted in step 1: the JSON object
  `{"claims":[{"amount":n,"epoch":n,"proof":[["<64 hex>",b],...]},...]}` with its keys sorted, one entry per epoch
  (the amount in nano-QNC, the reward proof as pairs of a sibling hash and whether that sibling is on the left). The
  node's step 2 sums the `amount` fields.

## 5. Device messages

### 5.1 The device key

- One device key per app install. The app creates it at the first confirmation that links a node on this device
  ("Link this wallet's node to this device" or "Use this device") and rotates it every 30 days (section 5.4). A second
  wallet in the same install uses the same key (section 5.5).
- **iOS**: `DCAppAttestService.generateKey`, attested with `attestKey`; the key id is kept in the Keychain,
  available after first unlock and on this device only. `key_id` on the wire is b64url of SHA-256(`hw_pub`), the
  32 bytes of the key identifier the platform returns. The app reads `hw_pub` from the leaf certificate of its own
  attestation.
- **Android**: an EC P-256 key in StrongBox or the TEE, generated with `setAttestationChallenge(challenge)`, without
  user authentication and without device-properties attestation.

**Device signature** of a preimage `P`:

- iOS: `generateAssertion(key_id, clientDataHash = SHA-256(P))`, the CBOR map `{signature, authenticatorData}`, sent
  as b64url of the CBOR bytes. `authenticatorData` = `SHA-256("<TeamID>.com.qnetmobile")` ‖ flags (1 byte) ‖ counter
  (4 bytes, big-endian). The signature is ECDSA-SHA256 over `nonce` = SHA-256(`authenticatorData` ‖ `clientDataHash`),
  DER. The counter increases with every assertion of the key.
- Android: ECDSA-SHA256 over the UTF-8 bytes of `P`, DER, sent as b64url.

**Key attestation** over a preimage `P`: iOS `attestKey(key_id, clientDataHash = SHA-256(P))`; Android a new key with
`setAttestationChallenge(SHA-256(P))`.

### 5.2 Device challenge

```
GET /api/v1/light-node/device-challenge?node_id={N}&purpose={enrol|rotate|refresh|release|reset}
→ {"nonce": "<b64url, 32 random bytes>", "stamp": "<string>", "exp": <unix seconds>, "issuer": "<genesis id>"}
```

The stamp is the issuer's stateless MAC over `(N, purpose, nonce)`, valid 10 minutes; clients treat it as opaque. The
app sends the matching message to the same issuer, which is one of the node's shard owners; when that genesis is
unreachable it fetches a new challenge from the node's backup owner. `{nonce}` in a preimage is the b64url text.
The purpose `reset` is reserved: a challenge is issued for it, but no message of this document consumes one.

A node that does not serve the device layer answers the challenge and every device route with
`{"success": false, "reason": "not_served", ...}`; the app asks another owner. A device message whose stamp this
genesis did not issue, or that has expired, is refused `device_stale`: the app fetches a new challenge from the
genesis it sends to.

### 5.3 Enrolment

```
qnet_dev_enrol:v1|{chain_id}|{N}|{W}|{hex(sha3(pp))}|{seq}|{nonce}|{flags}
```

- `seq` is the binding's `seq` (section 4).
- iOS `flags` = `mac=0,vision=0,idiom={phone|pad}`, from `isiOSAppOnMac`, `isMacCatalystApp`, `isiOSAppOnVision` and
  the interface idiom.
- Android `flags` = `r={hex(sha3(R))}`, where `R` is the **device report**: canonical JSON with exactly these keys in
  this order, booleans, no spaces:

  ```
  {"arc":b,"automotive":b,"embedded":b,"feature_pc":b,"hsum":b,"leanback":b,"system_user":b,"touchscreen":b,"watch":b}
  ```

  `arc`, `automotive`, `embedded`, `feature_pc`, `leanback`, `watch` are the system features of those names,
  `touchscreen` the touchscreen feature, `system_user` `UserManager.isSystemUser()`, `hsum`
  `UserManager.isHeadlessSystemUserMode()`. `report_sig` is the new key's device signature over the bytes of `R`.
- Evidence: iOS attests the new key over the preimage and adds a DeviceCheck token; for a key the attestors already
  hold, a device signature replaces the attestation. Android generates the key with the preimage as its attestation
  challenge and adds a Play Integrity classic token requested with
  `nonce = b64url(SHA-256(UTF-8(E) ‖ sha3(hw_pub) ‖ sha3(R)))`, `E` being the preimage.
- The enrolment rides on `POST /api/v1/light-node/bind` as the fields `device` and one token field:

  ```
  "device": {"platform": "ios", "key_id": "<b64url>", "attestation": "<b64url>", "flags": "<flags>",
             "nonce": "<b64url>", "stamp": "<stamp>"},
  "dc_token": "<b64url>"

  "device": {"platform": "android", "chain": ["<b64url DER>", ...], "report": "<R>", "report_sig": "<b64url DER>",
             "nonce": "<b64url>", "stamp": "<stamp>"},
  "pi_token": "<token>"
  ```

  iOS carries `assertion` instead of `attestation` for a key the attestors hold. `chain` runs from the key's
  certificate to the root. The node passes the token only to the device oracle over its dedicated route; tokens never
  enter gossip, a log or the chain.

### 5.4 Rotation (every 30 days)

```
qnet_dev_rotate:v1|{chain_id}|{N}|{hex(sha3(old_hw_pub))}|{hex(sha3(pp))}|{seq}|{nonce}
```

The new key is attested over the preimage (Android: with a fresh report and its `report_sig` and a Play Integrity
token with `nonce = b64url(SHA-256(preimage))`); the old key signs the same preimage. `seq` is the current binding's.

```
POST /api/v1/light-node/device-rotate
{"node_id": N, "seq": seq, "old_key": "<hex(sha3(old_hw_pub))>", "device": <the new key's block of 5.3>,
 "old_sig": "<b64url device signature>", "dc_token" | "pi_token": "<token>"}
```

The node stays creditable until 30 days after the rotation fell due and waits in `check_pending` after that until a
rotation completes.

`rotation_due` follows the device key, not the statement: a key attested for the first time (an enrolment with a
new key, or a rotation) is due at `issued_epoch + 180`; a re-enrolment with a key already attested and a rebind keep
that key's date. A re-enrolment with a known key past `rotation_due + 180` lands in `check_pending` until the key
rotates.

`POST /api/v1/light-node/device-rotate` answers `{"success": true, "node_id", "device_state", "effective_epoch",
"rotation_due"}` once the network took the new key (the app then drops the old one), with `paused_until` for a
paused record and `ref` while the node does not count. Refusals: `not_served`, `bad_request`, `not_registered`,
`stale_seq` (no live record or binding at `seq`, or `old_key` is not the recorded key), `identity_mismatch`,
`rate_limited` (also a rotation before `rotation_due`, with `retry_after_seconds`), `device_slot_paused` (a running
pause, with `paused_until`), `device_stale` (with `retry_after_seconds` when the oracle or the attestor quorum did not
answer in time) and the device refusals of the new key's evidence (section 8), with `ref` once the key is known.

### 5.5 Rebind (another wallet in the same install)

```
qnet_dev_rebind:v1|{chain_id}|{N_old}|{N_new}|{seq}|{nonce}
```

Signed by the device key and by `K` of the new wallet (ML-DSA-65 over the same bytes), with a challenge of purpose
`enrol`. It rides on the new node's
`/light-node/bind` as `"device": {"platform": ..., "rebind_from": N_old, "sig": "<b64url device signature>",
"wallet_sig": "<hex>", "nonce": ..., "stamp": ...}` and the token field of section 5.3 (Android: requested with
`nonce = b64url(SHA-256(preimage))`). The old node's device record ends in the current epoch; the new one counts from
the next epoch, a switch back included. A device key takes one rebind per day, plus one free switch back to `N_old`
within 24 hours.

### 5.6 Lease refresh

```
qnet_dev_refresh:v1|{chain_id}|{N}|{nonce}
```

A device signature with a DeviceCheck token (iOS) or a Play Integrity token with `nonce = b64url(SHA-256(preimage))`
(Android). The app sends it in the first ping reply after its refresh window opens, as the parameter
`device_refresh` = b64url of `{"nonce": ..., "stamp": ..., "sig": ..., "token": ...}`, or to
`POST /api/v1/light-node/device-refresh` with the same object and `node_id`. The receiving genesis never relays the
parameter.

The route answers the record after the refresh: `{"success": <the device counts now>, "node_id", "device_state",
"effective_epoch", "rotation_due"}`, with `ref` while it does not count, or for a paused record the
`device_slot_paused` refusal with `paused_until`, `ref` and `device_state`. A record without a lease, or a running
pause, is answered as it stands: a refresh never renews the one or lifts the other. Refusals: `not_served`,
`bad_request`, `not_registered`, `stale_seq` (no live record), `bad_signature`, `rate_limited`, `device_stale` (a
stamp this genesis did not issue, a replayed iOS counter, or, with `retry_after_seconds`, a provisional record, a
missing token or an oracle that did not answer) and the oracle's own refusals.

### 5.7 Release (the device's unbind)

```
qnet_dev_release:v1|{chain_id}|{N}|{seq}|{nonce}
```

A device signature, sent with the unbind (section 4) as `"device_release": {"nonce": ..., "stamp": ..., "sig": ...,
"token": ...}`, the token optional (Android: requested with `nonce = b64url(SHA-256(preimage))`). The device record
ends; the oracle keeps the node's slot generation 30 days for a later self-reclaim only. A running pause does not end
with the record: the node's next device statement carries it until its epoch, also after such an unbind.

### 5.8 Ping reply

Every epoch the app answers with two signatures over the same public anchor `(h, hash)` of the current epoch:

1. `σ` = ML-DSA-65 by the ping key over `selfattest:{h}:{hash}`, 3309 raw bytes.
2. The device signature over

   ```
   qnet_hwping:v2|{chain_id}|{N}|{epoch(h)}|{h}|{hash}|{hex(sha3(σ))}|{hw_seq}
   ```

   iOS: `hw_seq` is `0` and the assertion counter orders the replies. Android: `hw_seq` is a strictly increasing
   millisecond counter the app keeps.

Wire (the existing ping-response route and gossip record): `challenge` = `selfattest:{h}:{hash}`, `signature` =
`ping_hw2:{hex(σ)}.{b64url(device signature)}.{hw_seq}`.

A shard owner checks a reply, on its HTTP ingress and on relay admission alike, in this order:

1. structure;
2. the anchor: `epoch(h)` is the local current epoch, `h` at most the tip and `hash` canonical; on relay the record's
   `block_height` equals `h`;
3. one reply per node per epoch;
4. a device record in state `active` or `suspect` with `effective_epoch ≤ epoch(h)`, lease and rotation inside their
   windows;
5. the device signature under the recorded `hw_pub`, with the iOS counter or the Android `hw_seq` above the last one
   recorded;
6. `σ` under the node's ping key and delegation.

A legacy reply (`ping_dilithium:`, before the device layer is enforced) relayed to a shard owner may carry any height
of the anchor's epoch from `h` on as its `block_height`; the `ping_hw2` rule above is exact.

### 5.9 Tags

| Value | Definition | Where |
| --- | --- | --- |
| `device_tag` | SHA3-256(`qnet_device_tag:v1\|` ‖ `chain_id` ‖ `\|` ‖ platform byte ‖ `hw_pub`), platform byte `0x01` iOS, `0x02` Android | statements; never public |
| `device_tag_h` | first 16 hex of SHA3-256(`qnet_device_tag_h:v1\|` ‖ `nonce` ‖ `device_tag`), `nonce` the 16 bytes of the status query | signed status only (section 7) |
| `ref` | first 8 hex of SHA3-256(`qnet_dev_ref:v1\|` ‖ `nonce` ‖ `device_tag`), `nonce` the 32 bytes of the challenge of the device message whose outcome the screen shows | the paused and "can't run" screens, support tickets; no message carries a support decision back, so a ticket cannot lift a pause (section 6.3) |

The app compares `device_tag_h` with its own value for the same nonce to tell "this device" from "another device".
It is answered only in the signed status: an install keeps its device tag across a rebind or a wallet switch, so a
public answer for a nonce the caller picks would link two wallets to one phone. The app holds the ping key whenever
this device is the bound one; an install without it treats the node as running on another device.

### 5.10 Pushes and answers

A genesis owning the node's light shard wakes the bound device with a data-only push. The data is the same on every
platform and names no node; every value is a string:

```
{"action": "epoch" | "wake", "anchor": "{h}:{hash}", "sent_at": "<Unix seconds>"}
```

`anchor` is the block the device answers with (`selfattest:{h}:{hash}`, section 5.8): two below the genesis's tip,
never before the epoch's first block. `sent_at` is the sending genesis's clock when the push left. Every push carries
the collapse key `epoch`, so a later push replaces an undelivered one. On Android it is sent at high priority with
`ttl`; on iOS as a background push (`apns-push-type: background`, `apns-priority: 5`, `content-available` only) with
`apns-expiration`; to a push endpoint with the headers `TTL`, `Urgency: high` and `Topic: epoch`.

**Timing.** An epoch is 240 slots of 60 blocks. Each epoch the node's first push falls in a slot drawn from its node
id and the epoch over the epoch's first 138 slots. A round is that slot's push and two repeats, 15 and 30 slots after
the drawn slot; one retry round of the same shape follows 60 slots after the drawn slot (60, 75 and 90 slots after
it). Each push goes out only while the node has not been counted in the epoch at any genesis, at most once for each of
these six due points and six times an epoch at one owner rank: a node that answers the first push gets no other. A
push that finds no instant in its slot, or whose tick a short stall missed, goes out in the next slot of its due point
(up to two slots later, or at the tick that catches up after the stall), still once; a push a catch-up made late
stands in for the next due point when that one is less than 13 slots on, so no two pushes a genesis records for a node
go out closer than that. The round's first push and the retry round's are read from the node's drawn slot and are due
to every node not counted. A repeat is due to a node the genesis offered a push in the epoch (sent, or shed by the
pacing), not to one it only woke, held by the dormant rule or refused an answer of; and to every node not counted
when its round began before the genesis held the shard's record of the epoch, after a restart or a takeover, so
neither leaves out the round's repeats. A genesis keeps the slot it last read across a restart: back within 15 slots
in the same epoch it reads every due point it missed and none it had read, so no due point gets a second push (one
whose push did not go out in the last minute before the restart is not tried again in the rest of its grace); back
later, it reads the current slot's due points and loses those of its stop. A genesis records up to six million nodes an epoch; a node past
that gets the round's first push and the retry round's in each slot of their grace.

A genesis switches to this schedule at the epoch after the one it first pinged in on a release with it, stored once
its tip is one the network stands behind and kept across its restarts, so a live epoch is never drawn again: until
then its first push is drawn over the first 168 slots (over the first 232 before the epoch after its first ping on a
release with that draw) and a round is that slot's push and one in each of the next two slots, with a retry round of
three 60 slots after the drawn slot. The release before this one draws over the first 232 slots, pushes in the drawn
slot and the next two and sends no retry round; in the epoch a genesis is upgraded from it, the genesis draws every
node into the same slot, pushes it in the same three slots and adds the retry round, so no node is pushed less. For as
long as the roll takes, owners of one shard may draw an epoch differently. Each ping tick names the windows its sender
switches at (Owners, below), and a genesis that starts pushing a shard inside an epoch (it takes the shard over, takes
its own back, or comes back from a stop past the 15 slots) reads the shard to the epoch's end under each other owner's
draw too, with its own round's shape (the 232-slot draw for an owner never heard naming one): every node whose first
push or retry round under the draw of the owner that pushed the shard before is still due gets it. In such an epoch a
node may be pushed for the due points of both draws, still six times at most, and with the spaced rounds never twice
within 13 slots. A node is not pushed while the dormant rule below holds for it; a node in its first three epochs
(43,200 s) is pushed regardless. The light commit window opens `light_commit_window` blocks (150) before the epoch's
end, when the shard's owners build the epoch's bitmap and submit it for every node of the shard: an answer after it
counts in no epoch.

Every push and every answer belongs to its own epoch, and nothing is ever moved to another. The network sends all of
an epoch's pushes so that they and their repeats end before its commit: the drawn slot is below 138, so the retry
round's last repeat is due in slot 227 at the latest, goes out by slot 229 and leaves, with the pacing, at least five
minutes before the commit for its delivery and answer, as no owner rank waits before it pushes (on the earlier
schedule the drawn slot is below 168 and the retry round's last push falls in slot 229 too; in the one epoch a genesis
still draws over 232 slots, a round drawn late gets no retry round and its last push leaves more than a minute before
the commit, and in an epoch of the roll a shard read under another owner's draw too may be pushed as late as that
draw's slots allow). Every push lives
exactly until the commit (`ttl` and `apns-expiration` are the seconds left, at one block a second), none goes out with
less than 60 s left (only a wake, a genesis catching up after a stall, or a shard read under another owner's draw
comes that close), and between the commit and
the epoch's end no push and no polling challenge is handed out. The next epoch is answered only by its own pushes and by the app's own answers made
during it. A genesis paces its pushes at 900 a second for each shard it pushes (its own and those it covers, at most
three: 2,700 a second, 2,800 with the wakes), first pushes first, then the round's repeats, then the retry round; a
push that finds no instant inside its slot is recorded as unsent and left to the next slot of its due point, and is not
one of the six.

**Owners.** Each shard has three owners: its own genesis (the primary) and the next two around the ring
(`[s, s+1, s+2] mod 5`, backup 1 and backup 2). The primary pushes the shard. After each ping tick it completed, a
genesis sends the other four its ping tick: a signed `ActiveNodeAnnouncement` with `node_type`
`genesis_ping_tick:{first}:{spaced}`, the epochs its early draw and its spaced rounds start at (Timing; 2^64 − 1 for
one not set yet), straight to each and never relayed ([networking](../architecture/networking.md)); a tick of an
earlier build, `node_type` `genesis_ping_tick` alone, counts for liveness and names no schedule. Its time only orders
that genesis's own ticks, so the genesis clocks may read any amount apart. An owner no tick was heard from for
10 slots (600 s) is covered by the rank below it (backup 2 only while both owners above it are silent), which pushes
the shard at once: the repeats of a round begun before the cover are due to every node of the shard not counted, as
it holds no record of them, and where the owners draw the epoch differently it reads the shard under the draw the
owner's ticks named too (Timing). The cover ends once three ticks in a row were heard again. A genesis never heard
ticking (one of an earlier release) is judged, as before, by the age of its last announcement of any kind; which
genesis it heard ticking, and the schedule each named, a genesis keeps across a restart, so after one it judges them
by their ticks at once and an owner that went quiet before the restart is covered all the same. Nothing is judged
silent before the listening genesis has listened for 10 slots. A genesis behind the
network, its epoch not the epoch of the head `f+1` in-set nodes stand behind or its tip more than 60 blocks below that
head, sends no push, no polling challenge, no wake and no tick, so it is covered like a silent one; a genesis whose
push loop stopped sends no tick either. Nor does a genesis whose provider answers none of its pushes: once the
provider failed 5 ticks in a row, a failed tick being one that sent the provider pushes and had none of them answered
(a push the provider took, or its answer that the token is gone, is an answer: the provider worked), the genesis keeps
pushing but sends no tick, and the owners below cover its shards 10 slots after its last tick. It sends ticks again
after the first tick in which a push to the provider was answered. A tick that sent the provider nothing (no push due,
every push shed by the pacing, only polling challenges or push server deliveries) changes nothing, so sparse pushes
neither silence a working genesis nor wake a quiet one. Only the provider whose credentials the genesis holds is
judged: a push server endpoint is the device owner's choice, any host, so its refusals silence nobody (one dead
endpoint would otherwise silence all three owners pushing it) and its answers never hide the provider's outage. The
standing is kept across a restart. Each change is one log line
(`push_provider_failing` at WARN, `push_provider_answering` at INFO). In an outage of the provider itself every genesis
goes quiet and covers its own shard and the two it backs up, at no more than 2,700 pushes a second (2,800 with the
wakes), and each shard is handed back three ticks after its genesis resumes.

The owner that takes an answer sends it to the other two owners and to nobody else, acknowledged where the transport
allows; an owner credits a relayed answer only when its anchor lies before the epoch's commit opening. At the commit
the primary submits its row from the answers it holds, from the window's opening (150 blocks before the epoch's end);
a backup, at its own deadline (100 or 50 blocks before the end), compares the answers it holds with the OR of the rows
already committed for the shard and submits a row holding only the nodes that OR lacks, or no row when it lacks none.
Each owner's row is kept apart and the rows are combined by OR, so an answer only a backup took (the primary restarted
or was down, or the relay to it was lost) is still counted.

**The dormant rule** is the only rule that stops waking a node, and only proven device misses count toward it. A node
is not pushed in epoch `E` when each of `E − 1` and `E − 2` is a proven device miss: the committed index of that epoch
was derived at the deciding genesis and the node's shard committed a row in it; the node was in that epoch's roster and
is absent from its committed index; and an owner's reach record shows that its device was reached in that epoch (a
push the provider took, also when the phone's system then held it back, the same on every platform; a challenge the
device fetched; or the provider saying its token is gone), or that the rule itself held the node then, so a dormant
node stays dormant until it answers. A push that failed at the provider, one the pacing shed, one never sent (no
anchor, a slot the genesis never read, a genesis down or behind) and an epoch in which the node's shard committed no
row prove nothing: the node is pushed. Any answer of the node's own (the app opened, its background answer, or "I'm
back") puts it in that epoch's committed index, and it is pushed again from the next epoch at every owner. Each
pushing owner keeps, per shard and epoch, a reach record: the nodes it reached or held dormant that gave it no
answer, a compressed bitmap over their roster index, node-local, for the last three epochs. The other two owners pull
it (`GET /api/v1/internal/light-reach-get`), so all three stop waking a dormant node alike, a backup that covers the
shard included; a record an owner could not pull leaves that epoch unproven there, and the node is pushed (at most
two epochs more, the safe direction).

While the device layer is enforced (from `LIGHT_DEVICE_SERVE_EPOCH`, today never), a device whose record does not
count (paused, its lease lapsed, its rotation overdue) is neither pushed nor woken: a second rule that stops waking a
node. It stays as it is while the device layer is off; whether the lease and rotation states, which the device repairs
at its next wake, are still pushed is an open decision of the owner before the device layer is turned on.

**"I'm back"** is `POST /api/v1/light-node/wake` with `{"node_id": N}`: one silent push (`"action": "wake"`) to the
bound device, or, for a device without a push channel, a challenge for its next poll; it is unsigned and the dormant
rule does not apply to it. Every answer is

```
{"success": b, "reason": "sent" | "already_answered" | "no_device" | "not_registered" | "cooldown", "node_id": N,
 "retry_after_seconds": n}
```

with `success` true only for `sent` and `retry_after_seconds` only with `cooldown`: the caller's address over its limit
(the limit's wait), the node's three wakes of the epoch used or the last one less than 600 s ago (the wait), the last
60 s before the commit and the commit window (until the next epoch), the provider refusing the push (60), no anchor
(60), or a genesis that reached none of the owners (60). `already_answered`: the epoch already counted the node;
`no_device`: no device bound (or, with the device layer enforced, one whose record does not count); `not_registered`:
the chain has not registered the node. A genesis that does not own the node's shard checks only the registration and
hands the wake to the owners in rank order, answering with the first owner's answer; a backup owner hands it to the
ranks above it first and sends it itself only when none of them can be reached; each hand-off waits at most 2 s,
connection included. An owner behind the network answers `cooldown` with HTTP status 503, and a caller asks the next
owner; every other answer has status 200.

**The answer** is the ping reply of section 5.8. It may add three fields, decimal Unix seconds as strings (a genesis
of an earlier release takes a reply body of strings only): `sent_at`, copied from the push it answers, and
`received_at` and `answered_at`, the device's clock when the push arrived and when the reply left. They are never a
reason to refuse a reply. The shard owner that takes the reply measures, on its own clock `t`, the app's handling
`answered_at − received_at` and the delivery delay `(t − sent_at) − (answered_at − received_at)`, so the device's
clock cancels out; a value outside `[0, 28,800]` s, a `sent_at` more than 120 s ahead of `t`, or a handling longer than
`t − sent_at` by more than 120 s (the device's clock moved between its two times) measures nothing.

The reply may present the node's `ping_pubkey`, `ping_delegation_cert` and `identity_pubkey`. A genesis that already
holds that key and delegation with the identity they were proven under checks the reply's `σ` once, under them; it
checks a presented key it does not hold (after a bind or a key rotation, or one a gossiped row poisoned) before the
reply. A reply refused by the checks of section 5.8 is answered `{"success": false, "reason": "<code>", "error":
"..."}`; with `"reason": "ping_signature"` the genesis holds no ping key of the node, or another one, and the reply is
sent again with the delegation.

**Push receipts.** The answer may also carry `push_receipts`, the app's record of the pushes it received and did not
answer, as JSON text in a string field (at most 2,048 bytes; a genesis of an earlier release takes a body of strings
only and ignores the field):

```
{"since": E0, "pushes": [{"epoch": e, "sent_at": s | null, "received_at": s, "outcome": "<outcome>"}, ...]}
```

`pushes` holds at most 8 entries: each push received from epoch `E0` on that the app did not answer, with `epoch` the
epoch of the push's anchor, `sent_at` copied from the push, `received_at` the device's clock when the push arrived, and
`outcome` what the app did: `not_opened_since_boot` or `swiped` (the app answers only while it runs: opened since the
phone started and not swiped away since), `after_commit` (the push arrived after its epoch's commit), `answer_failed`
(no genesis took the answer), `already_counted` (the epoch was counted already), `no_key` (nothing to sign with here);
an entry may also say `answered`. `E0` is the first epoch from which the record holds every push the app received:
the epoch the record began, or once it is full the epoch of its oldest entry. A report covers the epochs from `E0` to
the one before its answer's own. The app sends the field with its answers, an empty list included, so that an epoch it
lists nothing for reads as "no push received"; it leaves the field out when its record covers none of those epochs or
its answer of each of them was taken, as there is nothing to refine. Numbers may also be decimal strings. A report longer than the bound, with more entries, or malformed is ignored whole.
It is unsigned display data read only once the answer verified and counted: it never changes crediting.

**Overload.** A genesis bounds the replies it handles at once and in one second (twice the most pushes it sends a
second), and `GET /api/v1/height` likewise (four times). Past the bound, after the per-address limit and before any
storage read or signature check, it answers HTTP 503 with a `Retry-After` header and

```
{"success": false, "reason": "overloaded", "error": "...", "retry_after_seconds": n}
```

with the same `n`: drawn at random from 60 to 300 s, so the callers it sheds come back apart, and never later than the
current epoch's commit less 60 s (at one block a second), so a reply sent again then still counts in its own epoch;
with less than 60 s left before that point, drawn over what is left; with none (the last 60 s before the commit and
the commit window), after the epoch's end by up to 60 s. Another genesis, a whitelisted address and a caller of no
known address are never shed.

**Polling.** A device this genesis does not push fetches its challenge with
`GET /api/v1/light-node/pending-challenge?node_id=N` (under the read-only per-address limit): the challenge left for it
by the pinger or a wake, or one for its own slot. A device this genesis pushes, or one whose device record does not
count, gets the answer of a polling device whose slot is not due (`{"success": true, "has_challenge": false,
"message": "Not your ping slot yet", "next_ping_time"}`), so the route tells nobody how a device is reached. The poll
may add `ts` and `sig`: the ping key's signed poll (section 4) within ±300 s. Only a signed poll counts as the
device's fetch of a challenge the pinger left it (a challenge fetched, for the misses and the dormant rule below); an
unsigned one is served alike and marks nothing, and the device's answer settles the epoch by itself.

**A reply inside the commit window** (from the commit to the epoch's end) is credited nowhere. The shard owner records
it, once it verifies, as that epoch's late answer, and answers

```
{"success": false, "node_id": N, "counted": false, "reason": "epoch_closed", "error": "..."}
```

It names no other epoch: the reply is that epoch's and counts for nothing, and nothing is moved to the next epoch. The
app does not answer inside the commit window at all; the next epoch is answered by its own pushes or by the app's own
answer during it. A reply whose anchor is not a canonical block of the current epoch is refused with
`"reason": "anchor_not_current"`; when the anchor is of the epoch just ended and the node's ping key signed it, the
shard owner records that epoch's answer as late.

**Misses.** When the commit window opens, each shard owner records, for every node it pushed that epoch and that was
not counted, why (`device.last_miss`, section 7): a reply refused in time for a reason only the node itself causes
(`answer_refused`: a replaced device, a device record that does not count, a device counter not above the last, a
reply without the device signature after enforcement; the record and enforcement refusals, decided before any
signature is checked, only once the reply's `σ` verifies under the node's ping key and delegation, and none of the
device refusals while the genesis does not serve the device layer, when no app sends a device reply), else a push the provider took or a challenge the device
fetched by a signed poll with no answer (`woken_no_answer`), else no push address (`no_push_address`: no token, the
token gone, or a challenge no signed poll fetched), else every push due failed at the provider or never went out (`not_sent`: the system's
miss, never the device's). A late reply turns that epoch's record into `answered_late`, with `delivered_at` `t −
(answered_at − received_at)` when the reply told both. A node the dormant rule held records nothing: the status
derives `not_woken_inactive` when read. Before the misses, the owner stores its reach records of the epoch.

The push receipts of the node's next counted answer, taken by a shard owner at its clock `t`, refine that owner's
record when it is a `woken_no_answer` not refined before, of an epoch before the answer's own (the epoch of its anchor;
a record of that epoch or a later one, and a reply to a server stamp, are left as they are), by the epoch the record
names:

- an entry of that epoch: the first one received gives `delivered_at` = `t − (answered_at − received_at)`, the answer's
  own `answered_at`, so the device's clock cancels out (nothing when `answered_at` is absent, before `received_at`, more
  than 7 days after it, or when the result is more than 120 s before the entry's `sent_at`: the device's clock moved),
  `delivery_delay_secs` = `delivered_at − sent_at` (in `[0, 28,800]`), and `app_outcome`, its `outcome` (null for one
  this genesis does not know);
- no entry of that epoch, `E0` at most that epoch, and only a push the provider took woke the node (no challenge
  fetched): the reason becomes `not_delivered`, the push service or the phone held it.

The record is node-local, one row per node overwritten by the next, and no block rule reads it.

## 6. Statements

### 6.1 Lease statement (device oracle, ML-DSA-65)

```
qnet_device_lease:v1|{chain_id}|{N}|{hex(device_tag)}|{lease}|{effective}|{gate}|{pi_digest}|{issued_at}
```

| Field | Values |
| --- | --- |
| `lease` | `claimed_virgin` (the slot read never used), `self_reclaim` (the slot holds this node's generation), `claimed_foreign` (another generation), `none` (no slot read) |
| `effective` | `now` (current epoch) or `next` (next epoch): `now` only for `claimed_virgin` with a new key and for `self_reclaim` |
| `gate` | `ok`, `metric_high` (iOS risk metric above its bound), `certs_high` (Android certificate count above its bound), `na` |
| `pi_digest` | hex SHA-256 of the decoded Play Integrity verdict payload; empty on iOS |
| `issued_at` | Unix seconds; attestors accept it within 10 minutes |

The oracle signs the UTF-8 preimage with its ML-DSA-65 key, whose public key the node binary pins.

### 6.2 Device statement (genesis attestors, 4 of 5)

```
qnet_device_stmt:v1|{chain_id}|{N}|{hex(device_tag)}|p256|{hex(sha3(hw_pub))}|{platform}|{prov}|{trust}|{op}|{issued_epoch}|{effective_epoch}|{state}|{hex(sha3(L ‖ oracle_sig))}
```

| Field | Values |
| --- | --- |
| `platform` | `ios`, `android` |
| `prov` | `rkp` (Android remote-provisioned chain), `factory` (Android factory-provisioned chain), `na` (iOS) |
| `trust` | `store` (the app as the stores sign it) or `test` (a build signed with the developer's own key, section 9) |
| `op` | `enrol`, `rotate`, `rebind` |
| `state` | the initial state (section 8) |
| last field | SHA3-256 of the UTF-8 lease statement `L` followed by the oracle's raw signature; `sha3("")` for a statement made without a lease |

Each attestor re-verifies the public evidence and signs the preimage with its consensus key; four signatures make the
statement final. The record is keyed by `N`, and one `hw_pub` belongs to one node at a time. The record's
`rotation_due` follows the device key (section 5.4).

The lease window (`lease_valid_until`, `refresh_at`) rides beside the statement, outside every signature. Each genesis
clamps it to at most 28 days (the oracle's 21-day window and its 7-day outage extension) past the lease statement's
signed `issued_at`, and reads a record that holds a lease but no window as lapsed: `check_pending`, its refresh due at
once.

### 6.3 State change (the genesis that caused it)

```
qnet_device_state:v1|{chain_id}|{N}|{state}|{state_seq}|{until_epoch}|{reason}
```

`state_seq` increases per node and never moves back; `until_epoch` is the end of a pause and `0` otherwise. Reasons:

| `reason` | Change |
| --- | --- |
| `registered` | the registration applied: `awaiting_registration` → `active` or `pending_next_epoch` |
| `epoch_reached` | `pending_next_epoch` → `active` |
| `refresh_ok`, `check_passed` | → `active` |
| `anomaly` | a refresh read an unused slot; the second within 90 days → `suspect` |
| `strike` | a refresh read another generation → `suspect`, lease 12 hours |
| `two_strikes` | a second foreign read within 7 days with an independent signal → `paused` for 30 days |
| `lease_lapsed`, `rotation_overdue`, `verdict_failed`, `metric_high`, `certs_high` | → `check_pending` |
| `revoked`, `hold` | an attestation certificate revoked, or the Android hold flag set → `paused` |
| `released`, `rebound`, `superseded` | → `ended` |
| `reset` | reserved: no node path makes it, and it lifts no pause |

A change never lifts a pause that is still running to a lighter state, whatever its sequence or reason: a timed pause
ends at its own epoch, a revocation's pause with a new enrolment's statement. A change that renews the lease carries
the new window beside it, unsigned; each genesis clamps it to at most 28 days past its own clock (section 6.2).

A change carries the signature of the one genesis that caused it. A change to a lighter state (`refresh_ok` or
`check_passed` out of `check_pending` or a lapsed lease) is taken on that one signature; the oracle does not sign its
refresh or recheck answers.

### 6.4 Revocation snapshot (device oracle)

```
qnet_crl:v1|{fetched_at}|{hex(sha3(list))}
```

`list` is the revoked or suspended certificate serials of the Android attestation status list, each lowercase hex
without leading zeros, sorted ascending as strings, joined by `\n` without a trailing newline. The oracle signs the
preimage and serves it with the list; each genesis checks the stored serials every epoch.

## 7. Status

**Public:** `GET /api/v1/light-node/status?node_id={N}` returns

```
{"onchain_registered": b, "registration_pending": b, "device_bound": b, "answered_this_epoch": b,
 "needs_reactivation": b, "counted": {"epochs_since_registration": n, "counted": n, "last_counted_epoch": n},
 "burn_tx": "<base58>" | null, "device": {...} | null, "features": [...], "authoritative": b}
```

`device` is `null` while the node is not on chain, otherwise
`{"platform": "android" | "ios" | "unknown" | null, "model": "<model>" | null, "linked_since": s | null,
"last_answer_epoch": n | null, "state": "online" | "offline" | "unlinked" | "other_device_pending",
"last_miss": {"epoch": n, "reason": "<reason>", "delivered": b | null} | null}`. Anyone can read the public form for any
wallet's node, so it carries no time of an answer, a wake or a delivery and nothing of what the app did: those are in
the signed form only (below). `state` is `unlinked` while no
device is bound, `online` while one is and the node does not need reactivation, `other_device_pending` while the device was linked
less than one epoch (14,400 s) ago by its binding's sequence and nothing counted the node in this epoch or the two
before, and `offline` otherwise. `platform` is `null` while no device is bound; otherwise the platform the device
record of this binding proved, else the hint the bind named (`"platform": "android" | "ios"` in the `/light-node/bind`
body, unsigned and never a reason to refuse), else `unknown` (also at a genesis that took the binding from a peer
before the token sync reached it). `model` is the model the bind named (section 4), `null` while no device is bound,
when the bind named none or this genesis does not have it yet (as for `platform`), and when the bind named a platform
other than the one the device record of this binding proved. `linked_since` is the UTC day (Unix seconds at 00:00) of the binding's sequence, `null` while no device is
bound or for a binding with no sequence. `last_answer_epoch` is the current epoch when the
node answered in it, else the last epoch it was counted in, else `null`.

`last_miss` is the latest epoch the node was not counted in, as the answering genesis saw it (section 5.10). The public
form gives its `epoch`, its `reason` and `delivered`: `true` when a late answer or the push receipts of a later answer
dated the push's delivery or told what the app did with it, `false` for `not_delivered`, else `null`. The signed form
gives it whole:

```
{"epoch": n, "reason": "woken_no_answer" | "answered_late" | "not_delivered" | "not_woken_inactive" | "no_push_address"
 | "answer_refused" | "not_sent" | "not_committed", "delivered": b | null, "woken_at": s | null, "answered_at": s | null,
 "delivery_delay_secs": n | null, "refused": "<code>" | null, "delivered_at": s | null, "app_outcome": "<outcome>" | null}
```

`woken_no_answer`: a push the provider took, or a challenge the device fetched, and no answer before the commit.
`answered_late`: an answer to that epoch came after its commit, inside its commit window or later; it counted nowhere.
`not_delivered`: a push the provider took that never reached the phone: the device, answering later, sent push receipts
covering that epoch with no push of it (section 5.10), so the push service or the phone held it. `not_woken_inactive`:
the dormant rule left the node unpushed; derived when read from the epochs indexed for `counted` (the last finished
epoch, when the node was counted in none of it and the two before and was past its first three epochs for the whole
of it), and served only where the answering genesis proves the rule for that epoch (two proven device misses before
it, section 5.10), so a genesis holding no reach record of the node serves none. `no_push_address`: nothing to push to
and no challenge fetched, or the provider said the token is gone. `not_sent`: every push due that epoch failed at the
provider or never went out (shed by the pacing, no anchor): the system's miss. `not_committed`: the node's shard
committed no row in that epoch (derived when read for the last finished epoch the answering genesis indexed, the node
in its roster), so nobody of the shard was counted: the system's miss. Neither `not_sent` nor `not_committed` ever
counts toward the dormant rule.
`answer_refused`: an answer in time refused for a reason only the node itself causes, `refused` naming it
(`superseded`, `device_not_counted`, `no_device_record`, `device_counter`, `legacy_after_enforcement`). `woken_at` is
when the provider took the epoch's first push (or the device fetched its challenge), `answered_at` when the late or
refused answer came. `delivered_at` is when the push reached the phone, on the genesis's clock, and
`delivery_delay_secs` how long after its `sent_at`, as the late answer or the push receipts of a later answer told;
`app_outcome` is what the app did with that push by its receipt (`not_opened_since_boot`, `swiped`, `after_commit`,
`answer_failed`, `already_counted`, `no_key`, `answered`), so a `woken_no_answer` with `delivered_at` reads "the wake
reached this phone at `delivered_at`, `delivery_delay_secs` after it was sent, and the app did not answer:
`app_outcome`" and a `not_delivered` reads "the wake never reached this phone". Of the genesis's own record and the
dormant rule's, the later epoch is served, at one epoch the one that tells more. `last_miss` is `null` while no device
is bound, and shows nothing from before the binding the answering genesis holds. Only a genesis owning the node's light
shard keeps its record, the one that pushed the node or took its answer: a reader takes, among the owners that answer,
the `last_miss` with the highest epoch, at equal epochs the most specific (`not_committed`, `answered_late`,
`not_delivered`, `answer_refused`, `woken_no_answer`, `no_push_address`, `not_sent`, `not_woken_inactive`), at an equal
reason the one with `delivered_at`, else with `app_outcome` (in the public form, the one with `delivered`). A reason it
does not know is ignored, never shown, and an outcome it does not know reads as `null`; a node of an earlier release
sends no `last_miss`, one before push receipts sends neither `delivered_at` nor `app_outcome`, and one before this form
carries the whole record in the public form too.

`authoritative` is true when the answering node's height is at least the network height it has cached (the rule of
`verify-activation`); while it is false the node is behind, and its `onchain_registered: false` or
`registration_pending: false` settles nothing: ask another node. `burn_tx` is the base58 signature of the burn the
applied registration names (`null` until it applied); it is public on Solana and in the registration row already.
The public form never carries `device_tag_h`, whatever the query (section 5.9). `counted` covers at
most the last 64 finished epochs since the registration that the answering genesis indexed; an epoch it never indexed,
and one in which the node's shard committed no row, is in neither number, and `last_counted_epoch` is `null` when the
node was never counted in that window. `needs_reactivation` is true only when neither the committed index of the two
finished epochs before, nor this epoch's answers, nor an owner counts the node, past its first three epochs; an epoch
of those two that the answering genesis did not derive, or in which the node's shard committed no row, says nothing of
the device and never makes it true. Before it reports an on-chain node inactive, a genesis asks every other owner of
the node's light shard at once (the owner that took this epoch's answer may be any of the three), and reports it
answered when an owner that sees it on chain took its answer, active when any owner reports it active.

**Signed:** `POST /api/v1/light-node/status` with `{"node_id": N, "ts": ts, "signer": "ping" | "wallet", "sig": "<hex>"}`,
the signed-status message of section 4 within ±300 s, returns the public fields and `binding_seq`, `bound_at`,
`registered_height`, `device_state`, `effective_epoch`, `refresh_window` (`{"from": s, "to": s}`, Unix
seconds, jittered), `rotation_due`, `paused_until`, `ref` and `push_reregister`, and its `device` is whole: the public
fields, `last_answer_at`, `last_miss` with every field above, and `last_answer`. `last_answer_at` is the Unix time of
the answer that counted the node in its latest counted epoch, of the current epoch and the two before: the stamp of the
pinger that took the answer, which only a genesis owning the node's light shard keeps, so every owner that took the same
answer gives the same time and any other genesis gives `null`. `last_answer` is `{"at": s, "delivery_delay_secs": n |
null, "handling_secs": n | null}`, the last answer that counted the node as this genesis took it: when it came, how long
its push took to reach the device and how long the app took with it; `null` while no device is bound and for anything
before the binding the answering genesis holds, and a reader takes the latest of the owners'. `push_reregister` is true while a
device is bound and the answering genesis cannot push it (it holds no push channel of the binding, or the provider
said this epoch that the token is gone): the app then registers its push token again when it is opened and when it
returns to the foreground. It is signed only, since it tells how the device is reached. `effective_epoch`,
`rotation_due` (the epoch from which
the device key's rotation is due) and `paused_until` are epochs, `null` when they do not apply; the six device fields
are `null` until the node serves `device_v1`. The wallet form adds `"identity_pubkey": "<hex(K)>"`, which a node that
never held a binding needs (it is checked against the registration's commitment). Either form may add `"nonce": "<32
hex>"`; the answer then carries `"device_tag_h": "<16 hex>"` while a device is bound, a different value for every
nonce. `binding_seq` is the sequence a new binding must beat, `0` while the node never had a binding.
Refusals: `bad_request`, `expired`, `not_registered`, `identity_mismatch` (wallet form, no key the chain vouches for),
`bad_signature` (not the node's current key of that kind, so a ping key whose binding was replaced gets it too),
`rate_limited`.

**Features** a client switches on only when two genesis nodes both list them: `bind_v2`, `delegation_v2`,
`unbind_v2`, `unbind_wallet` (the wallet unbind of section 4), `token_refresh_v2`, `push_v2`, `wake`, `pending_bind`,
`consent_24h`, `uptime`, `device_v1` (`/bind` takes `device`), `hwping_v2` (`ping_hw2` replies), `status_signed`,
`owner_bind_v2` (the submit door and the attestor take the owner bind v2 of section 4: listed only while the height the
node judges for, its tip + 1, is at or above the `wallet_one_node` gate; not `bind_v2`, the device binding).

## 8. States and refusals

| State | Meaning | Counted |
| --- | --- | --- |
| `awaiting_registration` | the statement is final and the registration has not applied yet (24 hours) | no |
| `pending_next_epoch` | counts from the next epoch | no |
| `active` | counts | yes |
| `suspect` | counts; lease 12 hours; watched | yes |
| `check_pending` | a check is not finished (lease, rotation, verdict, a gate, a vendor outage); rechecked daily | no |
| `paused` | stopped until `until_epoch`; the accrued node balance stays claimable | no |
| `ended` | released, rebound or superseded | no |

An Android node the certificate-count gate holds in `check_pending` (`certs_high`) is released only by a key rotation,
which re-checks the gate with the new key's evidence: the oracle's daily recheck answers it `"needs": "rotation"`, and
the node takes that rotation when it falls due (section 5.4).

`/light-node/bind` answers `{"success": true, "bound": true, "node_id", "seq", "device_fp"}` for exactly the sequence
sent, or `{"success": true, "bound": false, "pending": true, "node_id", "seq", "device_fp"}` for a binding kept pending
until the registration applies; with a device block both add `device_state` and `effective_epoch`. A device refusal
adds `ref` once the key is known, `retry_after_seconds` when a later retry can pass, and `paused_until` for a running
pause.

`/light-node/bind` refusals carry a stable `reason`: `not_registered`, `identity_mismatch`, `stale_seq`,
`future_seq`, `bad_signature`, `expired`, `rate_limited`, `bad_request` (malformed push fields, a consent whose burn is
not a 64-byte signature, or `seq`/`ts` other than the consent's `T`), and for the device block `device_unsupported` (the device
cannot prove its hardware), `device_not_genuine`, `device_app_unrecognized`, `device_emulator`,
`device_compromised`, `device_desktop`, `device_secondary_user`, `device_unlicensed`, `device_stale`,
`device_key_in_use`, `device_slot_paused`, `device_rate_limited`. `check_pending` is a state, not a refusal. A claim
of the node balance needs no device. A signature that does not verify gets `bad_signature` before any refusal that
depends on the stored binding.

The other routes' `reason` values:

- `/light-node/unbind`: `bad_request` (also a ping form with `identity_pubkey`, and a wallet form without it or with
  `device_release`), `expired`, `not_registered`, `identity_mismatch` (wallet form: a `K` the registration does not
  vouch for or whose address is not the node's), `stale_seq` (no device bound, a legacy binding, or a signature over
  another sequence than the stored one's), `bad_signature` (also a device whose binding was replaced), `rate_limited`.

- token refresh: `stale_seq`, `bind_v2_required` (a legacy refresh for a node with a v2 binding), `bad_signature`,
  `expired` (outside ±300 s, or older than the message that last set the channel), `rate_limited`, `not_registered`,
  `bad_request`.
- ping reply: `superseded` when a later binding replaced this device's ("The node runs on another device").
- the legacy `/light-node/register` for a node on chain: `bind_v2_required` when the node has a v2 binding, told only to
  a caller that presents the node's committed key and that key's signature over the wallet address; any other caller
  gets the inert `already_registered`, whatever is bound. For a node not on chain yet, a wallet that derives from
  neither the presented key nor the burn wallet is refused `wallet_not_derived`.
- `POST /api/v1/rewards/claim`, step 1: `key_not_wallet` (the public key does not derive the wallet) and
  `bad_signature`, beside the error text.
- `POST /api/v1/node-registration/submit`: every refusal carries a stable `code` (`already_registered`,
  `behind_chain`, `committee_unavailable`, `quorum_pending`, `mempool_rejected`, `timestamp_window`, `bad_request`,
  `rate_limited`, `wallet_has_node`, `bind_v2_pending`) beside its text; a resubmit while the registration is pending
  answers `success` with the pending `tx_hash` and `"pending": true`. `wallet_has_node` (from the `wallet_one_node`
  gate) is final: the wallet already has another node on chain, named by `node_id`. The door answers
  `already_registered` (this node's own id on chain) before it. The legacy `/light-node/register` answers the same
  code for a fresh registration. `bind_v2_pending` is a retry: the owner bind is the v2 form and verifies, every
  other check passes, and the node does not take v2 yet (section 4); send the same submit again once two genesis
  nodes list `owner_bind_v2`. The retryable codes are `behind_chain`, `committee_unavailable`, `quorum_pending`,
  `mempool_rejected`, `rate_limited` and `bind_v2_pending`. `quorum_pending` also answers a quorum the door gathered
  that the judge every node runs on the registration (at the next height) would not take: nothing is pooled. A
  request from a web page whose `Origin` is not `https://aiqnet.io`, `https://www.aiqnet.io` or a
  `chrome-extension://` or `moz-extension://` origin is answered 403 `{success: false, error: "Origin not
  allowed"}` before any check; a request with no `Origin` is served.

**Legacy registration.** The legacy registration's gossip carries no push endpoint; a node's push channel travels
between the genesis nodes only in their token sync. For a node on chain with no v2 binding, the legacy
`/light-node/register` authenticates with the node's committed key and that key's signature over the wallet address,
which is static: the previous binary broadcast it in gossip, so a listener who kept one can replay it. Such a request
changes the node's push record, and sends it to the other genesis nodes, only when its ping key and legacy delegation
were newly written here (a key the wallet newly delegated); a replay of the current delegation writes nothing new and
leaves the record as it is, and a legacy delegation of a key the node held before its current one is refused as older
on every path that copies a ping key, so no replay rolls the key back. Each binding row keeps the fingerprints of the
last 8 legacy keys it moved away from for this. An installed app changes its push token through the token refresh,
which its ping key signs with a time; a v2 binding closes the legacy path for that node at once.

## 9. Provisioning and trust

- **`prov`**: an Android chain with the provisioning-information extension (OID `1.3.6.1.4.1.11129.2.1.30`) issued
  by the remote-provisioning CA is `rkp`; at most one live node per remote-provisioned attestation key. Another
  hardware chain to a Google root is `factory`: its lease is 1 day, and its device key takes one rebind per day. A
  factory attestation key is shared by a batch of devices, so the limit of two claims on another generation per day
  per attestation key, like the one-live-node rule, applies to remote-provisioned attestation keys only. iOS is `na`.
- **Slot check on a claim**: claiming again from the same install does not skip the slot check. A claim by the install
  that already holds the node's slot value (the same device key, while its oracle record is live or within 30 days of
  an unbind) is judged as a refresh would judge it: another install's value on the slot is a strike (`claimed_foreign`,
  `effective` `next`), and a second strike within 7 days with an independent signal pauses the node for 30 days and
  refuses the claim `device_slot_paused`. The value this install's other node on the same key wrote (a wallet switch
  inside the install) does not count.
- **Lease window**: 21 days (section 6.2), 1 day for a `factory` chain, and 12 hours for any claim or refresh of a
  record whose strike is still live, whatever its state (`suspect`, `pending_next_epoch` or `check_pending`).
- **App Attest receipts** chain from Apple Root CA - G3 through "Apple Application Integration CA 5 - G1" (O = Apple
  Inc.) to a signer certificate carrying the receipt-signer extension `1.2.840.113635.100.12.15`; a receipt under any
  other intermediate, or signed by an unmarked certificate, is refused (`untrusted_root`).
- **`trust`**: `store` for the app as the App Store or Google Play signs it (on Android the Play app-signing
  certificate, the same file whether it comes from Google Play or from aiqnet.io; on iOS the production App Attest
  environment). On Android a `store` install also needs Google Play's licence (`device_unlicensed` otherwise): a copy
  from Google Play has it, and a copy from aiqnet.io gets it once the user accepts Google Play's licence dialog. The
  verdict of a licensed `store` install must also carry Google's app-access-risk verdict
  (`environmentDetails.appAccessRiskVerdict`), which Google evaluates only on phones, tablets and foldables and returns
  only while that optional verdict is turned on for the app in Play Console; without it the device is refused with
  `device_desktop` (log code `form_factor_unevaluated`), so until the switch is on every licensed Android install is
  refused. An install whose licence Google did not evaluate (`UNEVALUATED`) passes without it, on the one-day lease.
  Turning the verdict on is a release step ([store listing](../../applications/qnet-mobile/store-listing/README.md),
  "Before submission"). `test` for a build signed with the developer's upload or development key (the development App Attest
  environment on iOS). A `test` device statement is refused on mainnet; a testnet node accepts it only under its
  node-local test rule, so a locally built app runs the whole flow.

## 10. Test vectors

`light-node.vectors.json` holds:

| Key | Content |
| --- | --- |
| `constants` | chain id and tag, epoch length, key sizes, platform bytes, and the QNet Link revision 2 constants |
| `wallets` | two phrases (the 12-word KAT phrase and a 24-word phrase): the 64-byte seed of the phrase, seed string, `xi`, `K`, `sha3(K)`, `W`, `N`, `walletHash` |
| `pingKey`, `burner` | the test ping key (from a seed string) and the test burner key (Ed25519 seed and Solana address) |
| `anchor` | `h`, `hash`, `epoch(h)` |
| `node` | per wallet: the burn, `proof`, and every message of section 4 with its inputs, preimage, SHA3-256 and signature |
| `device` | the test device keys (iOS and Android, each with its rotated key), `rpIdHash` of a sample Team ID, the Android report and `report_sig`, every message of section 5 with its preimage, `clientDataHash` or attestation challenge, Play nonce and device signatures (iOS assertions as CBOR with `authenticatorData`, counter and `nonce`; Android DER and raw `r ‖ s`), the ping reply of both platforms with its wire form, the lease and device statements with the oracle's signature, a state change, a revocation snapshot, `device_tag`, `device_tag_h` and `ref` |
| `link` | QNet Link revision 2 ([QNet Link v1](qnet-link-v1.md) section 14.12) |

`light-node-own-burn.vectors.json` (generator `docs/protocols/tools/own-burn-vectors.mjs`, `--check` as below) holds,
per wallet of this file, a burn made from the wallet's own Solana address: that key on `m/44'/501'/0'/0'` (seed, public
key, address), its owner bind v1 of the wallet's burn at the consent's `T` (the preimage is this file's `ownerBind`,
only the signer differs), the `link` request with `burner`, its bytes and `reqHash`, the answer with `consent.ownerSig`,
and the body the site submits to `POST /api/v1/node-registration/submit`. The node's own test admits that body
unchanged at the door and in a block, on both sides of the `wallet_one_node` gate
(`development/qnet-integration/src/node/mod.rs`, `own_burn_vector_is_admitted_unchanged`).

Device signatures are deterministic (RFC 6979 nonce) so the file is reproducible; real devices sign with random
nonces, and both verify the same way. The iOS assertions are built with a test key: vendor certificate chains and
attestation objects are checked with the vendors' own samples. The verifier crate `core/qnet-device-attest` checks
every device signature and assertion of the file, Apple's published attestation object and its receipt, and device
chains to the Google roots (`cargo test -p qnet-device-attest`).

```
node docs/protocols/tools/light-node-vectors.mjs           # regenerate
node docs/protocols/tools/light-node-vectors.mjs --check   # fail if the file is stale
```

The generator takes SHA-2, SHA-3, SHAKE256, PBKDF2, X25519, HKDF, AES-GCM, Ed25519 and every P-256 check from
`node:crypto`; it computes BLAKE3 and the RFC 6979 nonce itself and checks both against published answers; it signs
ML-DSA-65 with the `@noble/post-quantum` of the app (or the extension's crypto bundle) and verifies every signature
again with each other copy it resolves. The app's Jest run executes `--check`.
