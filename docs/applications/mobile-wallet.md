# Mobile wallet and light node

This document describes the QNet mobile application in `applications/qnet-mobile`: a non-custodial
React Native wallet for iPhone, iPad, Android phones and Android tablets — one app with the same screens, texts and
buttons on all four — that holds a post-quantum QNet identity, signs transactions on device, verifies balances
against a committee quorum certificate, and runs this wallet's light node on the device.

## What the app does

- Creates or imports a recovery phrase and derives three independent keys from it (QNet, Solana, secp256k1).
- Displays QNC balances, QRC-20 token balances and transaction history; sends native QNC and QRC-20 tokens, and SOL
  and 1DEV from the wallet's Solana address ([Solana sends](#solana-sends)).
- Verifies balances and token transfers against a quorum certificate produced by the consensus
  committee, using proofs served by a node but checked entirely on device.
- Shows this wallet's light node as the network records it, whichever device or channel registered it, runs it on
  this device ([The Node tab](#the-node-tab)) after a hardware check of the device ([The device
  check](#the-device-check)), and answers the network's per-epoch requests in the background
  ([Liveness](#liveness-pings-and-self-attestation)). A light node is registered on aiqnet.io in a browser, or by the
  QNet [browser extension](browser-wallet.md).
- Shows this wallet's super node, which is activated only in the QNet browser extension on a computer and runs on a
  server with the QNet node software ([running a node](../operators/running-a-node.md)): its status, when it was last
  seen, its heartbeats this epoch, its counted and missed epochs and its node balance ([The Node tab](#the-node-tab)).
  The app only shows it; it activates no node of either type.
- Confirms that aiqnet.io may prepare this wallet's light node with a one-time payment address, gives this wallet's
  consent to its node, links it to this device, unlinks it from the device it runs on (from that device, or from any
  other device that holds the wallet), or moves its node balance, when the user started that on aiqnet.io and confirms
  it on a sheet a verified link opens ([QNet Link](#requests-from-aiqnetio-qnet-link)).
- Moves a node balance into the wallet.
- Opens websites in a built-in browser whose pages can connect the wallet through the same provider as the
  browser extension ([In-app browser](#in-app-browser)).

The UI is a single wallet screen with a bottom bar of five tabs — Assets, History, Browser, Node, Settings
(`src/components/BottomBar.js`, drawn icons, the active tab lit, clear of the gesture bar and home indicator).
Send and Receive are buttons on Assets (Send opens QNC on the QNet side and SOL on the Solana side, and each token row
opens its own Send); the QNet Send form switches between QNC and every QNet token the Assets list shows, the Solana form
between SOL and 1DEV; Android back returns from Receive and the other tabs to Assets.
It includes QR receive, clipboard copy, hideable balances and spam-token hiding. The Assets address card and Receive
show the address whole on one line (the font shrinking before anything wraps or is cut; a larger system text size
counts up to 1.2 times there, so the smallest fit still holds the whole address on a 320 dp screen), as the QNet Link
sheet and a site's connect sheet show both addresses, and a tap on it copies it
("Copied" for two seconds); there is no separate Copy button. Receive has the title "Receive", the QR code and one
line: "Your QNet address for QNC and QNet tokens." or "Your Solana address for SOL and Solana tokens.", with no
warning boxes. The screens carry titles, labels, short buttons and short errors; a confirmation line appears only
where an action cannot be undone (a send, deleting the wallet, the recovery phrase). Creating a wallet ends when the
user presses the last step's button; no screen closes or moves on by itself. Settings → Auto-Lock Timer offers 1, 5,
15 or 30 minutes of inactivity, or Never (no inactivity timer: the wallet locks with Lock Wallet, or when the app process
ends); a longer time than the current one asks for the password or the screen lock first. Solana is devnet only, with no fiat
values, in every build while QNet is a test network (`src/config/nodes.js`). The layout adapts to the screen: tab
content sits in one centred column on tablets, tab labels shrink to fit, and dialogs scroll and stay above the
keyboard; the iPad build takes every orientation, Split View and Slide Over.

Every interface string is in 11 languages: English (the source), Chinese (Simplified), Russian, Spanish, Korean,
Japanese, Portuguese, French, German, Arabic and Italian — one file per language in `src/i18n/locales/`, looked
up with its `{placeholders}` by `src/i18n/index.js`. The first start follows the phone's language when the app has
it, else English: Android's locale, and on iPhone and iPad the first of the user's preferred languages (the one set for
the app in the iOS Settings included); Settings → Language changes it (a display preference, kept when the wallet is
deleted). The iOS build declares the same eleven languages (`CFBundleLocalizations`), so the App Store lists them, and
the purpose strings iOS itself shows (Face ID, camera) come in each (`ios/QNetMobile/<lang>.lproj/InfoPlist.strings`). Arabic
lays the screen out right to left; addresses, hashes, codes and amounts stay left to right, and a value put into an
Arabic sentence is wrapped in a bidi isolate. The wallet's own errors are translated by code; what a node answered
is shown after them as details. The native prompts (biometric and Face ID reasons, the Android biometric button, the
iOS screen-recording cover and screenshot warning) get their words from the same tables. Recovery phrases,
addresses, env names (`QNET_*`), token symbols and brand names are never translated. The few texts that name Google
Play live in `src/i18n/overlays/android/` (`overlay.android.js`), which no iOS build carries. Tests: every key in every
language with the same placeholders (`__tests__/I18n.test.js`), no hard-coded user-visible string in the screens
(`__tests__/I18nHardcoded.test.js`), and the real screens rendered at 320 dp in every language and with the longest
text of every key, checked for cut-off text, words that do not fit and overflowing rows (`__tests__/I18nLayout.test.js`).

## Identity and key derivation

One mnemonic yields three keys with strictly separated roles.

| Key | Algorithm | Derivation | Used for |
| --- | --- | --- | --- |
| QNet wallet key | ML-DSA-65 (FIPS 204) | `SHAKE-256("QNET_WALLET_MLDSA65_v1:" + hex(seed))`, where `seed` is the 64-byte recovery-phrase seed, truncated to a 32-byte keygen seed; Settings → Export Private Key shows this keygen seed (64 hex characters), from which any FIPS 204 implementation rebuilds the key pair | Every QNet signature: transfers, contract calls, the consent to its light node, the node's delegation and attach, moves of the node balance |
| Solana key | Ed25519 | `m/44'/501'/{account}'/0'` (ed25519-hd-key); exported as the 64-byte secret key (seed and public key) in base58 | The Solana address (devnet balances, shared on a `connect` request), the SOL and token transfers the user sends from it ([Solana sends](#solana-sends)), and the owner bind of a light burn made earlier from that address, beside the consent on a `link` sheet ([QNet Link](#requests-from-aiqnetio-qnet-link)); a website gets no Solana signature of its own choosing |
| secp256k1 key | secp256k1 | `m/44'/60'/0'/0/0` | A secp256k1 address only; derivation failure leaves the field null rather than failing wallet creation |

The EON address is `SHA512(raw ML-DSA-65 public key)` rendered as 19 hex characters, the literal
`eon`, 15 hex characters and an 8-hex SHA3-256 checksum over the first 37 — 45 characters total.
Recipient addresses are validated against that layout, checksum included, before anything is signed; a
64-character hex value (a contract or a transaction id, which no key controls) is refused as a recipient.
Key sizes are 1952-byte public key, 4032-byte secret key, 3309-byte detached signature.

## Key storage and custody

- The mnemonic and secret keys live in an envelope-encrypted vault (`src/crypto/Vault.js`, version 4). A
  random 256-bit data key encrypts the wallet with AES-256-GCM, the vault id bound in through the
  associated data. The data key is wrapped by a key derived from the password (PBKDF2-SHA256, 600,000
  iterations); that wrap is sealed again by a non-exportable device key (Android Keystore; on iOS a P-256 key in the
  Secure Enclave, this device only, no user authentication, the wrap sealed to it with ECIES), so a copy of the app's
  storage cannot be guessed at or opened on another device even with the password. An iOS password wallet sealed
  before this key existed gets the seal at its next password unlock. Older vault versions are
  read only to migrate them. A last good copy is kept as `qnet_wallet.bak`, and a vault that cannot be
  parsed is left as it is, never deleted.
- Changing the password gives the vault a new data key: the payload, the recovery phrase and every record
  sealed under the old key (connected sites, the addresses this wallet paid, light-client anchors) are sealed
  again under the new one and written together
  with the vault, so a data key captured before the change opens nothing written after it. The biometric
  wrap held the old key, so biometric unlock is off afterwards. The same rotation runs at the first password
  unlock after a new fingerprint or face invalidated biometric unlock; if its write fails, the vault stays
  as it was, the failure is logged and the rotation runs again at the next unlock.
- Android device seal: the key that seals the password wrap (`qnet_vault_seal_v2`, StrongBox where present)
  needs no user authentication and is not bound to the screen lock, because Android 12-14 delete keys
  bound to the screen lock for good when it is removed. A vault sealed by the first seal key (`v1`, made
  with the unlocked-device requirement) moves to the current one at its next open, by password or
  biometrics, and the old key is deleted once no stored vault names it. No vault key is bound to the
  screen lock. A seal key is made only for a new or unsealed vault, and only when a listing of the Keystore that is
  known to have been answered leaves it out: Android's reads (`containsAlias`, `getCertificate`, and below Android 12
  `getKey`) answer "no key" for a Keystore that failed as well (`KeyPresence.kt`). Sealing never makes a key, so a
  rotation keeps the key that sealed the vault it just opened, and a read that finds nothing without such a listing is
  a "try again", never a lost key, for the seal, the biometric key and the screen-lock key alike. On iOS a Secure
  Enclave answer other than a ciphertext this key did not seal (a locked device, an enclave that did not answer) is a
  "try again" too.
- Unlocking opens a session: the data key stays inside `WalletManager` as a non-extractable key behind an
  opaque token, and the screen holds the token, never the password.
- Every password check (unlock, reveal, password change, biometric enrolment, delete) goes through one
  lockout (`src/utils/passwordLimiter.js`): the first three failures are free, then the wait starts at
  1 second and doubles up to 30 minutes. The failure count and the end of the wait are kept in the
  Keychain and measured on the clock that counts from boot, so moving the wall clock back does not
  shorten a wait, and a reboot starts the whole wait of the last failure again. A stored count that exists but cannot
  be read counts as the most failures; an iOS read refused only for the moment (`errSecInteractionNotAllowed`: the
  app woke for a push or a background task while the phone is locked) is no answer, kept nowhere, and the next check
  reads the item again, so a background launch never costs the free attempts.
- A new wallet password (create, import, change, and the new password of a wallet whose screen-lock secret is gone)
  needs at least 8 characters, typed twice: under the field a line "At least 8 characters" turns from × to ✓ while
  typing, and under the second field the two are compared. Nothing else is checked (`src/crypto/PasswordStrength.js`,
  the one copy the browser extension's core bundle compiles too). The password of an existing wallet is never checked
  again: it keeps opening the wallet.
- The recovery phrase shown again from Settings goes the moment the app leaves the front (the screen going off
  included); one whose vault opens only after the app left the front, or after the wallet locked, is never put on
  screen (`exportSeedPhrase`).
- The recovery phrase, at creation and when shown again from Settings, has a Copy button (an explicit tap only). At
  creation a warning next to it says that anyone who can read the clipboard can take the wallet; shown again from
  Settings, one warning stands before the password ("Anyone with these words controls your wallet. Never enter them on
  a website and never share them.", as the browser extension says it), and after the check the phrase is on screen at
  once with only Copy and Done: no second warning and no clipboard text (owner, 06.10 and 07.10).
  The phrase leaves the clipboard after 60 seconds if it is still there, and at once on Delete wallet
  (`DeviceSecurity.copySecret`, `clearSecretCopy`). iOS
  writes it for this device only (no Universal Clipboard) with that expiry on the pasteboard item, so it goes while
  the app is suspended too. Android marks the clip sensitive (the clipboard preview hides it) and clears it from a
  native timer that also runs in the background, where the app may write the clipboard but not read it, so a clipboard
  it cannot read then is cleared all the same.
- Settings → **Export Private Key** asks first which account's key (the QNet wallet key or the Solana key, as the
  browser extension asks), with the form that key is written in under the choice, then one warning and the check of the
  recovery phrase: a fresh password check (under the screen lock a fresh device authentication) under the same lockout,
  never on a rooted, jailbroken or instrumented device, the apps that can read the screen named first
  (`WalletManager.revealPrivateKeys(credential, account)`, `WalletScreen` `revealSecret`). Only the chosen account's key
  is derived. The QNet wallet key is shown as its 32-byte ML-DSA-65 key-generation seed in hex, the compact form the
  wallet derives it from (table above), the Solana key as its 64-byte secret key in base58. Each is handed over only
  after the key it makes is checked to give the wallet's address (the QNet one by a FIPS 204 key generation from the
  seed); a wallet without its recovery phrase on the device shows the QNet key as not available. After the check the
  key is on screen at once (owner, 06.10) under its name with the form it is written in and a Copy button under the
  phrase's clipboard rule (an explicit tap, cleared after 60 seconds, at once on Delete wallet), then Done: no second
  warning, no press-and-hold, no address beside it, no clipboard text. The screen is a secret screen (no capture,
  overlays kept out) and goes on Done, on lock and the moment the app leaves the front. Nothing of either key is
  stored, logged or sent. The app imports no wallet by a private key: a wallet is restored from its recovery phrase.
- Android biometric unlock keeps a second wrap of the data key under a Keystore key that needs a strong
  biometric for every use and is invalidated when a fingerprint or face is enrolled; the password is
  never stored. The same system prompt, bound to that key, is the fresh check of a send, a site's request,
  a QNet Link request and a security setting; for those it needs a deliberate press after a face match
  (confirmation required), and a send's prompt shows the whole recipient. Unlock needs no press.
- A password an older build kept under the Android keychain service `com.qnet.wallet.biometric` (behind a
  fingerprint key that a new enrolment did not invalidate) is deleted at launch with its key, never read.
  When the vault has no biometric wrap of its own, biometric unlock is off from then on and a notice asks
  the user to turn it on again.
- Unlock is the same on every phone and tablet: the device's own authentication (Face ID, Touch ID, a fingerprint,
  a face or the device passcode) when the device has a screen lock the app can bind a secret to, otherwise an app
  password. With the screen lock the vault secret is 256 random bits generated at create/import and kept by
  `src/services/DeviceAuthStore.js`: on iOS in the keychain item `com.qnetmobile.vault-secret`, in the app's own
  keychain access group, with `BIOMETRY_ANY_OR_DEVICE_PASSCODE` and `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; on Android 11
  and later as a blob in app storage sealed by a Keystore key whose use needs a strong biometric or the device
  credential every time. The Android blob is hybrid: a random AES-256-GCM key seals the secret and only that key goes
  through RSA-OAEP, so a secret of any length fits; its header names the RSA key, so a key made after the screen lock
  was removed and set again is told apart without a prompt. `qnet_device_auth` records that the wallet opens this way.
  A new wallet's secret is read back through the screen lock once before the vault is written. A device whose prompt
  cannot give it back (the secret comes back different or not at all, or on Android the prompt passed and the key still
  failed) counts as one without a screen lock for seven days (`qnet_device_auth_broken`, the time it was set), and the
  wallet gets a password; any read-back through the screen lock that works clears the mark. A prompt that fails only
  this time (a timeout, the sensor unavailable, a busy Keystore, any Android failure before the prompt, which the native
  module answers as `PRE_PROMPT`, any iOS error with the item still there) changes nothing, and the next attempt uses
  the screen lock again (`WalletManager._readBackVerdict`). So does a write or a check the device refused for now (a
  busy Keystore): only a device with no usable screen lock sends a new wallet to a password. The lock screen opens its
  prompt by itself only while the app is in front: iOS starts the app in the background for a silent push or a
  background fetch, and refuses a Keychain read there (`errSecInteractionNotAllowed`); the prompt is then owed and
  opens once when the app comes to the front, with no error on screen. On
  Android the screen-lock key is checked before anything is sealed to it: one the removed screen lock invalidated is
  made again (what it sealed is lost already), so no secret is sealed to a key no prompt can open; one the Keystore
  failed to read is neither deleted nor replaced. The secret is
  replaced at the first unlock a day after the last replacement: a staging item (`com.qnetmobile.vault-secret.next`)
  holds both secrets while the vault is rewrapped, so every step leaves an item that opens what is stored. A password
  wallet moves to the screen lock at its next unlock on a device that has one, by password
  (`WalletManager.switchToDeviceAuth`) or by its Android biometric wrap (`switchToDeviceAuthWithBiometric`: the fresh
  biometric gives the data key, so no password is typed); one system prompt reads the new secret back, and a refused
  prompt keeps the password and the next unlock asks again. It can also move from Settings. The typed password is
  staged only with the move's mark: a move that stopped midway ends at the next unlock with a fresh generated secret,
  and every unlock of a password wallet, by password or biometric, removes a staging item a stopped move left, so the
  password never stays behind the screen lock. A flag that cannot be read at launch (after a few retries) is never
  taken for a password wallet: the recovery screen offers Try again instead of a password field whose attempts the
  lockout would count. Seed export, security settings and delete re-run the same check. The vault is the same
  version-4 format, and every signing path is the same — only the source of the password differs.
- The lock screen is plain, the same at launch, after Lock Wallet and after an auto-lock: the app's mark and name, and
  the unlock itself. Under the screen lock the system prompt opens by itself and nothing stands under it; once the
  prompt ended without opening the wallet (cancelled, failed), an **Unlock your wallet** button asks again. A password
  wallet shows its password field, the same button and, where set up, biometric unlock. At the foot of the screen a
  small link **Forgot? Reset the wallet** opens the erase confirmation (typed ERASE, and under the screen lock a fresh
  device check), after which the wallet is restored from its recovery phrase; it is never shown while the system
  prompt is up. No erase choice stands next to Unlock. Before the stored wallet was read the screen shows only the
  app's name, never the welcome screen of a device without a wallet. An unlock prompt owed at a cold start (the app's
  state still read as in the background for a moment) is looked at again 750 ms later
  (`src/screens/WalletScreen.js` `autoUnlockRef`). No field on this screen or any other takes the focus by itself: the
  password field is focused only when it is tapped, and so is every other field (the browser's address bar after a tap
  on the address). Locking and unlocking let go of the field that has the focus first (`Keyboard.dismiss`), so Android
  never hands the focus, and the keyboard, to the next screen's field.
- Removing the screen lock deletes the secret for good, on both platforms, even when a screen lock is set again.
  The lock screen then says so (only the recovery phrase opens the wallet: "Forgot? Reset the wallet") instead of
  doing nothing. While the wallet is still open, a fresh check or the return to the app finds the secret gone
  (`WalletManager.deviceAuthSecretState`, asking nothing) and offers the one way back the open session still has: a new
  wallet password (`reprotectWithPassword`, crash-safe through `qnet_device_auth_to_password`) or, with a screen lock
  on again, the screen lock (`reprotectWithDeviceAuth`). Declined, the wallet locks, and the text says which case it
  is: no screen lock now, or a screen lock set again that brings nothing back. On Android a fresh check without the
  screen-lock key answers "not set": no plain system prompt stands in for it. A biometric or screen-lock unlock that
  opens nothing always says why (the attempt could not be recorded, or it failed); only a cancelled prompt is silent.
- A **separate**, randomly seeded ML-DSA-65 keypair is generated when this wallet's node is linked to the device,
  for signing its answers. Its secret key is stored in the keychain under service `qnet_ping_sk_{node_id}`
  with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, so a background push handler can answer without the wallet
  password. It is bound to the wallet by the delegation the wallet key signs over
  `q1337|delegate_ping:v2:{ping_pubkey}:{node_id}:{seq}` ([light node messages](../protocols/light-node-messages.md)
  section 4).
- The wallet public key that a ping presents as the node's identity key is kept in app storage as
  `qnet_identity_pk_{node_id}`: written at registration, and written from the wallet whenever it is
  decrypted or stored and the entry is missing, so a reinstall restores it with the seed.
- Deleting the wallet (Settings → Delete Wallet, after its confirmation and a fresh password or device check) stops
  its node for good before anything else: the ping key signs the unbind (with the device record's release where the
  node holds this device's key), and at once, before the network answers, the keychain ping secret, the cached
  certificate, the device key, the push token, the scheduled and periodic wakes and the node records go, so the deleted
  wallet's node can send no answer from this device again whatever the network does. Then the wallet's own data goes,
  and only then is the network's answer awaited, for at most 8 seconds from the signature; Firebase is waited for at
  most 4 seconds to forget the token. One plain screen says "Deleting the wallet…" throughout, and "The wallet was
  deleted from this device." ends it; a device check that failed (not one the user cancelled) says the wallet could
  not be deleted (`WalletScreen.eraseWallet`, `PushService.stopLightNode` with `forgetDevice`). Erase from the lock
  screen or the recovery screen does the same.
- Deleting the wallet, erasing it, and another wallet taking its place also wipe what the in-app browser left on the
  device, at once and the same on Android and iOS: every cookie, every site's storage and the web caches
  (`DeviceSecurity.clearBrowserData`, the native `clearWebData`: on Android the cookie store, the site storage, the web
  view HTTP cache and saved form data; on iOS every kind of data in the default web data store, each browser tab's own
  data being in memory only). It is best effort and never waited for, so a web view never holds up the erase
  (`WalletManager.eraseAllData`, `wipeWalletScope`). The screen's own choices of the previous wallet go with it too: the
  tokens it chose to show start empty for the next wallet, in memory as on disk (`resetWalletScopedState`).

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
6. **Account balance.** The wallet asks for the certified form,
   `GET /api/v1/account/{address}/balance/proof?mb=latest` (or `?mb=<j>`, below): the node names the committee-certified
   macroblock `j` whose state root its proof folds to (`proof_format: 2`, `macroblock_index`, `state_height` = 90j).
   The answer is read by one strict parse capped at 64 KB, bound to the address asked for, and its leaf is rebuilt from
   every field the node hashes (`hash_account`, `QNET_ACCOUNT_V2`: balance, nonce, address, `is_contract`, `CODE:` and
   the code hash when there is one, `SROOT:` and the storage root of a contract, `HB:` and the four heartbeat fields,
   `LCE:`, `BAN:`, `NODE:`), nothing defaulted (`SmtFold.accountLeafHash`). The proof kind is checked exactly:
   `inclusion` (the in-bucket path, then 40 tree steps whose flags equal the key bits), `absence` (the empty-bucket seed
   and exactly 40 steps) or `absence_in_bucket` (1 to 64 entries of the key's bucket, strictly ascending, none the key
   and no zero leaf, folded to the bucket hash, then 40 steps); an absence names nothing but zeros
   (`SmtFold.readCertifiedAccount`). The light client verifies macroblock `j` itself, walking up to `j` only, never to
   the tip (`QcLightClient.certifiedStateRootAt`), and the proof is folded to the state root of that verified checkpoint,
   never to the root the node served. A node from before the certified form ignores the query and answers with its live
   root: that answer still counts when its fold reaches a root that is the certified root of the macroblock covering its
   height or one of the two before it (`certifiedStateRootIndex`), its leaf rebuilt from the fields it carries (a wallet
   is no contract).
7. **QRC-20 balance.** A two-level proof, asked for in the certified form too
   (`/api/v1/token/{contract}/{holder}/balance/proof?mb=`): the contract account under the certified state root
   (`contract_status` `absent`, `not_contract` or `contract`, each with its level-1 proof: a status without it is no
   answer), and for a contract the holder's `balance:{holder}` entry under the storage root that proven account commits
   to (inclusion, or an absence proving a balance of 0), bound to the requested (contract, holder) pair
   (`SmtFold.readCertifiedToken`). The older answer folds the storage proof to its storage root, with a zero balance as
   the 32-zero-byte empty leaf, and the contract leaf with `SROOT:` plus the raw 32-byte storage root to the node's live
   root, judged as for an account.
8. **Token transfers.** Each row's leaf is recomputed from the row's own fields (tx hash, log index,
   contract, sorted-key event JSON), folded to a block sub-root (`log-leaf` / `log-node`), then to
   the window `logs_root` (`logw-leaf` / `logw-node`), and that `logs_root` is anchored to a
   committee QC.

The SMT fold lives in its own module (`src/crypto/SmtFold.js`) so the cross-language jest pins
exercise the shipped code. It mirrors the node's bucketed tree, which groups leaves sharing their
leading 40 key bits into buckets and hashes only the 40 levels above them (`BUCKET_DEPTH` = 216,
`PROOF_DEPTH` = 40). The fold seeds from `SHA3-256(0xB5 || key || leaf)` and accepts 40 to 104
entries: the first `len - 40` are in-bucket steps with positional flags, and in the last 40 depth `d`
splits on key bit `255-d`, so an entry whose `is_right` disagrees with that bit is rejected. Each pair
is hashed `SHA3-256(sibling || current)` ordered by `is_right`. An all-zero leaf is a proof of
absence: exactly 40 steps, seeded from the empty-bucket hash.

### What a verified result covers

A verified result is a statement about *inclusion and certification*, not about recency. The device
establishes that the served value is committed by a macroblock whose checkpoint it recomputed, whose
quorum certificate it opened signature by signature, and whose committee it derived and key-bound back
to the pinned genesis identities — the answering node contributes bytes, never trust. The macroblock a
certified proof folds to is the one the answering node names, and the device verifies that macroblock
rather than requiring it to be the chain tip; it counts only within two macroblocks of the certified head
(above). Recency beyond that comes from the polling cadence and the WebSocket push, which is why the app
re-reads on wallet-screen focus, and a send counts this wallet's own transactions since the certified
state and takes its nonce from a fresh confirmed read before signing.

### Trust anchor

The five genesis `node_id -> ML-DSA-65 consensus public key` bindings are compiled into the binary
(`src/config/genesisConsensus.js`), mirroring the node's `GENESIS_CONSENSUS_PKS`. Rotating them ships
as a new release. For macroblock index `< GENESIS_ERA_MAX_INDEX` the committee *is* those five ids
with those pinned keys. `GENESIS_ERA_MAX_INDEX` is 3: it marks the indices whose committee comes
from the embedded genesis keys rather than from a served registry. Without a pin the verification walk
is genesis-rooted and `trustFloorIndex()` returns 1; the shipped build carries a pin.

`WS_CHECKPOINT` is the walk root and ships in the same binary, mirroring the node's weak-subjectivity
pin. `scripts/ws-pin.js` generates it from the live chain for each release (QC-verified step by step from the
previous pin, which it records as `provenFrom` with the date it ran, above `WS_CHECKPOINT`; the release gate
`npm run check:release` refuses a pin without that link, an old one, and with `--online` one below the nodes'
signature retention, and runs in CI before every iOS build with the dependency audit and the unit tests): a
macroblock index `K`, that macroblock's `MacroBlock::hash()`, and the committee-derivation
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
`/api/v1/macroblock/{index}/proof` answers `qc_sigs_pruned` with `action: "repin_recent_anchor"`, unless the node
keeps a history archive holding the signed macroblock. A pin
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

The values below are supplied by the node the app is connected to and are displayed as received. The screens show
no proof badge; only the checks above make a value count as proven where the app decides on it.

- **The node discovery list** (`src/services/NodePool.js`). The app asks three genesis nodes for
  `/api/v1/validators/proof` and adds an endpoint to its pool only when at least two of them list it as
  active, synced and seen within the last 10 minutes, at an `https://` DNS name on the default port.
  Server reputation is ignored, `last_seen` is clamped to the device clock, the five genesis names always
  stay in the pool, and an endpoint that no later round confirms drops out after 6 hours. A listed
  third-party endpoint serves only the macroblock proofs of the light client's lineage walk, which name no address and
  which the device verifies step by step (a proof it cannot even read is that endpoint's failure, and the next node
  is asked). Balance and token proofs, which name the wallet's address, and the registry snapshots a step binds the
  committee's keys to, whose size decides how long the phone hashes (bounded in entries, hashed in chunks that let
  the app keep answering), come from the genesis names, like writes, history, status, registration, token refresh,
  ping answers and everything carrying a device identifier.
- **Transaction history.** The whole history comes from the explorer archive
  (`https://aiqnet.io/api/address/{addr}/history`, 50 rows a page, older pages loaded when the list is scrolled to its
  end; opening the tab, pull-to-refresh and a return to the app ask for the first page, the explorer is asked then only,
  and background refreshes ask one genesis node: [Requests from the open app](#requests-from-the-open-app)); the node's
  `/api/v1/account/{addr}/transactions` and token-transfer feed add the newest rows and stand in when the explorer is
  down, and `/api/v1/account/{addr}/node-events` adds node lifecycle rows. Rows are rendered as served and only those
  the wallet is a party to are kept. A refresh merges into the list instead of replacing it: a confirmed row missing
  from the explorer's first page is dropped only when it is inside the span that page covers and older than five
  minutes. QRC-20/721 transfer rows a node can still prove (the last 24 hours) carry logs-root inclusion proofs, checked
  after the balance read in flight and two at a time, so a check that walks to an old macroblock never holds the balance
  up; older archived transfers are confirmed without one. Up to 500 confirmed rows are cached per wallet address and shown while a
  session's first fetch is in flight. A node's row of a transaction the archive holds under another key (a batch
  payment's credit `hash:bN`) goes as soon as the archive's row is there, so no payment shows twice. The tab is titled
  "History" and is split by network exactly as Assets is, with the same QNet · Solana selector (one choice shared with
  Assets): QNet lists the wallet's QNet transactions of every asset and its node lifecycle rows, Solana the sends made
  on this device (said once above that list); there are no filter chips. It says "No transactions yet" when empty
  (`src/screens/HistoryTab.js`). The list shows one row per transaction (`src/utils/txHistory.js` `historyEntries`): a
  node registration the registry's node event and a transaction feed both report (the explorer's `NodeRegistration` row,
  or a node's for about a day, matched by the node it names or the block it is in) is one "Node registered" row, never a
  "Sent 0 QNC" beside it, and the value rows of one transaction (its token transfers, a batch's credits) are one row
  with their legs; the rows each feed served stay as they are in the cache. Rows come newest first under a header for
  their day (`historySections`): Today, Yesterday, then the date as the app's language writes it (the year only when it
  is not this year's), and Earlier last for rows without a real time. Each row holds at 320 dp: on its start the asset's
  icon (the app's bundled mark for QNC, enlarged to fill its round, the same SOL and 1DEV icons as Assets, a token's
  letter or emoji) with a small badge at its lower end corner drawn as the app's other vector icons, a disc in the
  amount's colour with a dark glyph: sent (an arrow up and out, white), received (an arrow down, green), sent to itself
  (a loop, blue), swap (two arrows, blue), a node action (registration, back online, check-in, the node balance moved
  into the wallet: a hexagon, blue), a contract call or deploy (code brackets, grey), burn (a flame, amber) and nothing
  moved (a cross on red: failed or not found), the same glyphs and colours as the browser extension's History. Then what
  happened in plain words (Sent, Received, Sent to self, Burned, Swap, Node registered, Node back online, Node check-in,
  Moved from node, Contract call, Contract deployed: the transaction's type decides, `txKind`, either source naming it;
  an activation transaction of older blocks reads Node registered) over whom it was with: "To: abcd…wxyz" or "From:
  abcd…wxyz", the node ("Node light_…"), the contract ("Contract 1a2b3c…9f0e"), "From: node balance" for a move from the
  node, "Genesis" or "Network" for a sender that is the network itself (never its id), a swap's pair, nothing for a transfer to the wallet itself (as in the extension), or its block when none is
  known; a row not final says its status after it, Pending, Failed or Not found (`historyBadge`; a confirmed row says no
  status), as the extension does: whom with keeps one line, and the status goes under it when both do not fit. On its
  end the amount with its sign and symbol, incoming green with +, outgoing white with − (the minus sign, as the
  extension writes it), a transfer to the wallet itself blue, and grey for one that failed or was not found (nothing
  moved); a swap has two lines, the received leg first, and a row that moves nothing (a node registration, a contract
  call without value) has none. A row's screen-reader label says, in the extension's order, what happened, the amounts
  (not while amounts are hidden), whom with, its status and the time. A transaction sent from this wallet that no source
  reports 65 minutes after it was sent (the wallet sends it again by itself for 30 minutes, a node keeps each copy 30
  minutes, and a 5-minute margin: `PENDING_ROW_MAX_MS`, as long as `services/PendingTx` `mayLandUntil` allows it to
  land) is Not found instead of staying Pending for ever, and a source's row with its hash still replaces it; neither
  Pending nor Not found rows are kept on the device. Before a row is marked Not found the chain is asked by the send's
  nonce: one that landed, under its own hash or as a copy under another, becomes a node's reported row under the hash
  that landed (the archive's row replaces it once listed); one whose nonce another transaction took goes; one no node
  answered for stays Pending until a later refresh can ask (`rowsDueToDrop`, `mergeHistory` `settled`), and so does one
  whose sent history no node gave (`resolveSubmitByNonce` learns nothing from a read that failed). A confirmed, failed
  or reported row with the same hash always replaces a Pending or Not found row, an older page's included, and the result
  card's own check by nonce removes either. The amount is written compactly, by the extension's rule too
  (grouped below 100,000 with at most two decimals from 1,000, four from 1 and eight below 1; K, M, B, T from 100,000
  with at most two) and never shrinks or ends in an ellipsis; only a token's symbol, a name, may. The amounts take at
  most 45% of the row, so what happened and whom with keep the rest, and a single amount whose number and symbol run
  past 13 characters (a long symbol, a dust amount) puts the symbol under the number, as the extension does. A token the
  wallet did not add carries its contract id, and one named after QNet a ⚠ (in any spelling a reader takes for it:
  look-alike letters of other scripts, small capitals, letterlike symbols and letters in a filled circle or square are
  read as Latin letters before NFKD and again after it, so the lunate sigma, which NFKD changes, still reads as C, and
  an accent is dropped, so QNĊ reads as QNC); so
  does one whose symbol or name holds a
  hidden or format character (a direction override, U+202E, can make a symbol read as QNC), and every token symbol and name, on
  History as on Assets, Send and Manage tokens, is written with such characters replaced by � (`tokenSafety.tokenLabel`,
  `usesReservedName`). Tapping a row opens its detail screen over
  the tab, with Back, under the same icon and badge: what happened, the exact amounts, the status, the node's type and
  name for a node row, the fee, both addresses (each copies; a sender that is the network itself is named in words and
  neither copied nor drawn as an id: "Node balance" for a move of the node balance, "Genesis", and "Network" for
  "system" and any other system account, `systemSenderKey`), the time, the transaction hash (copies), the block when a
  source named it, a memo when there is one, and one button: "View in the explorer" for a transaction the network ran (a
  QNet one in a block opens the QNet explorer, a Solana send the cluster's public explorer, `config/nodes.js`
  `solanaExplorerTxUrl`), otherwise (one still pending or not found, a Solana send that expired unrun) "Copy the
  transaction hash"; a node event the registry alone reports has no transaction hash, so neither.
- **WebSocket events.** A `BalanceUpdate` naming this wallet, or a block event carrying one of its
  transactions, only triggers a fresh balance read and a history reload; the pushed value itself is
  never displayed. The Assets tab keeps the last known QNC balance when a read fails and does not lower
  it from an unverified read (`src/utils/balanceMerge.js`).
- **The first figures.** The last balances a proof certified (QNC, with SOL and 1DEV of the same read and the token rows
  a proof certified) are kept per wallet, sealed under the vault's data key and tagged with the chain
  (`WalletManager.saveBalanceSnapshot`, `qnet_balance_cache`; resealed by a password change, gone with the wallet), and
  show the moment the wallet opens; while a read runs nothing is said under them, and a figure this session read is
  never replaced by a kept one. A figure neither read nor kept is a dash, never 0. Only a first read of the session that
  found nothing leaves a line under Send and Receive: "Not updated. Last read {time}." under the kept figures, or "Not
  updated. Pull down to try again." without any. One read runs at a time per wallet (the unlock and the Assets tab share
  it), and each figure lands as soon as its own source answers: SOL and 1DEV from Solana, QNC as soon as its answer is
  read and its Merkle proof folded (not verified yet: it cannot lower the figure shown), then again once the lineage
  walk decided. Nothing kept or early is ever marked or used as verified: sends read their own balance and nonce. A
  refresh that changes nothing renders nothing new: a merge that changes no figure keeps the object on screen
  (`src/utils/balanceMerge.js`), as do the token list, the kept transactions and the time of the QNC read.
- **The transport.** Every connection is HTTPS; see *Platforms and build* below.

Proof results use a four-way vocabulary that keeps "cannot prove now" distinct from "proven forgery":
`verified`, `consistent` (real but below the trust floor or the macroblock is unreachable),
`rejected` (the leaf or fold does not match, or the QC-certified root differs from the node-claimed
one), and `pending` (transient fetch or finality miss). Only `verified` counts as proven. Verified
macroblocks and a 60-second negative cache are held in memory for the life of the app process; the highest verified
macroblock of each parity chain is also kept across sessions, sealed under the vault's data key and tagged with the
chain (a fingerprint of the pinned genesis identities, `QcLightClient.chainIdentity`): a record of another chain is
dropped, never imported, and a walk waits up to 3 seconds for the record to be read, so it resumes there instead of at
the pin. When the first step above such a kept anchor is refused by two or more nodes for what ties it to the anchor
(the committee's signatures, its keys, its registry), the kept anchors are not this chain's lineage: they go, here and
in storage, and the same walk roots at the pin (`LINEAGE_REFUSALS`); nodes that do not answer drop nothing, and the pin
and macroblocks verified in this session never go. The chain head a proof's freshness is judged by is read while the
walk runs. Within a session at most 64 verified
macroblocks are kept, the least recently used going first and never the highest one of either parity chain, so a
catch-up walk from an old pin stays small (a later query below them walks again from the nearest anchor kept). A
registry snapshot is taken from the first of the named nodes whose snapshot folds to the certified root; one node's
wrong snapshot gives way to the next node's (`src/crypto/QcLightClient.js`).

A certified proof is as recent as the macroblock it names: it counts only when that index is at least the trust floor
and within two macroblocks of the certified head, the higher of the newest macroblock this device verified and the
second highest `newest_certified_index` that at least three genesis nodes report on `GET /api/v1/state/certified`
(cached for a minute; a node from before that route reports the sealed-macroblock watermark of
`/api/v1/debug/consensus-position`). The head is never read from the applied tip a node reports; with no head to be
read, no proof counts, and an index more than two past the head is not walked to (`QcLightClient.certifiedHead`,
`WalletManager._certifiedRootFresh`, `_indexIsFresh`). While the newest macroblock this device verified is within that
window the proofs ask for it (`?mb=<j>`, no new committee check until it leaves the window), else for the newest the
node holds; for ten minutes after this wallet's own send they ask for the newest (`_proofIndex`). Every answer without
a verifiable proof is no answer: an error, a rate limit, a timeout, an older body whose root is not certified, an
answer of another index. The next genesis name is asked, one after another, at most three; a node that answers 429 or
503 with a wait (Retry-After) is asked after the others until then; a node whose answer has the older proof's shape
(HTTP 200, no `proof_format`, a boolean `proof_valid`, a numeric `block_height` and its proof arrays: never a rate limit
or an error) is marked for ten minutes and asked after the others (`SmtFold.isLegacyProofBody`, `markNodeOld`). A
figure is never shown for a 0 that no proof verified.

A macroblock is certified some blocks after its height; until then a node answers it with HTTP 200
`{"error": "macroblock_not_found"}`. For the macroblock a walk is for, that answer is no failure of the node: the step
passes to the next node, two more at most, so one lagging or hostile node cannot hold back a macroblock the others
serve, and only then ends as not certified yet; none of them is charged or skipped for the failure TTL
(`NOT_FOUND_MORE_NODES`). Checkpoints already verified answer at once, with no fetch. A walk fetches the step it
verifies and up to four after it at once, each from the node that step asks first (a read-pool node drawn per step, so
they spread over the pool), never past the 64 steps of one call and never past 16 MB of proofs in flight: each proof
fetched ahead reserves twice the size expected for the committee of the walk's anchor (about 7.5 KB a member) or the
largest proof the walk received, so a 1000-member committee keeps two proofs in flight where a small one keeps five,
and one larger than its share is fetched again by its own step with the full bound (`WALK_INFLIGHT_BYTES`,
`prefetchShareBytes`). The steps are verified strictly in order, each from the anchor the step below it verified; a
proof that fails stops the walk at its step. The light client reads each node at most 180 times a minute (a node admits
300 read-only calls a minute from one address); a node that answers with its rate limit (HTTP 200 `{"error": "Rate
limit exceeded", "retry_after_seconds": n}`, or a proxy's 429) is left alone for the time it asks, one second to one
minute, and is never charged for it. The SHA3 of each committee key is kept by node id, so a walk hashes each key once.

## Requests, signing and sending

Balance, token, token-transfer, reward-claim, transaction-submit and contract calls go through a
hedged path: two nodes, a per-attempt timeout and a hedge timer, first success wins and the rest are
aborted. For a read, an answer counts only when it is 2xx, its body was read within the attempt's time (the timer runs
until the body is read, so a body that stalls times out) and it is not a node's rate-limit answer; anything else is
that node's failure, and the next node is asked at once. Only when every node failed is the last failure returned.
Balance and token proofs ask up to three genesis names. A submit settles only on an answer that took the transaction. Single plain requests against one node are used for the light client's
macroblock-proof and registry fetches, node discovery, the native transaction-history list and the explorer history
page, the Solana devnet balance reads (which rotate over the endpoints on a rate limit), and every push, ping,
self-attestation, binding and device-layer call. Requests
where the **server builds the transaction** go to exactly one node, since hedging them would produce
two distinct on-chain transactions for one logical operation.

The hedged path picks two genesis names in random order, a node that failed three times in the last
30 seconds last; only the light client's macroblock lineage steps also use the agreed endpoints of the
discovery list (one of them first, then the genesis names), which is asked again once it is 30 minutes old.
A read that needs two genesis names to agree (the QNC balance the Assets tab may lower to, a token's description,
what an address is, whether the wallet has a server node) asks three of them in random order, and the other two only
when those three gave no verdict (`WalletManager._fromGenesis`); the agreed balance read is shared for 10 seconds,
and while it runs. The certified head a proof's freshness is judged by asks all five for their certified frontier, at
most once a minute, and so does the account nonce a send plans from (one read at a time per address). An agreement
read settles as soon as the answers still out cannot change it: two of the first three alike do not wait for the
third, the nonce settles once too few answers are out to move it, and the head once three answered and the one still
out cannot move the second highest; what it settles on is what all the answers would give.

Two signature wire formats come from the same native module:

- Raw detached hex (3309 bytes) for value transactions and contract calls.
- The envelope `dilithium_sig_{node_id}_{base64}` for lifecycle, ping and claim messages, where the
  base64 payload is `[u32LE len(sig||msg)][sig||msg]` optionally followed by `[u32LE pk_len][pk]`.

Canonical signed messages. Every message the wallet key signs carries the chain tag `q{chain_id}|`
(`q1337|` on testnet), since the same wallet key signs transfers:

| Operation | Message |
| --- | --- |
| Native transfer | `q{chain_id}\|transfer:{from}:{to}:{amount}:{nonce}:{gas_price}:{gas_limit}` |
| Contract call | `q{chain_id}\|contract_call:{from}:{sha3_256_hex(dataStr)}:{nonce}:{gas_price}:{gas_limit}`, `dataStr` being JSON with keys ordered `args, contract, method` |
| Reward claim, step 1 (node ownership) | `q{chain_id}\|claim_rewards:{node_id}:{wallet}` |
| Reward claim, step 2 (batch) | `q{chain_id}\|qnet_claim_v1:{wallet}:{claim_timestamp}:{sha3_256(claims_data)}` |
| Consent to the node's registration | `q{chain_id}\|client_node_reg:{node_id}:{wallet}:{registration_proof}:{timestamp}` |
| Ping delegation | `q{chain_id}\|delegate_ping:v2:{ping_pubkey}:{node_id}:{seq}` |
| Attach (the device's push channel) | `q{chain_id}\|light_attach:{node_id}:{sha3(ping_pubkey)}:{sha3(push_target)}:{seq}:{ts}` |

The consent is signed only on the link sheet of a `link` request, for the burn the request names; the app
submits no registration: the node cabinet or the browser extension submits it with the burner's owner bind. For a
burn made from the wallet's own Solana address (a request with `burner`), the wallet's Solana key signs that owner
bind itself, the v1 form `qnet_onchain_reg:{N}:{W}:{proof}:{T}:{sha3(K)}:{burnTx}` with the consent's T
(`WalletManager.signOwnBurnBind`, built by `NodePreimages.ownerBindPreimage`), and the cabinet submits it. The
delegation and the attach go to `/api/v1/light-node/bind`. The ping key, not the wallet key, signs the node's
answers, the unbind and the push-token refresh. The exact preimages are in [light node
messages](../protocols/light-node-messages.md) section 4 (`src/crypto/NodePreimages.js`).

Besides a website's messages ([In-app browser](#in-app-browser)), the one message the wallet key signs without the chain
tag is the node reservation of the `reserve` sheet (QNet Link below; `WalletManager.signNodeReservation`): the
envelope of a site's signed message, `"QNet Signed Message:\n" +
origin + "\n" + byteLength + "\n" + message`, for the build's site origin (`EXPLORER_API`, the QNet Link relay's origin
too) over `"QNet node reservation v1\nwallet: {W}\nnode: light\nway: payment\nburner: {S}\ntime: {T}\ncluster: devnet"`,
S being the page's one-time payment address, with the FIPS 204 context `QNET_OFFCHAIN_MSG_v1`
(`signSiteRecord` in `src/crypto/OffchainMessage.js`, which signs only a message that starts with that first line or
aiqnet.io's burn record's, and is pinned byte for byte against the extension's site-record signer). No website can have
it signed through `qnet_signMessage`: the protocol prefixes a site's message may not start with include
`qnetnodereservationv1`, `qnetburnrecordv1` and the payment key's owner bind `qnet_burn_owner_v2:` (compared without
spaces and case). The app signs no burn record, and no owner bind but its own Solana key's for its own burn on the
`link` sheet (above).

Transfers default to `gas_price = 10` nanoQNC per gas and `gas_limit = 10000`; every wallet TX is ML-DSA-65
signed, so the chain charges 1.5 × the gas price and a native transfer costs 150 000 nanoQNC (0.00015 QNC).
A QRC-20 call sets `gas_limit` to its intrinsic gas (100 000 plus 5 per calldata byte, about 0.0015 QNC) and
the sender's QNC must also cover a refundable 0.01 QNC deposit when the recipient holds none of the token. Amounts and token ids
are normalised to decimal strings so full u64 values survive the signed digest, and balances are
re-extracted as exact decimal strings from the raw response text because `JSON.parse` loses precision
above 2^53. A send is reported successful only on an affirmative `tx_hash` or `success === true`; an
ambiguous empty 200 is treated as failure.

The 1952-byte public key is carried on the wire until a confirmed chain read reports
`has_dilithium_pk`, after which it is elided and the node rehydrates it from state. A `pk_unresolved`
rejection forces a fresh nonce read that re-attaches the key.

On the QNet Send form a scan icon inside the recipient field, at its end, opens the camera (`src/components/QrScanSheet.js`);
the camera permission is asked for only then, on both platforms. A refusal shows one line and Open settings instead of
the camera; back from the settings with the camera allowed, the same sheet starts scanning. Frames are decoded on the
device and none is stored or sent: on iOS by the system, on Android by an open-source QR decoder bundled in the app
(`THIRD_PARTY_NOTICES.md`). The app's patch of the camera library (`patches/react-native-camera-kit+18.0.1.patch`) puts
that decoder in place of the library's own and removes the library's face detection, so the scan makes no network
connection on either platform. A QR code fills the field only when its text is a QNet address the field itself
accepts: 45 characters with "eon" in the middle and its SHA3 checksum (`src/utils/scanAddress.js`,
`WalletManager.recipientAddress`).
The app's own Receive QR carries the bare address. Anything else (a Solana address, a web address, 64 hex, other text
or payment codes) shows "Not a QNet address" while the camera keeps scanning, and nothing read is ever opened. The
send is then reviewed and confirmed as below. The Solana Send form has its own scan icon and reading ([Solana
sends](#solana-sends)).

A send from the Send form is reviewed before anything is asked (`src/components/SendReview.js`): the whole
recipient in groups of four characters, as captured when Send was tapped (the one that is signed), the network,
amount, fee and total, and the in-app browser's recipient warnings (never paid, a look-alike of a known address,
only ever sent to this wallet). Its Confirm arms after one and a half seconds untouched. Then the fresh check runs,
the password prompt, the system biometric prompt or the screen-lock prompt, which shows the whole recipient too. The
Send button turns busy, with a spinner, from the tap until the send is over, and a second tap starts nothing. Before
the review the form reads, all at once, the QNC balance, a token send's token balance, what the recipient is and the
wallet's kept transactions. A send is decided only by a balance the committee certified
(`WalletManager.certifiedQncForSend`, `checkedTokenBalance`): a certified proof read at most 30 seconds before (used at
once while it is at least as new as the account nonce the chain confirms), else one verified read rooted at the
checkpoints already certified on the device, within 6 seconds; never one node's answer, never what genesis nodes agree
on, never the figure on screen. The certified state lags the chain by up to a few minutes, so right after the wallet's
own send the next one's nonce is above the certified nonce: the decision stays on the certified figure less the amount
and most fee (a token transfer: the tokens it moves) of each of this wallet's own transactions from the certified
nonce up to the next nonce, as kept when each was signed (settled or not; two signed at one nonce count as the larger),
and nothing received after the checkpoint is counted (`services/PendingTx` `ownSpends`, `spendableFrom`). A nonce in
that range that is none of this wallet's own transactions refuses the send with "A transaction from another device is
not confirmed yet. Try again in a minute."; a balance not certified in time (or a transaction whose cost the wallet
cannot know, such as a contract call before a token send) with "The balance is not confirmed yet. Try again in a
minute."; no answer at all with "The network did not answer, so nothing was sent. Try again." A token balance counts
only beside the holder's certified QNC proof of the same macroblock (the same root, for an older node), which gives the
holder's nonce in that state. The form then checks the amount and fee, and a token send's tokens, against what may
still be spent, the checked balance less what the wallet's unconfirmed transactions may still take, the one a
"replace" signs over excepted: the in-app browser's rule. A QNet Link request that arrives
meanwhile ends the review and any open password prompt of the wallet's own flows; a prompt never opens over it.
Signed transactions are kept until the chain settles their nonce (`src/services/PendingTx.js`); a store that cannot
be read is never taken for an empty one: nothing is signed on it (`PENDING_UNREADABLE`), and a value that does not
parse holds sends back until nothing it may have held can still land (the node's 30-minute mempool lifetime and a
margin).

The QNet Send form's 25 %, 50 %, 75 % and MAX buttons fill that share of what may be sent, floored, with as many
decimals as the asset takes: a token at most six and never more than its own decimals (a token of 2 decimals gets 2, one
of 0 a whole number), QNC five, after its fee; they work in whole base units from the token's exact balance
(`src/utils/sendAmount.js`). An amount with more decimals than the token has says "This token has at most N decimal
places." under the field and on Send. A node's refusal is said in the app's language, never in the node's own words
(`src/utils/txRefusal.js`): a nonce out of order, not enough balance, a key the network does not know yet, a busy
network or too many requests, each by its own text, inside "Not accepted yet (…)" or "Refused (…)", and as the detail
of "The transaction failed." on the result card; any other refusal or an internal error says the operation's text
alone. A 64-character hex recipient has its own text.

The wallet exposes the full token surface: QRC-20 transfer, approve, transferFrom, mint, burn;
QRC-721 mint, transfer, approve, transferFrom; plus `deployToken` and `deployNftCollection`. See
[smart contracts](../developers/smart-contracts.md).

## Solana sends

The Solana side of Assets lists SOL and 1DEV; its Send button opens the Solana Send form with SOL, and each row opens
it with its own token (`src/screens/SolanaSend.js`). The form, laid out like the QNet one, has the token (SOL or 1DEV,
switchable on the form), the recipient with a scan icon at the field's end, the amount (digits and one decimal point,
no more decimal places than the token has) with MAX, the fee of a one-signature transfer (0.000005 SOL) and the total.
MAX reads the balance now: all SOL but that fee, or all of the token in the account a transfer spends from. The 1DEV
figure on Assets and the form's Available line follow the same rule (`heldTokenBase`: the fullest initialized account
of this owner and mint), and both balances are read at `confirmed`, as the send's checks read them, so Available, MAX
and a refusal's "balance" agree and move when a send is confirmed; a read that fails keeps the figure shown. The
transfer goes from the wallet's Solana address, the Ed25519 key of the same recovery phrase, to the Solana cluster
and RPC endpoint the balances use (`src/config/nodes.js`: devnet in every build).

**Scan.** The scan opens the same camera sheet as on the QNet form, titled "Scan a Solana address"
(`src/utils/solanaRequest.js`). It takes a Solana address (base58 of exactly 32 bytes, in its canonical form), which
fills the recipient and leaves the token and the amount as they are, or the standard payment-request text
`solana:<address>` with the parameters `amount` (a plain decimal in whole units of the token), `spl-token` (the mint;
without it the request asks for SOL), `reference` (up to four addresses the payee finds its payment by) and `memo` (at
most 200 bytes of well-formed text: no lone surrogate, no control or text-direction characters), read as form encoding (`+` is a space, `%2B` a plus). A
request fills the recipient, switches the form to its token and fills its amount, which must fit that token's decimals
(a request with no amount keeps the amount typed, cut to the token's decimal places); its references and memo go into
the transfer as long as the recipient stays the one the request named. A leading decimal point typed in the amount gets
its zero (".5" is 0.5). `label`, `message` and any other parameter are ignored: nothing a code carries is shown as a
name or opened as a link. A request for a token the wallet does not hold shows "This wallet does not hold the requested
token", a malformed or repeated parameter "This payment request cannot be read", and anything else (a web address, a
request whose recipient is a link, a QNet address, other text) "Not a Solana address", while the camera keeps
scanning. The user still reviews and confirms the send.

**Checks before anything is signed** (`src/services/SolanaSend.js` `quoteSolanaSend`). Send reads, now: the SOL
balance, the rent-exempt minimum of an account, and for SOL the recipient's balance; for a token also its mint (it
must belong to the Token program with the decimals the wallet knows, 6 for 1DEV), the sender's token accounts (the
associated one when it holds the amount, else the fullest initialized one), the recipient's account and its
associated token account; then the exact fee of the very message it would sign (`getFeeForMessage`). A token goes to
the recipient's associated token account, so its recipient must be a wallet address: a point on the Ed25519 curve, and
not a token account or a program ("This address cannot receive tokens"); SOL may go to any address. When the
recipient's associated token account does not exist, the transfer creates it first and the sender pays its rent
(0.00203928 SOL on devnet), which the review shows. Refused before the review, each with its own text: an address that
is not a Solana address, too little of the token, too little SOL for the amount and the fee (and the new account's
rent), a remainder between zero and the rent-exempt minimum (an account keeps at least that or nothing; MAX leaves
nothing), a first SOL payment below that minimum to an address that holds no SOL, a mint that is not the one the
wallet knows, and an endpoint that cannot be read ("The Solana network could not be reached, so nothing was sent").

**Review, confirmation, signature.** The review (`src/components/SendReview.js`) shows the recipient in groups of four
characters, the network ("Solana devnet"), the amount with its token, the network fee, "New token account for the
recipient" with its rent when one is created, a request's memo, and the total (SOL: amount and fee; a token: the
amount, plus the fee and any rent in SOL), with the "never sent to this address" and look-alike warnings drawn from the
recipients this device paid on Solana. Then the same fresh check as every send, the recipient on its prompt. Only then
is a fresh blockhash read and the transfer built (`src/crypto/SolanaTx.js`, legacy message, one signer, the wallet
paying the fee): System program Transfer for SOL; for a token the Associated Token Account program's idempotent create
when needed, then Token program TransferChecked with the amount in base units and the mint's decimals; a memo (Memo
program) right before the transfer; references as read-only accounts of the transfer. Accounts are ordered fee payer,
signers, writable, read-only, each in the order the instructions name them, so the same transfer always gives the same
bytes. `WalletManager.signSolanaMessage` decrypts the wallet for this one signature, signs only a one-signer message
this address pays for, re-makes the key from its seed half and signs only when it gives the wallet's Solana address,
and wipes the key.

**Submit and outcome.** The signed transaction goes out with `sendTransaction` (base64, preflight at `confirmed`). A
blockhash the endpoint no longer knows is replaced, and the transfer signed again, once. A refusal of the endpoint is
reported as "The Solana network refused this transaction, so nothing was sent" with its own words. No answer at all is
not a refusal: the transaction's id is its signature, known before it is sent, so the result card says "Awaiting
Confirmation" and the send is followed like any other. The same holds for a refusal that comes only after an attempt
nobody answered (the same bytes sent again): the first attempt may have reached the network, so the transfer is never
signed a second time then, and its signature settles it. An endpoint that already holds this very transaction
("already processed") has it on its way: the send is pending. History lists the Solana sends made on this device among
the other rows by time, with a chip per Solana token (kept on the device, `qnet_solana_sends_v1:<address>`, the newest
100; Solana transfers received, or sent elsewhere, are not listed, and a line above the list says so, "SOL and 1DEV:
only sends made from this device are listed here", whenever the wallet holds SOL or 1DEV or lists a Solana send). A pending one is asked about by its signature every
3 seconds, then every 15 (`getSignatureStatuses`): confirmed or finalized is Confirmed, a transaction the network ran
and failed is Failed once that run is confirmed (a run seen only at `processed` may be on a fork that is dropped), and
one whose blockhash passed its last valid block height unrun (the full history asked once more) is Failed with "It did
not go through in time and now never can. Nothing was sent." and a row with no fee (nobody charged one; a run that
failed keeps the fee it was charged, and a row's fee is the network fee only, never a new account's rent). The result
card follows, and the balances are read again. A Solana transaction has no page in the QNet explorer, so its result card
copies the signature; its History detail opens it on the cluster's public explorer once the network ran it.

## Moving the node balance

Moving a node balance into the wallet ("Move to wallet") is a claim in two steps, each with its own wallet-key
ML-DSA-65 signature: step 1 proves node ownership over `q{chain_id}|claim_rewards:{node_id}:{wallet}`, step 2 signs
the quoted batch. The node quotes a batch; the client then:

- rejects a quote whose epochs are not strictly ascending above the reported watermark;
- cross-checks the batch's head epoch against `/api/v1/rewards/pending/{node_id}` on a **different**
  node and fails closed if that cannot be confirmed;
- **rebuilds the sign message locally** and refuses to sign the node's `sign_message` verbatim,
  aborting loudly on any mismatch. The same ML-DSA-65 key also signs transfer messages, so signing a
  server-supplied string would let any node in the hedged pool obtain a transfer signature.

The smallest move is 1,000,000,000 nanoQNC (1 QNC); only a batch the node's quote capped, with more epochs left to
move, may be smaller. See [economics](../economics/overview.md). The node balance
stays out of the wallet balance until a move lands. The
result shows the amount of the batch actually submitted and, when the quote stopped early, the epoch it stopped at,
to move again after the batch is credited. A move needs no device: a node that runs elsewhere, or nowhere, can
always be moved from, and the web's `claim` request does the same from any device that holds the wallet.

## The Node tab

The tab (`src/screens/NodeTab.js`, states picked by `nodeView`) shows this wallet's node as the network records it:
its light node, its super node, or both.
A light node's status comes from its three shard owners among the genesis nodes (`src/services/LightNode.js`
`readNodeStatus`, [light node messages](../protocols/light-node-messages.md) section 7): "no node" needs two of them
to agree, and one answer or a split shows "The QNet network could not be reached." Of the owners that say the node is
on the chain, any one's word is enough for what counts the device: an owner may have taken this device's answer while
another was down, and the one relay that tells the others may be lost. So "Answered this epoch" is yes when any of them
says so, Offline (`needs_reactivation`) only when every one of them says so, the counted epochs are the owner's with the
latest counted epoch, and the device view is online when any says so, with the latest epoch any counted it in. The
public status also carries
the bound device's view (`device`: its state `online`, `offline`, `unlinked` or `other_device_pending`, the UTC day it
was linked, the last epoch it was counted in; display only), read strictly. A device that holds a binding of the node
also reads the signed status from every owner (its binding sequence, device state, refresh window, rotation epoch,
pause, from the first owner that takes the signature): signed with the ping key; with no ping key here, or one two
owners refuse, with the open wallet's key instead (a background wake never signs with the wallet key). The binding
sequence two signed answers name alike (B, `bindingSeqAgreed`, whichever key signed) and whether two owners say a
device is bound (D) decide where the node runs (`NodeTab.bindingVerdict`, contract 4 of 04.10):

| This device's binding L | B and D | The tab |
|---|---|---|
| none | D true / D false / no verdict | another device / no device / checking |
| L | B = L's sequence (D true or no verdict) | this device: Online or Offline; when the network linked it less than an epoch ago and nothing counted it yet (`other_device_pending`), "Linked to this device. Waiting for its first answer." |
| L | B above L's, D true | another device; this device stops once its binding is 10 minutes old |
| L | B at or above L's, D false | no device (unlinked here, or by the wallet key from anywhere); this device stops the same way |
| L | B below L's | for 10 minutes after the binding, this device with the waiting line (the owner that took it passes it on); then as above |
| L | no B (no signed answer, a refused key, no network) | the last verdict read for this binding, else this device; never another device or no device |

A refused ping key, or no ping key to sign with, never says the node runs elsewhere on its own. Only the signed status
carries `device_tag_h`, bound to a nonce the app picks per read (the public one never names the device), which a
device whose key the node took compares with its own, over the tags of every owner that took the signature: one owner
naming this device's key is enough, and it counts as another key only when two owners name one and none names this
device's (an owner a rotation's statement has not reached yet still names the key before). A tag of another key only
says that the device's key for the node is missing, with **Use this device**.

| State | What the tab shows |
|---|---|
| no node | "This wallet has no node." Nothing to tap, no link. |
| linking | "The node will run on this device once the QNet network records it." (a pending-link record of the link sheet) |
| not recorded | "The network did not record the node. Nothing changed on this device." (the record's 24 hours passed and two owners say the node is not on the chain; the binding the sheet kept, with its ping key, push token and wakes, goes with the record, as it does when two owners refuse its ping key) |
| this device | Online or Offline (Online only from the network's `needs_reactivation`), "Answered this epoch", "Counted epochs: n of the last m" (a genesis counts over the epochs it indexed, the last 64 at most), the epoch clock, "Background: Unrestricted" or "Restricted" with, while restricted, one button to the system settings ([Background priority](#background-priority-on-android-and-ios)), the node balance and **Move to wallet** (it takes a balance of 1 QNC or more, with no note under it); no button ends the node here (below); with the device state: from the next epoch, a device check that waits (below), paused until a date; a device check not finished once the chain's epoch is past the key rotation's due epoch plus the node's 30-day grace (180 epochs: until then the node still counts the unrotated key, and a check not finished waits for something a new key does not end) says the key was not renewed in time and offers **Use this device**; a pause with no end (the device's certificate chain was revoked) says the device can't run the node right now and offers **Use this device**, the one way back; a binding that holds no device key once two genesis nodes take them (made before they did, or its key is gone after a reinstall, a restore or an offload) says so as advice (until the network requires the device signature its replies still count, so it never says the node is not counted) and offers **Use this device**, unless the device cannot run a node at all, which says only that |
| another device | "The node runs on another device." and **Use this device**, then the node balance and **Move to wallet** |
| no device | "The node does not run on any device now." and **Use this device**, then the node balance and **Move to wallet** |
| checking, network not reached | "Checking node status…" or "The QNet network could not be reached.", then the node balance and **Move to wallet** |
| server node | a super or genesis node of this wallet, which runs on its server: Online or Offline, the node's status, "Last seen: {time} ago" (from the node's `last_seen_ago_seconds`, only when the answering node saw it), "Heartbeats this epoch: n of m needed", "Counted epochs: n of the last m" and "Missed epochs: k" (below), the epoch clock, a permanent ban when there is one, the node balance and **Move to wallet**; no code, price or link |
| not on the network yet | "This wallet's light node is not on the QNet network yet." or, for a super node, "This wallet's super node has not joined the QNet network yet. It runs on a server with the QNet node software." (aiqnet.io records the node, below, and the network does not list a node of that type); nothing to tap |

**Why an epoch was missed.** The device view also carries `last_miss` and `last_answer` (light node messages section
7), read strictly: a missing field (an older node), an unknown reason or a field of another type gives nothing, and no
reason is ever shown raw. Of the owners that say the node is on the chain, the record with the highest epoch is taken,
at equal epochs the most specific (`not_committed`, `answered_late`, `not_delivered`, `answer_refused`,
`woken_no_answer`, `no_push_address`, `not_sent`, `not_woken_inactive`), at an equal reason the one with
`delivered_at`, else with `app_outcome` (the
owner that took this device's account of the wake); of `last_answer`, the latest. While that epoch is newer than the last one the node was counted in
(and than the epoch the device view last counted it in), the card shows one line under the status rows
(`NodeTab.missText`): what happened, at the local time the owner noted ("The network sent this device a wake at 14:05
and got no answer before the epoch closed.": the push service took the push, which is all the network can know, "This device answered at 16:30, after the epoch had closed.", a refused answer,
two epochs with no answer after which the network stopped waking it, no address to wake it); how long the wake took to
reach this device where an answer told the owner ("The wake reached this device 134 min after it was sent.", or within
a minute: the push's own time on its way, apart from the app's handling of it, so a late answer is shown to be the
delivery's or not); and what to do: allow QNet Wallet to run in the background and do not swipe it away (woken with no
answer, answered late), opening it on this device is enough (no longer woken), opening it once gives the network its
address again (no address), **Use this device** (a refused answer, which also shows the button). Two reasons are the
network's own misses, which never count toward the rule that stops waking a node, and the line says so and that
nothing is needed on the device: `not_sent` ("The network did not send this device a wake in that epoch.": the owner's
push did not go out) and `not_committed` ("The network did not finish counting that epoch for this node.": no row of
the node's shard was committed, so nothing the device did could count; it ranks first, as it explains the miss whole),
each followed by "This was the network's miss, not this device's: nothing is needed here." A wake with no answer
that this device's later answer accounted for (`delivered_at` and `app_outcome` of the record, from the pushes this
device reported, [Liveness](#liveness-pings-and-self-attestation)) says instead when it reached this device, how long
after it was sent, and why the app did not answer, with what to do: "The wake reached this device at 14:05, 3 min after
it was sent, and the app did not answer: QNet Wallet had not been opened since the device restarted. Open it once after
every restart." Likewise: it had been swiped away (open it and leave it running in the background), it came after the
epoch had closed (allow it to run in the background so wakes are not held back), its answer did not get through to the
network (check that the device is online), it had already answered in that epoch (nothing to do), or the node's key is
no longer on this device (**Use this device**, which the card then shows). An outcome `answered` reads "This device
answered the wake, but the network did not count the answer in that epoch. Nothing needs doing on this device.", and an
outcome this build does not know is not read. A wake the device's record shows never reached it
(`not_delivered`) reads "The wake never reached this device: the push service or the device held it." with the advice to
let it run in the background. Such a record of this device's own account (a wake with no answer that carries
`delivered_at` or `app_outcome`, or `not_delivered`) reaches the network only with a later answer, which counts the node
again: the card keeps it after that too, as the site's Device tab does, led by "Epoch {n} was not counted." and with the
day of a time not today, until a newer miss replaces it (`LightNode.shownMiss`); it offers no button then. A miss put down to no
push address, or an owner's signed `push_reregister` (it cannot push this device) before any miss, also makes the
tab's read send this device's push token again, a new one in place of the one the owners lost, as an open of the app does ([Liveness](#liveness-pings-and-self-attestation)).

A device that cannot run a node (below) keeps the whole wallet; its tab says "This device can't run a node." (or,
on an Android secondary profile, that the node runs only in the main profile) and offers nothing to run.

The node balance belongs to the wallet, whichever device runs the node, and moving it takes only the wallet key, so
every state of a node the wallet has shows the balance and **Move to wallet** (not linking or not recorded: no node on
the chain yet). A balance no genesis gave yet, or one only refused (a refusal body is a failed read, never 0), shows
"—" with the button off; a failed read keeps the last figure.

**Which nodes the tab shows.** The wallet's node ids are pure functions of its address, the node's own derivations:
`light_mobile_` and `super_node_` followed by the first 16 hex characters of blake3 of `LIGHT_NODE_PRIVACY_` or
`SUPER_NODE_PRIVACY_` and the address (`WalletManager.generateLightNodePseudonym`, `generateSuperNodePseudonym`), and
`genesis_node_00N` for a genesis wallet. On opening the tab (and on pull-to-refresh) the app asks a genesis node for the
wallet's nodes (`/api/v1/activations/by-wallet`) and for the chain's registrations of those ids with the height each
was registered at (`/api/v1/account/{addr}/node-events`, `PushService.getWalletNodeEvents`: only the ids the wallet
derives are taken, and the burn field is not read). A super or genesis node is linked to the wallet only when two
genesis nodes confirm it (`/api/v1/verify-activation`); a light node record an older build kept on the device never
stands in its way. A super node's card comes first; the wallet's light node shows under it when the chain lists both
(an older wallet), with its own **Move to wallet**, and a link request for the light node
still answers `NODE_OTHER`. Under a server node the light card shows only a node of the wallet (on the chain, or a
link of it pending here), and its status is read again (every 5 minutes) only then.

**Counted and missed epochs of a super node** (`PushService.getNodeEpochs`): the node's verdict on each of the last 64
epochs the network settled (`/api/v1/rewards/history/{node_id}?limit=64`), from a genesis node, and a second one for
the epochs the first could not serve (three are asked at most); an answer for another wallet counts for nothing. Paid
(`claimable`, `claimed`) is counted and `not_eligible` is missed; epochs before the node's registration height
(node-events) are left out, its registration epoch is never missed, and an epoch no node could serve, or whose light
group was not checked, is neither. They are read only once the registration height is known, again at most every five
minutes while the tab is open.

**Before the network lists the node** (`src/services/NodeRecordRead.js`): while the tab is open and the network lists no
node for the wallet, the app reads aiqnet.io's record of the wallet's node
(`https://aiqnet.io/api/cabinet/activation/{wallet}`, no credentials) and keeps only its state and node type: on
opening the tab and on pull-to-refresh, and then with the tab's status refresh every 5 minutes while a record is on
its way; while the site says "none"
or cannot be read, the reads back off from 1 minute, doubling to 15. A node
the site recorded, which it keeps for good, or has on its way (`recorded`, `sending`), of a type the network does not
list yet gives the "not on the network yet" line above; a reservation alone (`reserved`) gives nothing. A read that
fails, is refused or cannot be parsed changes nothing on the tab: it shows what the network says. The link and reserve
sheets read the same record before a consent or a reservation (below) and give none when they cannot read it.

- **Use this device** (`PushService.bindThisDevice`): a confirmation that discloses the device check, with a link to
  the privacy policy, then a fresh authentication. The wallet key signs the delegation and the attach with
  `seq = max(now, binding_seq + 1)` (the binding two owners name alike, else the first owner's); the push token is
  taken only now; the body carries the unsigned hint `platform` (`ios`, an iPad included, or `android`), which the
  public status shows as the bound device's kind; once the node took the binding the tab reads the signed status at once and again 5, 15, 30 and 60
  seconds later while the node has not answered in this epoch (in the front and on this tab only), so the card turns
  from the waiting line to Online without a pull; once two genesis nodes serve `device_v1` the
  binding carries this device's enrolment. It goes to `POST /api/v1/light-node/bind` at the shard owners, first the
  one that issued the device challenge, and is taken only when the answer says `bound: true` for exactly that
  sequence. One retry follows a `stale_seq`. A binding that went out and got no answer is checked against the node's
  signed status, read again 2 and 8 seconds later (an issuer answers a bind within its 12-second device budget): a
  status that names its sequence keeps it here as taken, its ping key and push token with it and its device key
  waiting for the device tag; one that names another binding each time drops it and says the network did not answer;
  no status at all says the outcome is not known and to tap Use this device again if the tab does not show the node
  here within a minute, never that nothing changed. When the key rotation of the node's device record fell due by the
  chain's epoch (the signed status's `rotation_due`, or this device's own schedule), the binding attests a new key on
  every platform: a statement over a key the attestors already hold keeps that key's period, so re-proving it would
  leave the record held for rotation. A refusal is said on the card by its `reason`
  (`device_unlicensed` on Android adds Google Play's licence dialog). The refused enrolment's reference (`ref` of
  light-node-messages section 5.9) stays in the refusal record and no screen shows it: no text in the app asks the user
  to write to anyone, and what the user can do is on the card itself. One enrolment of the device runs at a time: a re-send
  meanwhile is skipped and Use this device waits for it, a re-send writes its next try before it enrols, and a binding
  holds this device's key only when the key it carried became the current one. The device schedule starts over with the
  binding (the bind answer's `rotation_due` and `device_state`), never from the status read before it. A device that
  can never give a vendor token (no Google Play on the device, no DeviceCheck) binds nothing and says it can't run a
  node, so a working device of the same wallet is never superseded by one that would never be counted. A binding
  whose device record waits in `check_pending` with no lease (`refresh_window` null: no vendor token went with it, or
  the oracle was not configured, did not answer in time or its lease did not verify) is taken but never counted, and
  only a new enrolment with a token ends that: for every binding that carried an enrolment the app keeps the signed
  binding (`qnet_node_enrol_again`, no secrets), and while the signed status says so the Node tab sends the same binding
  again (same sequence) with a fresh challenge and a token (`PushService.enrolAgainIfUnleased`), Google Play's dialog
  allowed, the first time only after 15 minutes (the attestors' vote on the key just posted refuses any other key for
  that sequence for 840 seconds) and then at the enrolment re-send's pace, never while a key sent without an answer
  waits to be settled; a `stale_seq` while the signed status still names that binding is that vote, tried again later,
  never the end of the task. A binding with a device block goes only to the owner that issued its challenge (any other
  refuses a stamp it did not issue): an issuer that does not answer leaves it unanswered, never refused.
- **The end of the binding here** (`PushService.stopLightNode`): the tab has no button for it. It runs when the user
  confirms aiqnet.io's `unlink` request on this device (the unlink sheet, below) and when the wallet is deleted or
  another wallet's node takes the device: the ping key signs `light_unbind` for the binding's sequence, with the device
  key's release when the node holds that key, to the owner that issued the release's challenge, within 8 seconds; the
  release's challenge gets at most 3 of them, and an owner that does not give it in time leaves the unbind without it,
  so the unbind always has the rest. Once signed, the device stops at once, before the network answers: the push token
  is deleted (Firebase waited for at most 4 seconds), the wakes stop and the ping key, the pending-link record, the
  enrol-again and refused-check records and the device schedule go; a wallet's deletion and erase also delete the
  device key. The node stays registered. A binding on another device, a lost one included, ends with the wallet key
  from any device that holds the wallet, through the same `unlink` request (the wallet form of `/unbind`, below).
- **A device check that waits** (`check_pending` within the key rotation's grace; `NodeTab.checkState`): the tab says
  which of three it is, never "still checking" for good. **Running** while the signed status names a refresh window (a
  lease to refresh, a daily recheck), while this device still has the binding to send again with a token
  (`qnet_node_enrol_again`), or within 24 hours of the binding (its `boundAt`): "The network is still checking this
  device, so the node is not counted here yet." **Ended with no verdict** otherwise (no lease and nothing left to
  send): the node runs here but is not counted; the tab says to make sure QNet Wallet comes from the device's app store
  and is up to date and to tap **Use this device** to be checked again, and on Android Google Play's licence line and
  dialog. **Refused** when the owners refused the check of that re-send with a device reason (`qnet_node_check_refused`:
  the reason and its reference, for that binding's sequence only; `PushService.nodeCheckState`): the same, with the
  reason in words. The device layer is off on the live network (`LIGHT_DEVICE_SERVE_EPOCH` is not reached), so these
  texts show only where a network serves it.
- **Another device took over, or the binding was withdrawn**: when two owners name a newer binding with a device bound,
  or say no device is bound at or past this device's binding (`forgetIfReplaced`, by B and D as in the table above), or
  a reply is answered `superseded`, this device tears down locally and gives its push token back, telling the network
  nothing. Owners refusing this device's key decide nothing on their own. Only an answer read for the binding the
  device holds now counts: a status read before a new binding is not held against it, nor is a binding made less than
  10 minutes ago (the owner that took it passes it on), nor the link sheet's binding while its record still sends it.
  A launch and a wake read the status with the ping key only, which a replaced device no longer holds: such a device
  stops at its next reply (`superseded`) or at the next read of the open Node tab. An expired link's binding goes when
  two owners say no device is bound; a wake reads that status signed with the ping key.
- **Offline**: the screen forces a self-attestation at most every 10 minutes; there is nothing to press.

**One wallet, one node, one device.** A wallet has one node, light or super (a super node only through the browser
extension). A light node runs on one device at a time: a newer binding (Use this device, the link sheet) replaces the
one before, and the device that held it stops. A light node is counted only while QNet Wallet runs on its device, in
the front, in the background or behind the phone's or the app's lock, and answers over the internet:

- A device runs only the current wallet's node. Opening a session of a wallet ends any node record another wallet left
  on the device (`teardownLightNodeIfForeign`: that node's ping-key unbind, then its keys and wakes go), and a binding
  made here first ends the node this device ran before (`adoptBinding`).
- Deleting or erasing the wallet stops its node for good, before its data goes (Key storage above).
- A reinstall keeps nothing of the old node: Android removes the app's data and Keystore keys with the app, and on
  iPhone and iPad the first launch of a new install wipes every Keychain item an earlier install left
  (`WalletManager.prepareInstall`), ping keys and the device key record included; the old push token is dead with the
  old install. The node runs here again only after Use this device or the link sheet, with a new ping key.
- The rule is the same on every phone and tablet, one function asked by every path that answers
  (`src/services/AnswerGate.js` `mayAnswer`: a push in the background or in front, a background fetch, the launch, a
  ping answer and a self-attestation round): the node answers only while the app runs after the user opened it at least
  once since the device last started, and not swiped away since. The app in front always answers and notes the boot it
  was opened in (`qnet_opened_boot`). In the background it answers only when that note names the boot the device runs
  now. A restart therefore stops the node until the app is opened again, on both platforms, and so does the first
  start of an updated app that was never opened. The boot is read from the clock that counts from the device's start
  and keeps counting in sleep (`DeviceSecurity.bootMark`: wall time minus that clock gives the start), and both
  platforms name it exactly, so setting the clock stops the node on neither: Android by the system's start count
  (`Settings.Global.BOOT_COUNT`), iOS by the system's boot session id (`kern.bootsessionuuid`, kept only as the first
  16 bytes of its SHA-256, `bootId`, and never sent). Only where neither is given (a note taken by a build before the
  boot id) are two starts more than 30 seconds apart two boots. A build whose boot clock does not answer cannot tell,
  and its node answers.
- Android: swiping the app away from the recent apps stops the node until the app is opened again. The task watch
  (`TaskWatchService`, started while the app is in front) and, from Android 11, the system's record that the last
  process ended for the removed task set a mark (`TaskState.kt`); while it is set `mayAnswer` refuses, and opening
  the app clears it. Two swipes leave no mark, and the node answers then, by the owner's rule that it answers when the
  app cannot tell: on Android 8 to 10 a swipe made more than about a minute after the app left the front, unless the
  battery exemption was granted (the system has stopped the watch by then and keeps no exit record below Android 11),
  and on any version a swipe after the system had already ended the app's process. Only a foreground service could see
  them, and the app runs none; the app's list of recent tasks is not read, since the system trims it without any swipe.
  So on such phones a swiped wallet can go on answering where an iPhone's stops. A data push still starts a swiped
  (and noticed) or restarted app in the background; it answers nothing. No periodic wake survives a restart (`startOnBoot = false`): opening the app
  configures it again.
- iPhone and iPad: the system delivers no background push and runs no background fetch for an app the user closed from
  the app switcher until the user opens it again or the device restarts; the app has no other wake
  (`UIBackgroundModes` `remote-notification` and `fetch` only, no VoIP push). After a restart the system may launch
  the app in the background for a push or a fetch without the user opening it, and the launch mounts the app's
  screens too, so a launch is not an open: its answer and upkeep wait for the app to come to the front
  (`PushService.initializePushService`), and a push or a fetch then answers nothing until it does.

## The device check

A light node runs on one phone or tablet at a time, bound to a hardware key of one app install
([light node messages](../protocols/light-node-messages.md) sections 1 and 5; `src/services/NodeDeviceKey.js` over
the native module `QNetDeviceAttest`, `src/services/DeviceEnrolment.js` for the messages):

- **The key.** iOS and iPadOS: an App Attest key in the Secure Enclave, attested by Apple, which signs as
  assertions, with a DeviceCheck token beside it. Android: an EC P-256 Keystore key (a remote-provisioned StrongBox
  key, else the TEE) made with the message's hash as its attestation challenge, signed over with the nine-flag device
  report, and a Google Play integrity token bound to the message (Google Play's integrity dialog may fix one). One key
  per install, never one per wallet; the key the node holds and one pending until it answers are kept in the
  Keychain, after first unlock and on this device only. There is no operating-system version minimum: the genesis
  nodes judge the evidence, and a computer, an emulator or a device that cannot prove its hardware is refused.
- **What the device itself can tell** (`checkDevice`): a Mac, a Vision Pro, the Simulator, an Android device that is
  a PC, TV, car, watch or embedded device or has no touchscreen, and an Android secondary or headless system user
  cannot run a node, and the app says so before anything is sent.
- **Enrolment**: a challenge `GET /api/v1/light-node/device-challenge?purpose=enrol` from the node's shard owners
  (the first that answers), the preimage `qnet_dev_enrol:v1|…` over the node, the wallet, the ping key, the binding's
  sequence, the challenge and the device's flags, and the `device` block with the vendor token on `/bind`, to the
  owner that issued the challenge and to no other. The key becomes current once the node took the binding; a refused
  one is dropped, and one sent without an answer is kept until the signed status's device tags tell whether the node
  took it. An iOS enrolment, from Use this device and from the link sheet alike, sends an assertion by its current key
  whenever the install has one, also when the node moves back from
  another device (the network keeps a key's entry past the record it served), so moving a node between devices adds
  nothing to Apple's count of attested keys; one the
  network no longer holds (`device_not_genuine`) is replaced by a new attested key once. A re-send of the link sheet's
  binding whose try attested a new device key waits 4 hours after a failure, doubling up to a day, so failed tries do
  not attest a key every few minutes (the platforms limit and the network counts a device's attested keys); one that
  made no new key (no owner gave a challenge, or the current key proved itself) comes again after the short waits below;
  one a background wake makes stays within the wake's deadline, and no key is attested that could not be posted in time.
- **Every answer** of a node that holds this device's key, once two genesis nodes serve `hwping_v2`, carries
  `ping_hw2:{σ}.{device signature}.{hw_seq}`: the ping key's signature of `selfattest:{h}:{hash}` and the device
  signature over `qnet_hwping:v2|…` of the same anchor and `sha3(σ)` (Android's `hw_seq` a strictly increasing
  millisecond counter per device key, restarted from the clock when it is more than a day ahead of it; iOS 0 with the
  assertion's own counter). A key that cannot sign leaves the answer in the earlier form; a key that no longer exists
  marks the binding as holding none, and the Node tab offers Use this device. A key is gone only on proof: on Android
  only when an answered listing of the Keystore leaves its alias out (a Keystore that did not answer is busy, never a
  lost key: `NodeDeviceKey.kt` over `KeyPresence`), and a failure of a key being made (a rotation's or an enrolment's
  new key) never stands for the current key. A key a rotation replaced between the
  reply reading it and signing with it is not lost: the reply is signed again with the key now current, and only the
  key that failed is ever forgotten.
- **Lease refresh and rotation**, from the wakes, without the wallet key: inside the refresh window of the signed
  status the device signs `qnet_dev_refresh:v1|…` with a vendor token (`/api/v1/light-node/device-refresh`, once per
  window; a try that did not go through waits 30 minutes, doubling up to 12 hours, and at least what the node asked,
  before the next, with no challenge, token or POST meanwhile; a lapsed lease's window starts again at every status
  read, so a window that overlaps the one kept is that window and keeps its back-off and the reason its last token
  failed); once the chain reaches the epoch of `rotation_due` (the
  chain's epoch as the device last read it, never the last epoch it was credited in: the node stops crediting an
  unrotated key 30 days after it fell due, and only the rotation ends that) a new key is attested over
  `qnet_dev_rotate:v1|…` and the old key signs it (`/api/v1/light-node/device-rotate`), tried again at most every six
  hours, and after a refusal only after 6 hours, doubling up to 4 days, and at least what the node asked however long
  (up to 62 days: for a rotation it takes as early, the time to `rotation_due`), since each try attests a new key; a
  wait is void on a clock set back past the time it was written, and a new rotation epoch starts the tries over. The
  chain's epoch comes from one genesis node's height or a pushed anchor, neither signed, so a read is taken only within
  reach of the last one known (one epoch more, plus one for every four hours since), and a lower read replaces it once
  reads have said less for a day: no single wrong value pins the rotation as due. Each answer's `rotation_due` and
  `device_state` are kept. Why a refresh went without a vendor token is kept too: when Google Play's dialog can fix it
  (`PLAY_FIXABLE`, Play Store or Play services out of date), the Node tab tries the refresh again with that dialog, past
  the back-off and at most once an hour, so such a device can mend its lease from the app. The vendor token is asked first (neither token depends on the new key),
  and no key is attested without one, with too little of the wake left to post it, or while the record is paused,
  ended or waits for a check with no lease, since the node refuses such a rotation and every attested key counts toward
  the device's limits. A wake whose schedule knows no refresh window ahead (or no rotation
  epoch) reads the signed status itself with the ping key, at most every three hours, so a node woken only by pushes
  or background fetches learns each new window without the app being opened. Every call of a wake stays within its
  deadline. A rotation that got no answer keeps its new key (the node takes up to 95 seconds for it, and its statement
  reaches the other owners within minutes): a signed status read (a wake, the Node tab, a launch) in which one owner
  names the new key makes it current; the new key is dropped only 75 minutes after it went (past the statement's last
  re-send to the other owners, at 1 hour), when two owners name the old key and none the new one
  (`NodeDeviceKey.settleByTag`); no other rotation starts before. Every status read with device tags settles such a
  key, whatever the binding says of its key (`PushService.settleUnansweredKey`), and one an owner names makes the
  binding one that holds this device's key. The link sheet's pending binding, once the chain shows a device bound,
  keeps its enrol-again record, so a statement that went without a lease is enrolled again with a token.
- **Disclosure.** The link sheet and "Use this device" show the device-check text before Confirm, with the privacy
  policy; Confirm is the consent and unlinking the node from this device (the unlink sheet) ends it. Nothing goes
  through aiqnet.io.
- A build signed with the upload key runs the whole flow: the network marks its device check as a test build, which
  only a testnet node accepts.

## Requests from aiqnet.io (QNet Link)

aiqnet.io asks this wallet, through a link `https://link.aiqnet.io/l#v1.<id>.<sitePub>.<intent>[.<reqHash>]`, to
share its addresses (`connect`), to confirm that the page may prepare its light node with a one-time payment address
(`reserve`), to consent to its light node and link it to this device (`link`), to unlink its node from the device it
runs on (`unlink`), or to move its node balance (`claim`):
a button on a phone or tablet (on Android an `intent:` URL naming `io.aiqnet.wallet`, whose
data is that same link), a QR code on a computer. The protocol is [QNet Link v1](../protocols/qnet-link-v1.md)
section 14; the app side is `src/services/QNetLink.js` (parser, request, relay client, crypto, answer, offers),
`src/services/NodeLinkActions.js` (the Node side of a request) and `src/screens/QNetLinkScreen.js` (the sheets).

- **Only a verified link.** Android declares one App Link filter, `https`, host `link.aiqnet.io`, path exactly
  `/l`, `autoVerify`; the site's `intent:` URL reaches the app through the same filter. iOS has the associated
  domain `applinks:link.aiqnet.io` and forwards Universal Links to React Native's `Linking`. The app has no custom
  URL scheme. An Android activity restored or relaunched from recents drops the link that first started it.
  `link.aiqnet.io` serves `/.well-known/assetlinks.json` (the Play app-signing certificate) and
  `/.well-known/apple-app-site-association` (the Team ID).
- **Parsed strictly.** The whole URL must match the revision 2 pattern, with a canonical 32-byte site key that is
  not a low-order point, and a canonical request hash exactly when the intent is not `connect`; an `activate` link,
  or anything else, shows "This link cannot be opened." and fetches nothing.
- **Checked against the relay.** The app reads the session from `https://aiqnet.io` (a constant of the build,
  10 s timeout, no cookies, a redirect is a failure) and refuses it when its site key or intent differ from the link,
  when its request is not one the app rebuilds to the link's hash (`requestText`, `reqHashOf`), when it is already
  answered, has under 30 s left, or was already decided on this device.
- **What each sheet offers**, read before any authentication and signing nothing (`prepareOffer`): the wallet the
  request names by `walletHash` must be the open one (`WALLET_MISMATCH`); for `link` and `claim` the node's status
  comes from two genesis nodes (`NETWORK` when they give none).
  - `reserve`: "Set up a light node for this wallet", the node and the wallet, and "The website that showed you this
    link prepares a light node for this wallet only. No funds leave this wallet. QNet Wallet asks you once more when
    the node is added." The request is exactly `{walletHash, burner}`: the wallet, never left out, and the page's
    one-time payment address, which the sheet does not show. A server node linked here, a super or genesis node that
    two genesis nodes confirm for the wallet, or a super node's burn aiqnet.io holds for it (reserved, on its way or
    recorded): `NODE_OTHER`, and `NETWORK` when the genesis nodes do not answer or aiqnet.io's record cannot be read.
    The sheet shows no price, payment, code or link; the site checks that the wallet has no node yet.
  - `link` for a node on the chain: "Link this wallet's node to this device", the node and the wallet, the device
    check, and, when another wallet's node runs here, "The node of {wallet} stops on this device."; a device that
    cannot run a node answers `BIND_REFUSED`. For a node not on the chain with a burn: the same sheet with the
    wallet's consent, or, on a device that cannot run a node, "This device can't run a node. Confirm to add the node
    to this wallet. It can run on another device later." With no burn: `NO_NODE`; a server node linked here, or,
    before a consent, a super or genesis node that two genesis nodes confirm for the wallet, or a super node's burn
    aiqnet.io holds for it (reserved, on its way or recorded; one wallet, one node type, chosen once): `NODE_OTHER`,
    and `NETWORK` when the genesis nodes do not answer or aiqnet.io's record cannot be read. A request for a burn made
    from a Solana address names it (`{burnTx, walletHash, check, burner}`, the wallet and the burn never left out): for
    a node not on the chain the sheet is the same, offered only when `burner` is the open wallet's own Solana address
    (`WALLET_MISMATCH` otherwise); it names no burner, burn, code or price.
  - `claim`: "Move node balance to this wallet" with the amount the app reads itself (the largest of three genesis
    answers; the site sends none), or "below 1 QNC, nothing to move"; one move at a time (`CLAIM_BUSY`).
  - `unlink`, on the device that runs the node (it holds this wallet's binding, `NodeLinkActions.binding`, and the
    status signed with its ping key names that binding or gives no verdict): "Unlink this wallet's node from this
    device", that the node stops running here (the app stops answering for it and deletes its answer key and push
    token here) while the node and its balance stay with the wallet, the node, the wallet and the day this device was
    linked. The request is exactly `{walletHash}`, never left out.
  - `unlink` on any other device that holds the wallet (or one whose binding two owners no longer name), once two
    genesis nodes serve `unbind_wallet`: "Unlink this wallet's node from its device", that the node stops running on
    the device it runs on now while the node and its balance stay with this wallet and it can run on any device later,
    the node, the wallet and the day that device was linked (the public status's `device.linked_since`; the kind of
    device is not named, as no text of the app names a platform). Not on the chain, no device bound, or the form not
    served: `NOT_LINKED`; no verdict on the chain or on the device: `NETWORK`.
- **Shown and confirmed.** The request opens over the unlocked wallet (a locked wallet says a request is waiting).
  The sheet names aiqnet.io as the origin and says "continue only if you started this on aiqnet.io yourself just
  now". Reject answers `rejected` with no authentication. Confirm arms only once the sheet has been on view
  untouched for one second: every touch before that starts the wait again, a press counts only if it began after
  the button armed, and leaving the app disarms it (`src/utils/useArmedConfirm.js`). It then asks for the device
  authentication or the app password.
- **What Confirm does.**
  - `reserve`: T = now; the wallet key signs the node reservation above for the request's payment address, and the
    app checks what it signed before it goes (the open wallet's key, a 3309-byte signature, T within 300 s of now). The
    answer is `ok` with `qnet`, `time` (T as a decimal string), `pk` and `sig` (b64url): the site verifies it over the
    reservation of its own request, admits T from 900 s before to 300 s after its clock, and only then shows the
    payment address. The sheet says "Confirmed. Go back to the website to continue."; nothing runs on this device
    until the `link` sheet after the burn.
  - `link`, node not on the chain (`PushService.linkWithConsent`): T = now; the wallet key signs its consent
    `q1337|client_node_reg:{N}:{W}:{proof}:{T}` over the proof it computes from the request's burn, and, on a device
    that runs the node, the delegation and attach with `seq = ts = T`; the push token is taken; the device is enrolled
    when served; the binding goes with the consent to the owner that issued the challenge and to the node's backup
    owner; the device keeps the ping key and the binding; the pending-link record `qnet_node_link_pending`
    (`{nodeId, wallet, T, createdAt, bound, bindBlob}`, no secrets) lives until the chain lists the node or T + 24 h
    + 10 min. While it lives, a status read that shows the node on the chain with no device bound sends the same
    binding again with a fresh enrolment and no authentication (`resendPendingBinding`, on the Node tab, at launch,
    on a background wake); a try that failed for now (no network, a rate limit, a device check not made) comes again
    1, 2 and 4 minutes later (each wait up to a fifth shorter), then every 2.5 to 5 minutes, or as late as the node asks; only
    a try that attested a new device key waits 4 hours, doubling up to a day (above). A device check that could not be
    made at Confirm posts nothing and leaves the binding to that re-send. When the owners refuse the binding for
    good, the device keeps nothing (no ping key, no record, no push token) and the sheet says why; the consent still
    stands. The answer is `ok` with `{ts, pk, sig}` (b64url) and whether the owner took the binding; it carries
    nothing about the device. For a request with `burner`, the wallet's stored Solana key (it must give that address)
    also signs the burn's owner bind v1 with the same T, checked against the key before it goes and wiped after, and
    the consent carries it as `ownerSig` (b64url, 64 bytes): such a burn was made from this wallet's own address, so no
    one else could sign it. Any other burn's owner bind is the burner's, signed on the website.
  - `link`, node on the chain: "Use this device" with the sheet's device check; the answer is `linked` with the
    binding's sequence. A binding or a move that went out and got no answer is answered `NETWORK` (the protocol has no
    code for an unknown outcome), and this device's sheet says the outcome is not known (the move may have gone
    through; the node may run here), never that nothing changed.
  - `unlink` on the device that runs the node: the end of the binding here (`PushService.stopLightNode`, above); an
    unbind the network did not take goes again in the wallet form where two genesis nodes serve it. The Node tab reads
    the network again. The answer is `ok` with `unbound`, whether the node took the unbind; the sheet says the node no
    longer runs here, and when `unbound` is false that the network did not confirm it and may still show this device
    linked until another device is linked.
  - `unlink` by the wallet key (`NodeLinkActions.unlinkByWallet`): the status signed with the wallet key names the
    binding S two owners report alike while a device is bound; the wallet key signs
    `q1337|light_unbind_wallet:{N}:{S}:{ts}` (`NodePreimages.walletUnbindPreimage`, checked against the key before it
    goes) and the unbind goes to `POST /api/v1/light-node/unbind` as `{node_id, seq, ts, signer: "wallet", sig,
    identity_pubkey}`. Taken (`unbound: true`): `ok` with `unbound: true`, "The node no longer runs on that device. It
    can run on any device later."; `stale_seq` reads the status again and is `ok` when two owners say no device is
    bound, else `UNLINK_REFUSED`; any other refusal `UNLINK_REFUSED`, no answer `NETWORK`. This device's own records
    are not touched; the device that ran the node stops at its next reply or status read.
  - `claim`: the move above; the answer is `ok` with the amount as a decimal string, the transaction and the epoch a
    partial move stopped at, or `empty`. The amount is at least 1 QNC, except for a batch the node's quote capped
    (the stopping epoch is set, more epochs remain), which may be smaller and is answered as moved, since its
    transaction is on the way.
- **The answer** is sealed to the page's one-time key (X25519, HKDF-SHA256, AES-256-GCM with a fresh app key and IV)
  under an AAD that binds the session, the intent and the request hash, checked against the site's own rules before
  it goes (`plaintextProblem`), and posted once; after a network failure the identical body is retried while the
  session lives. If another device answered first the app warns not to trust what the website shows. When the
  request asked for it (`check: true`) and the relay took an answer that names the wallet, the sheet shows "Check
  number: 482 913", the six digits the page asks the user to compare (kept with the outcome when the wallet locks
  meanwhile, and in their order in a right-to-left language). The app always shows the outcome itself, with a
  button to the Node tab after a link.
- **Nowhere else.** No screen of the app leads to these sheets; the app contacts the relay only when the user opens
  such a link. Their texts are translation keys `link_*`, in every language like the rest of the app.

## In-app browser

The Browser tab (`src/browser/`) is a general web browser: an address bar that assumes https and shows the page's
origin with a lock and its registrable domain in bold, back, forward, reload, tabs, share and copy the address, a start
page with the aiqnet.io explorer and the recent pages, and "Clear browsing data". A page opened (typed, the explorer,
a recent page) or a link tapped shows its address in the address bar at once, while it loads, without the lock and the
bold domain, with the progress bar and Stop, and opens in the same tab; once the page commits it is the page's own
address, and a load that ends without committing (a 204, a download, an error, Stop) puts back the address of the page
still on screen. The origin a site's requests and the confirmation sheets are bound to is always the committed page's.
A page opened again loads again: the one a tab was first given, after the tab moved on to other pages, and the one on
screen, which is reloaded. Typed text that is not an address
is refused, never sent to a search engine. A site connects the wallet through the provider protocol of the QNet
browser extension ([browser-wallet](browser-wallet.md), `applications/qnet-wallet/CONTRACTS.md` section 4), so a
website works the same with both.

- **The WebView** (react-native-webview 14.0.1, pinned, patched by `patches/react-native-webview+14.0.1.patch`):
  https only (a development build also loads plain-http `localhost` / `127.0.0.1`), no mixed content, no file
  access, no new windows, no payment request API; camera, microphone and location requests are denied, and there
  are no downloads. The browser stops a page's file upload as far as scripts can; below iOS 18.4 WebKit gives the
  app no say over a page's upload sheet, so that sheet can still appear, and a photo reaches the page only when the
  user picks or takes one there. The app's own camera use is the Send screens' QR scan only (the camera text in
`Info.plist`). A
  navigation to any other scheme (intent:, market:, tel:, mailto:, custom
  app schemes, http:, file:, data:, blob:, javascript:) is refused natively and in JS, and never handed to another
  app; links from other apps never open here. The site's node pages (`/node…`), `/activate`, `/wallet` and `/l`,
  the pages the site keeps out of the app's view (its home, `/docs`, `/dao`, `/testnet`, `/qnet-wallet-extension`),
  on aiqnet.io and the two names that serve the same site (`www.aiqnet.io`, `explorer.aiqnet.io`), and every page of
  `link.aiqnet.io`, are refused in every frame (`src/browser/url.js`, and natively in the patched Android WebView
  client), whether or not the site redirects its other names; other subdomains are ordinary sites; a refused top page opens the explorer instead, and a move within a page to one of them
  (`history.pushState`, which iOS reports only as a navigation state) is left at once and never shows its address. Both
  platforms show the same notice ("This aiqnet.io page does not open in the wallet's browser.") and open the same
  page: the Android client refuses natively and reports each such refusal to the JS policy (`reportWalletOnly`), so a
  link, a redirect or a form opens the explorer, and a page's own history change goes back, or opens the explorer when
  there is nothing to go back to. Android asks the JS policy about every other main-frame navigation while its UI
  thread waits, at most 250 ms; one not answered by then (the app busy) is refused, asked again without waiting
  (`askJsToLoad`) and loaded once the JS policy allows it, so a link tapped while the app is busy opens late, never not
  at all, and nothing loads that the JS policy did not let through. Every tab's WebView has these settings and this
  policy.
- **Tabs** (`src/browser/tabs.js`), in memory only, never stored. The tabs button next to the address bar shows how many
  are open and opens the tab overview over the browser: each tab by its page's title (hidden characters replaced) and
  host, or "Start page", the one in front marked; a tap brings a tab forward, × closes it (a screen reader names the
  tab it closes; the next tab comes forward, the one before when it was the last; closing the only tab leaves a fresh
  start page), "New tab" (also in the ⋮ menu) opens the start page in a new tab in front, and "Close all tabs" leaves
  one fresh start page, after asking first while a tab holds a page (the sites open in them are signed out). While the
  overview is up it is all a screen reader reaches: the toolbar, the notices and the pages under it are hidden. At
  most 8 tabs: every open tab keeps its page loaded (nothing is discarded in the background), so the cap bounds the
  memory the browser holds beside the wallet and the light node; at 8, "New tab" is off and a note says why. Each tab
  has its own WebView, back and forward history, address, loading state and page session: a request is bound to its
  tab, answered into that tab only, and a page never sees another tab's requests or answers. Only the page of the tab
  in front is visible and touchable; the others stay loaded, hidden from touch and from screen readers. A page that
  leaves the screen (its tab goes behind or under the start page, or the whole browser is hidden) keeps running (its
  timers and connections go on) and is not told it is hidden, but its audio and video are paused: every audio and
  video element of its document, open shadow roots and frames of its own origin. A page may start them again, and
  sound made through Web Audio or in a frame of another site is not paused. On Android every tab's WebView shares one
  render process; when it is lost, the tab in front reopens the page it showed in a new WebView at once, and a tab
  behind drops its WebView and reopens its page when it comes forward (the back history of a reopened tab starts
  again). Android back closes the overview, the menu or the typed address first, then goes back in the tab in front;
  from that tab's first page it leaves the Browser tab. Pages of every tab go into the recent pages; a page that
  finishes loading in a closed tab, or while "Clear browsing data" runs, is not kept. On a narrow phone (a toolbar
  under 360 dp wide, a 320 dp phone) Forward is in the ⋮ menu, so the address keeps its room for the domain.
- **Browsing session.** Cookies and site storage (localStorage, IndexedDB, service workers) live for one browsing
  session: it starts empty with the first page opened while no tab holds a page, and ends once no tab holds one (the
  last such tab closed, "Close all tabs", "Clear browsing data", a change of wallet, the app ending). The two platforms
  keep it differently, because react-native-webview's `incognito` means different things on them
  (`src/browser/webViewEvents.js` `incognitoFor`, pinned by `__tests__/BrowserTabs.test.js`):
  - Android has one cookie store and one site storage for all of an app's web views, and `incognito` wipes both, and
    the app's HTTP cache, whenever a web view is created with it (`RNCWebViewManagerImpl.setIncognito`). Only the web
    view that opens the session's first page carries it; every other tab joins that session, so opening a tab never
    signs another tab out of its sites. The tabs share the session, and no tab is answered from the HTTP cache
    (`cacheEnabled={false}`), though what a page loads may still be written to that cache. The system keeps the cookie
    store, the site storage and the HTTP cache in the app's private storage as it goes; what a session left there is
    wiped when the next session's first page opens, and at once by "Clear browsing data": a hidden web view without
    scripts, created with `incognito` while no tab holds a page, does the wipe and goes (`clearNeedsWipe`). Deleting,
    erasing or replacing the wallet wipes it at once too, on both platforms (`DeviceSecurity.clearBrowserData`).
  - iOS gives each incognito web view a data store of its own, in memory only (WebKit's `nonPersistentDataStore`), and
    every tab carries it: each tab has its own session, nothing of it is written to disk, a new tab never touches
    another's, and it ends with its tab. A site signed in to in one tab is not signed in in another tab.

  "Clear browsing data" closes every tab (one fresh start page is left), ends every open request, forgets the recent
  pages and deletes the cookies and site data (on iOS they went with the tabs' web views; on Android the hidden web
  view above wipes them). Pages stay loaded while another wallet tab is open and under the lock screen; locking ends every open
  request of every tab (4100) and tells every tab's connected pages the accounts are gone, and unlocking gives them
  back.
- **The provider** is injected into the top frame of https pages only, before the page's content loads (iOS: at
  document start; Android: when the page starts and again when it has loaded, the second run changing nothing). It announces itself like the extension's (`qnet:announceProvider`, rdns
  `io.aiqnet.wallet`, name QNet Wallet) with `channel: 'mobile'`, so the site's node pages know they are in the
  app's browser, which never opens them anyway. Methods: `qnet_requestAccounts`, `qnet_accounts`, `qnet_chainId`, `qnet_disconnect`,
  `qnet_signMessage`, `qnet_sendTransaction`, `qnet_getTransactionStatus`; anything else — node activation and all
  Solana signing included — is 4200. Errors 4001/4100/4200/4900/-32602/-32603 and the events `accountsChanged` and
  `disconnect` are the extension's; a -32602 for a parameter the network does not accept today carries
  `data: { reason: 'UNSUPPORTED_PARAM' }` and the text "Unsupported parameter". Parameters are checked in
  `src/browser/dappRequests.js`, a file without React Native imports.
- **Origin integrity.** A request's origin is the one the platform reported for its sender: Android receives
  messages only through `WebViewCompat.addWebMessageListener` (the library's `addJavascriptInterface` fallback, which
  every frame can reach, is removed) and drops a message that is not from the top frame or not from https; iOS drops
  a message whose `WKFrameInfo` is not the main frame and passes `securityOrigin` on. Each event carries
  `frameOrigin` and `isMainFrame`; the app refuses a message without them, and nothing in a message body can name
  an origin (`src/browser/bridge.js`). Each request is bound to its tab, the origin, the page's document and a
  navigation count (an answer goes into that tab only, and closing the tab drops it): a navigation to another origin, a new document (the same origin included: a reload, a link or a form to
  another page of the site; iOS tells it at the navigation's commit, and on both platforms the new document announces
  itself with its first message, while `history.pushState` is no new document) or a user navigation closes the
  request's sheet as a rejection and drops its answer, and the answer script itself checks `location.origin` before
  the page sees anything.
- **Confirmation sheets** (`src/browser/DappSheet.js`) are drawn by the app over everything: the origin (registrable
  domain in bold, the full origin under it, an international name decoded with a warning that shows its real
  form), then for a connect both addresses, for a message the exact text and its size, for a send the recipient,
  amount, fee, total, the balance and a warning when the
  balance is short. A token transfer shows the token's symbol, name and contract, a "not QNC" warning when the token
  uses QNet's name, a warning when it is not in the user's token list, the recipient, the amount in the token's units and in base units, the QNC fee, the refundable deposit
  of 0.01 QNC when the recipient holds none of the token, the QNC total, the token balance (from a certified proof)
  and the QNC balance, and a warning when the recipient is the canonical burn address, whose tokens are
  destroyed; a QNC transfer to that address says the QNC is destroyed, in place of the recipient warnings. A contract call shows the contract with an "unknown contract" warning, the method, the input as hex with
  its size (and as text when it is visible UTF-8), the gas limit and the most it can cost; a call sends no QNC. A send
  the preview shows the wallet cannot pay for, or whose balances it could not read (it then offers Try again), keeps
  Confirm off, a QNC transfer
  as much as a token transfer or a call (the extension's rule): its amount and fee, a token transfer's tokens, fee and
  deposit, a call's fee, each against the spendable QNC, which is the balance less what every unconfirmed transaction
  of the wallet may still take, and a token transfer's tokens against the token balance less what they may still move,
  the one a "replace" signs over excepted (`dappProvider.previewShort`, `spendableNano`, `spendableTokenBase`). A
  payment the chain would refuse for its balance never becomes a kept transaction that could go out after a later
  top-up. A QNC or token balance counts only when the committee certified it, less what this wallet's own transactions
  since took, by the Send form's rule above, counted up to the confirmed nonce the sheet shows; a balance that cannot be
  read says why: a transaction from another device not confirmed yet, a balance not confirmed yet, or the wallet's state
  not read (`DappSheet.unreadKey`). The approval reads the QNC balance (and a token transfer's token balance and deposit)
  again just before signing any send and signs nothing when one cannot be read, is too low now, or the deposit
  changed; the sheet then says so. The recipient warnings rest on the addresses this wallet signed transfers to (kept sealed under the
  vault's data key) and its unconfirmed transfers, never on who sent to it: a recipient never paid, one with the same
  first and last four characters as a known or paid address (look-alike), and one that only ever sent to this wallet
  (address poisoning). Confirm arms only once the ready sheet has been on screen untouched for one second (one and a
  half for a send; a message to sign must also have been wholly inside its box, border and padding counted, or
  scrolled to its end); every touch before that starts the wait
  again, and a press counts only if it began after the button armed (`src/utils/useArmedConfirm.js`). It then asks
  for the wallet's fresh check, the same on every phone and tablet: the device authentication (Face ID, Touch ID, a
  fingerprint, a face or the device passcode), or, for a wallet that opens with the app password, that password or
  the biometric prompt that stands in for it ([Key storage and custody](#key-storage-and-custody)); a send's
  recipient is on that prompt too. The approval waits until the app is in front again (iOS reports it inactive while
  Face ID or the passcode is on screen and may reply first), and a confirm the approval refused says so on the sheet.
  One sheet at a time;
  at most three waiting per origin; at most five sheets a minute and twenty in 10 minutes for one origin, however they
  ended, until an approval clears the count; a single rejection holds nothing back, and the fifth within 10 minutes
  holds the origin back 60 s (the extension's numbers);
  a sheet left open 10 minutes ends as a rejection, unless its approval is signing and sending then: it ends with its
  own result, and one that goes back to the sheet afterwards (nothing signed) ends as a rejection then. A page that is
  not on screen (a browser tab not in front, a page under the tab overview, another wallet tab, the app in the
  background) gets no sheet (4001, at once: nothing is held for later), nor does a request whose tab went behind or
  was closed while it was being read, nor one whose page went away meanwhile (that one counts against the origin's
  sheets); a locked wallet answers 4100. A sheet therefore always stands over the page that asked, and names its origin. While
  one is up it covers the browser: no tab opens, closes or comes forward until it ends.
- **Signing a message** is the extension's: ML-DSA-65 with the FIPS 204 context `QNET_OFFCHAIN_MSG_v1` over
  `"QNet Signed Message:\n" + origin + "\n" + byteLength + "\n" + message`, refusing protocol prefixes, hidden
  controls and more than 4 KiB before any sheet (`src/crypto/OffchainMessage.js`, pinned byte for byte against the
  extension by `__tests__/fixtures/offchain_message_vectors.json`, generated with
  `node scripts/offchain-message-vectors.mjs`). The key is decrypted for that signature and wiped.
- **Transactions.** `qnet_sendTransaction` takes exactly one of three forms, and any other key is -32602:
  - `{to, amount}` or `{type: 'transfer', to, amount}`: QNC, `amount` as canonical decimal text (no leading zeros, at
    most 9 decimals). The app keeps a signed transfer as JSON, whose numbers are exact up to 2^53 − 1, so a site's
    transfer and its fee stay below 9,007,199.254740991 QNC (the extension takes the whole u64 range).
  - `{type: 'tokenTransfer', token, to, amount}`: a QRC-20 token, `amount` in the token's own units. The token's
    standard, name, symbol and decimals are what two genesis nodes agree on (`GET /api/v1/token/{contract}`); a
    contract that is not a QRC-20 token, more than 18 decimals, or more decimals in `amount` than the token has is
    -32602 before any sheet, and a token that cannot be read is -32603. When the user's token list holds the token
    with other decimals, nothing can be signed.
  - `{type: 'contractCall', contract, method, args, gasLimit?}`: a WASM contract, `args` its input as even-length hex
    (at most 4,096 bytes, `""` for none). Two genesis nodes must agree the target is a contract that is no built-in
    token (`GET /api/v1/token/{contract}`): a token or an address with nothing there is -32602 before any sheet, and a
    target that cannot be read is -32603. The gas limit is the call's intrinsic gas plus 200,000 fuel unless the site
    gives one, which must leave at least 10,000 fuel and stay within 1,000,000. `value` and `accessList` are refused
    with the UNSUPPORTED_PARAM reason: the network does not take either on a call today.

  Every form is built with the shared builders (`src/crypto/TxBuilders.js`) and goes through the wallet's own send
  path (PendingTx nonce rules, the signed bytes kept and resent as they are, kind `transfer` or `call`); it is signed
  only if the wallet's next nonce is still the one the sheet showed, otherwise the sheet shows the new one. A site's
  send signs only at the confirmed nonce + 1, the one nonce a node admits (the extension's one transaction in flight):
  while an earlier transaction holds it the sheet says so, keeps Confirm off and reads the preview again every four
  seconds until it is in a block; the user may instead replace the one unconfirmed transaction at the confirmed nonce
  + 1. Nothing is sent in addition to it, and the wallet refuses any other nonce for a site (`NONCE_CHANGED`). The page
  receives the extension's result: `{status, from, to, amount, nonce, txHash}` for a transfer,
  `{status, from, token, to, amount, nonce, txHash}` for a token transfer and `{status, from, contract, method, nonce,
  txHash}` for a call, with `status` `'submitted'`, or `'unknown'` and `txHash: null` when no node confirmed the
  submit, and `nonce` as decimal text. A send every node it went to refused for good (the balance, the signature, an
  amount the node rejects: nothing waiting can change, and the wallet never sends it again) answers the page -32603, as
  the extension's NODE_REJECTED does, and the sheet says it was refused, with the node's reason, as the Send form says
  it; a refusal waiting may heal (or one that came while another node's copy went unanswered) keeps `'unknown'`, and
  the sheet says the wallet sends it again for up to half an hour, which it does whatever tab is open while the app is
  in front (a sweep every 15 seconds while a kept transaction is still sent). A transaction is identified by (`from`, `nonce`); `txHash` is the hash one node
  gave its copy, and another node's copy, with another hash, may be the one that lands.
- **Transaction status.** `qnet_getTransactionStatus {from, nonce}` (no sheet; the connected account only, else 4100)
  answers `{status, blockHeight, txHash}`: `'pending'` while the account has not reached the nonce and this wallet
  still sends the transaction there (not stopped, not refused for good, and still able to land: the extension's rule),
  `'in_block'` once two genesis nodes list the same transaction of the account at that
  nonce (`blockHeight` only when two genesis nodes report the same one, else null; `txHash` the copy that landed),
  `'unknown'` otherwise, and
  when the one listed is not the one this wallet signed there. It never reports that a contract call did what it was
  meant to: the chain records no outcome. An answer is reused for 3 s, and one origin starts at most 20 reads a
  minute (4001 beyond).
- **Grants** are per origin, stored under AsyncStorage `qnet_dapp_sites` sealed with the vault's data key
  (AES-GCM, vault id and purpose in the AAD), so storage written by anyone else is no grant and another wallet's
  record does not open. They hold for every tab: a site connected in one tab is connected in all. Settings → Connected
  sites lists them and disconnects one (every tab showing that site gets `accountsChanged {}` and `disconnect`; a
  connect in one tab sends `accountsChanged` to every tab of that site). They and the recent pages are cleared when
  the wallet on the phone changes or is deleted.
- Texts are translation keys `tab_*`, `assets_*`, `browser_*`, `dapp_*`, `sites_*`, in every language like the rest
  of the app.

## Liveness: pings and self-attestation

Only a node that is on the chain and linked to this device is woken, and only such a device holds a push token: the
app asks for no notification permission and shows no notification (the pushes are silent data messages);
`firebase.json` turns Firebase's automatic token issue off on both platforms; the token is read only when a binding
is made or a linked node's token changes (`PushService.pushTarget`) and deleted on Stop, on a takeover and when the
wallet goes. The network's pushes name no node: `{"action":"epoch","anchor":"{h}:{hash}","sent_at":"{s}"}` (`sent_at`
the network's Unix time, absent from an older node), answered over that anchor at once: every push of an owner's round
and of its retry round while the epoch is not counted here, whatever a failure or a refusal left behind, none once it
is, and pushes that arrive together share one answer; `{"action":"wake",…}` for "I'm back" on the website, answered
even when the epoch was already answered. A push of an older node without either form is still answered. A pushed
anchor goes at once also when the app's own launch round (iOS starts the app for the push) is still reading the chain.
Every answer to a push carries `sent_at`, `received_at` (when this device took the push) and `answered_at` (when it
posted the answer), decimal seconds as strings, since the route reads a flat map of strings and an older node ignores
them: the node derives how long the push took to reach the device whatever this device's clock says,
`(its receive time - sent_at) - (answered_at - received_at)`, and the app's own handling time, `answered_at -
received_at` (the Node tab's "the wake reached this device N min after it was sent"). How much the system lets the
app run in the background stays on the device: no answer carries it
([Background priority](#background-priority-on-android-and-ios)).

Every push with an anchor also goes into a small record of the pushes this device took (`PushReceipts`,
`qnet_push_receipts`, one for the binding and gone with it): per epoch, the `sent_at` and `received_at` of its first push
that reached this device, and what the app did with that epoch's pushes: `answered`, `not_opened_since_boot` or
`swiped` (the answer rule held it), `after_commit` (it came inside its epoch's closing gap, or after the epoch ended),
`answer_failed` (no owner took the answer, or the wake ended first), `already_counted` (this device had answered in that
epoch already) or `no_key` (no ping key here). A later answer of this device in that epoch makes it `answered`, which
nothing replaces. The record keeps the last six epochs and names the first epoch from which it holds every push that
reached this device: the epoch after the first height this build read, or the epoch of the first push it took. Every
self-attestation then carries, as the string field `push_receipts` with `answered_at`, the JSON
`{"since": E, "pushes": [{"epoch", "sent_at", "received_at", "outcome"}]}` for the epochs from `since` to the one
before its own, at most six (a full report stays far under the node's 2,048 bytes); none when the record covers none of
them or this device's answer of every one of them was taken.
It is display data: the shard owner that takes the answer refines the node's last miss with it (when the wake reached the
device on its own clock, `its receive time - (answered_at - received_at)`, how long after it was sent, and the app's
outcome; a miss of an epoch the record covers and holds no push of becomes `not_delivered`), and it never changes what
counts. An older node ignores the field.

A linked node is woken by Firebase Cloud Messaging when the device has a push token, else by polling. Either
way the device also gets a periodic BackgroundFetch wake with a 30-minute minimum interval; after its answer a wake also does the device
layer's upkeep (the lease refresh and the key rotation, [The device check](#the-device-check)). On Android it survives the
system ending the app's process (`stopOnTerminate = false`, headless mode) but not a restart (`startOnBoot = false`;
opening the app configures it again), and polling adds a precise one-shot wake about 2 minutes before the ping slot; an
app the user swiped away from the recent apps, or not opened since the device last started, answers no push and no
wake until it is opened ([One wallet, one node, one device](#the-node-tab)). Android also gets one backup wake in every
epoch (`qnet-epoch-backup`, a one-shot alarm the system delivers in its battery saving too, headless): 1,800 blocks
(30 minutes) before the epoch's closing gap, armed by a round that counted an epoch (or found it counted) for the next
epoch, and by a failure for the epoch read while that point is still ahead. It answers by itself only while that epoch
is not counted here, with a block of that epoch and before its commit; a counted epoch's holds keep it silent, so it
costs no request, it carries nothing from one epoch to another, and a refusal for good or a closed epoch arms none.
After an answer only a polling device asks for its next ping time (`/light-node/next-ping`); a pushed one is woken.
A polling device asks `/light-node/pending-challenge` for its challenge from 300 s before its ping time to 180 s after,
and signs that poll with the ping key (`ts`, now, and `sig` over `q1337|light_poll:{N}:{ts}`), so the node counts the
challenge as fetched by this device; with no ping key here, or a signing that fails, the poll goes unsigned and is
answered alike. The same code signs on iOS and Android, each through its native ML-DSA module.
A launch the system made in the background (iOS starts the app for a push or a fetch) reads no node status: the push
or the fetch handler answers and does the device upkeep, and the status is read at the first return to the app. On
iOS the wake is a
`BGAppRefreshTask` (`com.transistorsoft.fetch`, declared in `Info.plist` and handed to the library in
`AppDelegate`): the system picks the time, never sooner than that minimum, never wakes an app the user
force-quit, and offers no precise one-shot wake; every return to the app configures the wake again, so a request for
it is always pending within the epoch. The Node tab's Background row says whether Background App Refresh is on
([Background priority](#background-priority-on-android-and-ios)); it is read again whenever the app returns. The FCM
background handler and the
BackgroundFetch headless task (Android) are registered at top level in `index.js`, so pushes and wakes
that reach a killed app are not lost. Opening the app and returning to it are wakes too. A refreshed FCM
token is sent to the node's shard owners in rank order, then to the other genesis nodes; never to another node
(`PushService.js`). A token that changed while the app was closed, or within the hour after the binding, goes out
from the next wake of any kind (a push, a background fetch, a return to the app), signed by the ping key, within
that wake's deadline. Firebase Cloud Messaging and polling are the only wake channels.

Two paths prove liveness:

- **Push challenge.** The node pushes a challenge (or the epoch's anchor); the app signs it with the keychain-held
  delegation key and POSTs a JSON body to `/api/v1/light-node/ping-response` carrying `node_id`, the challenge,
  the signature (`ping_hw2:` with the device signature for a node that holds this device's key and two genesis
  nodes that serve it, else `ping_dilithium:`), the ping public key, the delegation certificate and the
  wallet public key as `identity_pubkey`. The chain holds only a hash of a light node's identity key,
  so the node admits the presented key only when it hashes to that commitment (or, on a registration
  row without one, derives the registered wallet address) and verifies the delegation under it. The route
  takes POST with a 64 KB body limit because each enveloped ML-DSA-65 signature embeds its own
  message, so the response is far larger than a query string will carry. If the keychain is
  unavailable the ping window is missed and retried in the next window. The answer is capped at 8
  seconds, counted after the key read and the signing. A challenge stays answerable until the shard's
  commit window opens, so an answer minutes late still counts for the epoch it was pushed in; one past that
  point counts for nothing. A refused or late one falls back to a pull self-attestation, which answers nothing
  inside the closing gap (below).
- **Pull self-attestation.** On any wakeup the app builds the challenge `selfattest:{height-2}:{hash}`
  from the `previous_hash` of block `height-1`, deduplicated per 14,400-block epoch, and submits it
  through the same ping-response endpoint to the node's three shard owners in rank order (the genesis
  node at index `u64_le(blake3(node_id)[0..8]) mod 5` and the next two around the ring, derived on the
  device as the chain derives them), then to the node that answered the height read if none of them
  accepts it. This proves same-epoch liveness without depending on push
  delivery. Apart from the holds below, it is skipped only on a definitive `onChainRegistered === false`, which is
  asked only until an owner took an answer of this binding: after that a round reads the height and one block only.
  A height read refused by the node's rate limit (an HTTP 200 `{success: false, retry_after_seconds}`, or a 429), or a
  reply with no height, is a failure that may pass like any other: the round sets its retry at the wait the limit
  names and records why in the hold (`reason`: `rate_limited`, `network`, `no_height`, `stale` or the owner's refusal),
  never ending with nothing set; a rate-limited block read does the same.
  The anchor is never a block of the epoch before (`max(height - 2, the epoch's first block)`).
  An answer is signed once and posted to the owners in rank order, the next one started 3 seconds after the one
  before while that one has not answered, or at once when it failed; the first owner that takes it ends the round, so
  an owner that does not answer costs a push about 3 seconds, not the 6 to 8 of a request's cap. Once a try of the run
  failed, the next owner is asked 4 seconds after the one before (or when it failed): less load on owners that are
  slow, and every owner still reached within one wake, the same on Android and iOS.
  An owner that sheds load answers 503 with a `Retry-After` header: a rate limit, its wait kept as below.
  What a round leaves behind (`PushService.readHold`), each kind for at most 2 hours:
  - **counted**: after a self-attestation, or a wake that finds the epoch already attested, nothing until the epoch
    can have ended (from block 1,339,200, where blocks are never stamped ahead of the clock). A pushed ping that was
    answered sets no hold, so the next wake still runs one self-attestation round for the epoch.
  - **retry**: a failure that may pass (no connection, a timeout, a server error, a rate limit, a stale anchor, every
    owner refusing while one could not be reached) is tried again 1, 2 and 4 minutes later, each wait up to a fifth
    shorter, then every 2.5 to 5 minutes (drawn per device and per try, so devices that failed together do not return
    together), never sooner than a rate limit asks, until the epoch is counted, and only before its commit: the last
    try comes 10 seconds before the closing gap at the latest (at one block a second from the height read), and none is
    set past it. A rate limit that asks for longer than that is cut to a time drawn per device in the 5 minutes before
    the last try: an answer of the epoch belongs to it. After 16 failed tries in a run no wake is set for the next one;
    the network's pushes, the epoch's backup wake, the periodic fetch and an open of the app still answer, so a long
    outage of the owners is not met by every device's alarm. There is no longer a back-off of 30 minutes to 2 hours (a
    hold an older build wrote is void).
  - **refused**: every owner answered and refused (not registered, unbound, the key or the device refused), or no
    ping key is here: no blind retry; the next push answers, and an open of the app once a minute has passed.
  Every ping and every answer belongs to its own epoch. The shard's commit opens 150 blocks before the epoch's end,
  and an answer after it counts for nothing. From 155 blocks before the end (the commit window and 5 blocks for the
  answer's way) to the epoch's end the app answers nothing, whatever wakes it: a fresh read, a pushed anchor (its height
  plus the time since the push came) or an owner's word that the commit is closed (`epoch_closed`, or `epoch_closing`
  from an older node, whose `next_epoch_height` is not read) ends the round with nothing counted, no other owner asked,
  and nothing set, held or moved for the next epoch, which is answered only by its own pushes and the app's own answers
  inside it (a push, a background fetch, an open). A hold an older build wrote to answer after the next epoch started is
  void. The counted hold a push leaves ends by the later of the push's two times (when the network sent it and when this
  device took it), so a push held on its way holds no answer of the next epoch back.
  The next try's time gets a wake where the system has one: a timer while the app is in front (set again on each
  return), and on Android a one-shot `qnet-answer-retry` alarm (headless, as the periodic fetch; the answer rule still
  decides); iOS has none, so the next push, background fetch or open answers then. A push answered meanwhile drops it.
  Each wake sets one deadline for everything it sends, 25 seconds for a background fetch and 22 for a
  push, inside the roughly 30 and 25 seconds iOS gives them; a self-attestation round also stays within
  20 seconds, each request capped at 6, and wakes that arrive together share one round per node. Every ping answer (a self-attest round, a
  pushed or a polled challenge) goes out one at a time per node, each within its caller's own deadline, and a
  forced round runs again only behind a round that did not attest.

Either path counts the same: **one** recorded attestation makes the node eligible for that epoch's
reward bitmap. The two paths also carry different guarantees over a long absence. The node that owns
the device's shard wakes it while it has attested within the last 3 epochs, or while it is inside that
same span from registration. Past that span the shard owner stops waking it, and pull self-attestation
is what brings it back: the first wakeup after a long offline stretch attests for the current epoch and
restores the device to the wake roster. A device that fails 5 consecutive pings, or whose registration
is marked inactive, likewise returns through self-attestation. The periodic wake is therefore what
keeps a device that misses pushes eligible; an iPhone the user force-quit, one with Background App
Refresh off for the app, an Android phone whose app was swiped away, and any device restarted since the app was last
opened are proven only when the app is opened. See
[economics](../economics/overview.md).

## Background priority on Android and iOS

The light node answers in the background with no notification: the pushes are silent data messages, and the app asks
for no notification permission on either platform. Each system decides how much an app may run in the background, and
what it allows differs; the app reads it (`src/services/BackgroundPriority.js`) and shows it; it never leaves the
device. The Node tab of a node that runs on this device has one row,
"Background: Unrestricted" or "Restricted", the same text on every phone and tablet, and while it is restricted and the
user can change it, one button, "Open background settings", to the system page where it is changed. Nothing is asked
of the user beyond that, and nothing counts by it.

- **Android** (native module `QNetBackground`, `BackgroundPriority.kt`, read with no permission): unrestricted when the
  user exempted QNet Wallet from battery optimization (`PowerManager.isIgnoringBatteryOptimizations`) and did not
  restrict its background activity (`ActivityManager.isBackgroundRestricted`, Android 9+), and its app standby bucket
  (`UsageStatsManager.getAppStandbyBucket`, Android 9+) is not `rare`, `restricted` or `never`. Otherwise restricted:
  the default "optimized" battery use defers the app's periodic fetch and alarms in the system's battery saving, and a
  rare or restricted bucket limits its jobs and its high-priority data pushes. The button opens the app's own page in
  the system settings (`Settings.ACTION_APPLICATION_DETAILS_SETTINGS`; its battery use is set there, and Unrestricted
  exempts the app), else the list of battery optimizations (`ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`). Neither
  needs a permission; the direct exemption request (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) would need one that
  store policy keeps for a few kinds of app, and it is not used. What the system gives an app at any setting: high
  priority data pushes, delivered in its battery saving too; the periodic fetch (30-minute minimum); the one-shot alarms
  of the next answer's try and of the epoch's backup, delivered in battery saving at most about every 9 to 15 minutes.
- **iOS** (`UIApplication.backgroundRefreshStatus`, through the background-fetch library's status): unrestricted when
  Background App Refresh is on for the app, restricted when the user turned it off (`denied`; the button opens the
  app's page in Settings) or a profile or a parental control did (`restricted`: the row only, the user cannot change
  it there). Low Power Mode turns Background App Refresh off for every app while it lasts. What iOS gives an app: a
  silent push at background priority, which the system may hold back or deliver late, and a background refresh task
  (`BGAppRefreshTask`, `com.transistorsoft.fetch`) at a time the system picks, never sooner than 30 minutes, requested
  again at every return to the app; no precise alarm, and nothing at all for an app the user closed from the app
  switcher. So an iPhone or iPad answers on its pushes, its refresh tasks, and every launch and return to the app.

The rule that decides whether the node may answer is the same on both platforms (`AnswerGate.mayAnswer`, asked by every
path, the backup wake included): the app runs, opened since the device started, and not swiped away since.

What the network counts as this device's miss is the network's rule, read here as display data. A push the provider
accepted for the device counts as having reached it, on iOS and Android alike, even when the device's system held it
back: the network did its part (the owner's decision of 05.10, for the rule that stops waking a node after two missed
epochs, which counts only such proven device misses; the network's own misses, `not_sent` and `not_committed`, never
count). Open owner decision, for when the device layer is turned on (`LIGHT_DEVICE_SERVE_EPOCH`, unset on the live
network and the sandbox): a device record that is paused, past its lease or overdue for its key rotation is not woken
then, which is a second rule beside the two missed epochs.

## Requests from the open app

At ten million devices a million apps may be open at once, so the app asks the network for what is on screen as
seldom as the screen allows (`src/utils/requestPace.js`), and nothing while it is not in front:

- **Node tab**: the statuses (the light node's owners, a server node, aiqnet.io's record) when the tab opens, on
  pull-to-refresh, on every return to the app and after Use this device, and in between every 5 minutes. The node
  balance once per epoch and node (it changes only when an epoch settles), and at once on pull-to-refresh and after a
  move. The epoch clock from one height read, with each of those refreshes, counted on at one block a second in
  between (for at most 10 minutes past the read).
- **Assets**: the balances when the tab opens, then every 60 seconds while the address socket is open (its events ask
  for a read as soon as this wallet's balance changes) and every 30 seconds while it is not.
- **History**: everything (the explorer too) when the tab opens, on pull-to-refresh and on a return to the app; in
  between one genesis node's newest rows, every 60 seconds while the address socket is open and every 30 seconds while
  it is not.
- **Address socket** (`/ws/subscribe?channels=account:{address}`): this wallet's own address only, never the feed of
  every block. After a drop the next try waits a time drawn evenly between zero and 5 seconds doubled with each failure
  in a row, 5 minutes at most; after a refusal (it closed before it opened: the node's limit of connections, or no
  network) 5 minutes plus up to 5 more drawn evenly. It closes when the app goes to the background and opens again on
  the return, not before the wait it had.

## Platforms and build

- React Native 0.81.4 with React 19.1.0 on Hermes, `newArchEnabled=false`, Node ≥ 20.
  `crypto.subtle` comes from `react-native-quick-crypto`, installed before any other module.
- Version 1.3.0 (20) on both platforms. Android: application id `io.aiqnet.wallet`, minSdk 24, compileSdk and
  targetSdk 36, NDK 27.1.12297006, Kotlin 2.1.20; release builds enable R8 minification and resource shrinking.
  iOS: bundle id `com.qnetmobile`, iPhone and iPad (`TARGETED_DEVICE_FAMILY = "1,2"`), not offered on Mac or
  Vision Pro; deployment target 15.6 for the app target.
- ML-DSA-65 is native: PQClean reference C compiled through the NDK by CMake for `armeabi-v7a`,
  `arm64-v8a`, `x86` and `x86_64` (a release build ships the two ARM ones), exposed through a Kotlin JNI module on Android and an Objective-C
  module on iOS with byte-identical return shapes. The library load is fail-soft: a failed
  `System.loadLibrary` marks the module unavailable and every method rejects with
  `DILITHIUM_NATIVE_UNAVAILABLE` instead of crashing.
- Android has one package with the whole app, `io.aiqnet.wallet` (`./gradlew bundleRelease`, an AAB for Google
  Play; ARM only, every 64-bit library 16 KB-aligned). aiqnet.io offers the same Play-signed file (Play Console →
  App bundle explorer → the signed universal APK), with the same signature and the same code as the copy from
  Google Play; the app never updates itself and has no update check. The code does not branch on the store, the
  signature or the platform (`__tests__/BuildParity.test.js`), but the node's device check does: it needs Google
  Play's licence for the install, which a copy from Google Play has. A copy from aiqnet.io runs the whole wallet;
  to run the node it must be licensed too, which Google Play's licence dialog (shown on `device_unlicensed`)
  arranges once the app is listed on Google Play for that user; until then that device's node is refused and the
  Node tab says to install QNet Wallet from Google Play. A build signed with the upload key (a local test) runs the
  whole app too; the network marks its device check as a test build, which only a testnet node accepts.
- The old package `com.qnetmobile`, which earlier site APKs carried, gets one last update for the installs that
  still have it: `./gradlew assembleRelease -PqnetLegacyMove` builds the same app as `com.qnetmobile` with
  `BuildConfig.QNET_LEGACY_MOVE` and its JavaScript bundled with `metro.legacy.config.js`, which takes
  `src/config/legacy.move.js` (read through the native module `QNetAppBuild`) and `src/i18n/overlay.legacy.js` in place
  of the files every other build uses; so the move notice, its texts and its link to the site's download page exist in
  that build only, and the bundle scan refuses them in the io.aiqnet.wallet and iOS bundles. It
  keeps the wallet, runs no node (a node it ran stops at its first launch or wake, a push or a background fetch of a
  closed app included) and shows at every launch the notice to install
  QNet Wallet and restore the wallet there with its recovery phrase: from Google Play to run the node (a copy from
  aiqnet.io runs the wallet, and the node only once Google Play licenses it, above); its Node tab says the node runs
  in the new app. It is signed with the key of the old site APKs and published once as the GitHub
  release `wallet-1.3.0-20` with the asset `QNet-Wallet.apk`, where the update check of the 1.1.7 site APK finds it;
  the owner creates that release. It is never offered on Google Play or aiqnet.io. Both packages are clients of the
  Firebase project `qnet-wallet`.
  The owner creates the release `wallet-1.3.0-20` only once three things hold, checked right before: the
  io.aiqnet.wallet listing is public (https://play.google.com/store/apps/details?id=io.aiqnet.wallet answers 200,
  not 404); `WALLET_APK_URL` is set and https://aiqnet.io/wallet shows a download link that downloads; and the live
  /wallet page explains the move from the older Android build. Otherwise both buttons of the move notice lead nowhere,
  and if the Play listing cannot go public, the release waits. The 1.1.7 site APK offers, as an update installed over
  itself, any GitHub release that is not a draft or prerelease, whose tag matches `wallet-<versionName>-<versionCode>`
  and which carries an asset named `QNet-Wallet.apk`, with a code above 18: only this move build may ever use that tag
  pattern and that asset name. The Play-signed io.aiqnet.wallet file `WALLET_APK_URL` offers is served from aiqnet.io,
  or from a GitHub release whose tag does not match `wallet-<x.y.z>-<n>` (for example `app-1.3.0-20`) and whose asset
  is not named `QNet-Wallet.apk`; `WALLET_APK_URL` names that fixed release (`.../releases/download/<tag>/<asset>`),
  never `.../releases/latest/download/...`, which could resolve to this old-key build.
- Solana is devnet only and the app shows no fiat value on any build (`src/config/nodes.js`).
- Settings, the terms screen, the link sheet and "Use this device" link to the privacy policy; Settings and the terms
  screen also to the terms of use, and Settings to the support page on aiqnet.io.
- A release build waits for two gates (`android/app/build.gradle`): the light-client pin (`scripts/release-check.js`)
  and the bundle scan (`scripts/bundle-check.js`): Metro builds the release bundle and the scan refuses one that
  carries a removed flow, or, for iOS, any of Android's own texts; the iOS workflow scans both platforms. The static
  half over the sources and the eleven translation tables runs in every test run (`__tests__/BundleContent.test.js`):
  no text in any language speaks of activation, burning, rewards or mining, or names a platform or a phone.
- Release signing reads `keystore.properties`, falling back to the `QNET_KEYSTORE_PASSWORD` and
  `QNET_KEY_PASSWORD` environment variables; both are operator-supplied. Keystores and signing
  properties are never committed.
- Cross-language jest pins assert that the JavaScript registry-root fold and the SMT account-proof
  fold reproduce roots emitted by the Rust node, and that the shard-owner derivation matches shards
  the node's `light_shard_of` produced, importing the shipped modules rather than copies.
- Node transport is HTTPS only. `src/config/nodes.js` names the genesis nodes by their public names
  (`node1.aiqnet.io` … `node5.aiqnet.io`, a TLS terminator per node — see the operator guide) and keeps
  their addresses only as the key for `publicNodeUrl`, which maps a genesis address in a node's answer to
  its name. A push names no address to answer at; the app answers the node's shard owners by name. A
  discovered node is used only at an `https://` DNS name on the default port (`canonicalNodeUrl`). iOS
  needs this, since App Transport Security refuses cleartext to a public host; the Android release
  build's network security config refuses cleartext and trusts only the system certificate authorities
  (a debug build also allows `localhost`, `127.0.0.1` and `10.0.2.2` for the Metro bundler). The
  Android manifest sets `allowBackup="false"` with backup and data-extraction rules that exclude the
  app's data.
- Android screen protection (`SecurityModule.kt`): screens that show or take a secret set `FLAG_SECURE`; they and
  the screens whose taps move value or approve a request (the send form and its review, a site's sheet, a QNet Link
  request) hide other apps' overlays (API 31+), hide the views from accessibility services that are not assistive
  tools (API 34+), and drop every touch another app's window obscures, also one that covers only part of the window
  (`FLAG_WINDOW_IS_PARTIALLY_OBSCURED`, API 29+), with a short notice. Below API 33, where the recents screen keeps a
  snapshot of whatever was shown, the window is secure on its way to the background; from API 33 the recents
  snapshot is off. Enabled accessibility services that did not come with the system are named, label and package,
  at unlock (the password and the screen-lock lock screens alike), before a recovery phrase and on every
  confirmation, on the system prompt itself: its subtitle names them and its description holds a send's recipient,
  which the prompt draws in full (its title is one line), for the screen-lock prompt as for the password wallet's
  biometric prompt.
- The light node's device key, native module `QNetDeviceAttest` (`QNetDeviceAttestModule.m`,
  `DeviceAttestModule.kt` with `NodeDeviceKey.kt`; JS `src/services/NodeDeviceKey.js`): on iOS an App Attest key in
  the Secure Enclave, Apple's attestation of it, its assertions and a DeviceCheck token; on Android an EC P-256
  Keystore key (StrongBox, else the TEE) made with an attestation challenge, the nine-flag device report and a Google
  Play classic integrity token with Google Play's licence and integrity dialogs. One key per install; which key is
  current, and one pending until the node takes it, is kept in the Keychain (after first unlock, this device only),
  and erasing the app's data deletes it. The formats are in [light node messages](../protocols/light-node-messages.md)
  section 5. No system version is required: the genesis nodes judge the evidence. Android's texts that name Google
  Play live in `src/i18n/overlay.android.js`, which no iOS build carries. How the Node tab, the link sheet and the
  wakes use the key: [The device check](#the-device-check).
- iOS: `ITSAppUsesNonExemptEncryption` is `YES` (standard algorithms in the app's own native module and its bundled
  crypto libraries, as `store-listing/README.md` lists them),
  `RCTNewArchEnabled` matches Android (`false`), the one background task is `com.transistorsoft.fetch`, and
  `PrivacyInfo.xcprivacy` declares four data types, each for app functionality, linked and not for tracking: a
  device ID (the push token and the device check, only while a node is linked), a user ID (the QNet and Solana
  addresses), other financial info (the transactions the user signs) and other data types (the device's platform and
  model name sent with the binding, only while a node is linked), as `store-listing/README.md` answers them.
  `.github/workflows/ios-build.yml` runs the dependency audit, the unit tests, the bundle scan and the light-client
  pin check, then compiles the simulator build on macOS, on every change.
- iOS pods: each macOS job of that workflow runs `pod install` after `npm ci` and the patches, compares the resolved
  `ios/Podfile.lock` with the committed one (a difference is a warning, with the diff in the job summary) and keeps
  the resolved lock as a run artifact (`ios-podfile-lock`, and `testflight-podfile-lock` for a TestFlight build). The
  committed lock is replaced by that artifact, never edited by hand.
- TestFlight: a manual run of the workflow (`workflow_dispatch`, with its `testflight` input, on by default) runs the
  `testflight` job once the checks pass. It archives the `QNetMobile` scheme in Release for bundle id
  `com.qnetmobile`, signed automatically for team `33H36C42XS` (`xcodebuild -allowProvisioningUpdates` with the App
  Store Connect API key of the repository secrets `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_KEY_P8`, the `.p8` text),
  exports it with the method `app-store-connect` and uploads it with `xcrun altool --upload-app` under the same key.
  The build number is the project's `CURRENT_PROJECT_VERSION`, which the export keeps, so each upload needs a value
  App Store Connect has not received for that version. The key file exists only for the job and is deleted at its
  end.
- Store listings, the review notes and the data-declaration answers for both stores live in
  `store-listing/`; the privacy policy, terms and support pages the stores link to are at
  `aiqnet.io/privacy`, `/terms` and `/support`.

## Related documents

- [Consensus](../architecture/consensus.md) — checkpoints, committees, quorum certificates.
- [Cryptography](../architecture/cryptography.md) — ML-DSA-65, hashes, address format.
- [State](../architecture/state.md) — account leaf schema and state commitment.
- [RPC API](../developers/rpc-api.md) — the endpoints the app calls.
- [Browser wallet](browser-wallet.md) — the extension that shares the same derivation.
