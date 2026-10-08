# Store listing

What the two stores are told about QNet Wallet, in one place, so the answers stay consistent with each
other and with the code. The privacy policy and the terms are not kept here: the canonical texts are
the pages the stores link to.

| Item | Where |
|---|---|
| Google Play listing text | `fastlane/metadata/android/en-US/` (title, short and full description, changelogs); `google-play-description.txt` holds the console fields around it |
| App Store listing text and review notes | `app-store-listing.txt` |
| Privacy policy | https://aiqnet.io/privacy?from=app (`applications/qnet-explorer/frontend/src/app/privacy/page.tsx`) |
| Terms of use | https://aiqnet.io/terms?from=app |
| Support page | https://aiqnet.io/support?from=app · support@aiqnet.io |
| Icon and feature graphic | `app-icon-512.png`, `feature-graphic.png` |

## Data declarations

Both stores ask what the app collects. The truthful answer follows from what the code sends off the
device and what is kept there — "collected" in both stores' vocabulary means transmitted to servers the
publisher operates and retained, not merely shown on screen. The app is the same on iPhone, iPad, Android
phones and Android tablets, so the answers are the same too.

What leaves the device:

- **Transactions the user signs** — transfers, token calls and moves of a node balance on QNet, and SOL and Solana
  token transfers from the wallet's Solana address: public blockchain data by design. The app submits no node
  registration; a registration the website submits carries the wallet's consent.
- **Addresses in read queries** — the QNet address to the genesis nodes and the explorer, automatically while the app
  is open (balances every 15 s, history), and to aiqnet.io for the state of the wallet's node there while the Node tab
  is open and the network lists no node for the wallet (every 30 s; the app keeps only that state and the node type),
  and once before the QNet Link sheet offers a node consent. Every request that names a QNet address goes only to servers the publisher
  operates: the five genesis nodes (`src/services/NodePool.js`) and the explorer (`EXPLORER_API`, `src/config/nodes.js`);
  a third-party node that two genesis nodes list serves only the committee-certified checkpoints the wallet verifies
  proofs against, which name no address.
- **Solana RPC** — the Solana address goes to public Solana devnet endpoints for balances, and a Solana transfer the
  user confirms goes there to be sent and followed; so do the addresses it pays and the token accounts it reads. These
  endpoints are third parties with no contract with the publisher.
- **Requests from aiqnet.io (QNet Link)** — only when the user opens an `https://link.aiqnet.io/l` link and confirms on
  the app's own sheet: one answer, end-to-end encrypted to the page that asked, through the publisher's relay (which
  keeps the ciphertext in memory for at most ten minutes and sees the IP address for rate limiting only). The answer
  carries the QNet and Solana addresses (`connect`); the node id, the wallet's public key and its consent signature
  (`link`); or the node id and the moved amount and transaction (`claim`) (`src/services/QNetLink.js`). Nothing about
  the device goes through aiqnet.io.
- **Light node binding, only while a node is linked to this device** — sent to the node's shard owners among the
  genesis nodes: the node id, the wallet address and public key, the device's answer key, the signed binding, the push
  channel (the FCM push token), and the device check: the public part of a key the app creates in the device's secure
  hardware, the platform's attestation of that key, and a one-time token of the system's device check (Apple
  DeviceCheck, Google Play Integrity) that the genesis nodes pass only to the publisher's device service, which asks
  Apple or Google and keeps a small per-device marker there so that one device runs one node. Each answer of the node
  is signed with that key. With the binding go the device's platform and model name (`src/services/DeviceModel.js`:
  on an iPhone or iPad its model, on Android the maker and the model the system reports; never the device name the
  user set, a serial number, IMEI or other identifier), which the genesis nodes keep with the binding
  and show in the node's public status, so that the website's Device tab names the linked device; the next binding
  replaces it. Unlinking the device ends the binding, the device record, the model and the push token: a request
  from the website's Device tab that the app confirms on its own sheet, where the device's node key signs the unbind.
- **Google Play's environment verdict (Android, only while a node is linked)** — the Play Integrity token is requested
  with Google's app-access-risk verdict ("environment details"). For it, Google's Play Integrity API collects app
  activity information to tell whether apps are running that could view the screen, show themselves over other apps
  or control the device, and whether other apps are installed (it names no app), and returns the verdict with the
  token to the publisher's device service. The device service decides only on whether that verdict is present, which Google gives only on phones, tablets and foldables, to tell such a device from others. It
  keeps Google's whole decoded answer, the verdict's labels included, in its sealed evidence for review of an appeal:
  7 days for an accepted link or rotation, 90 days for a refused, suspect or paused case
  (`development/qnet-device-oracle/src/evidence.rs`).
- **Firebase** — the app takes a push token only when a node is linked to this device (`firebase.json` turns automatic
  token issue off), and deletes it when the node stops here.
- **The in-app browser** — pages the user opens are fetched by the system WebView straight from those sites; the app
  sends nothing about them to the publisher. A site sees the wallet's QNet and Solana addresses only after the user
  connects it on the app's own sheet, and gets a message signature, a QNC or token send or a contract call only after
  the user confirms it there (`src/browser/`). Its cookies and site data start empty in each session; the list of recent pages stays on the device.
- **GitHub** — the SOL token logo; no address, the IP address only.
- **The camera (the scan icon in the recipient field of a Send screen)** — only after the user taps that icon and
  allows the camera. Frames are decoded on the device and never stored or sent; what is read goes into the Send form and
  nowhere else: a QNet address on the QNet Send screen, a Solana address or payment request (its recipient, token and
  amount) on the Solana one. On iOS the system decodes (AVFoundation); on Android an open-source QR decoder
  bundled in the app, which makes no network connection. The scanner sends nothing, not even diagnostics, on either
  platform.

Therefore:

**Google Play — Data safety**

| Question | Answer |
|---|---|
| Does the app collect or share user data? | Yes. |
| Personal info → User IDs | Collected and **shared**: the QNet and Solana addresses; the Solana address reaches public Solana RPC endpoints automatically. Purpose: App functionality. Required. |
| Financial info → Purchase history (and Other financial info) | Collected: the transactions the user signs reach the nodes and stay on the public chain. Not shared (user-initiated). Purpose: App functionality. Required. |
| Device or other IDs | Collected **only while a node is linked**: the push token and Firebase installation ID, the device key's public part and the device-check token. **Optional.** **Not shared**: the genesis nodes and the device service are the publisher's; Google and Apple act as service providers. Purposes: App functionality; Fraud prevention, security, and compliance. |
| App activity → Installed apps | Collected **only while a node is linked, on Android**: Google Play's app-access-risk verdict, which says whether apps are running that could view the screen, show themselves over other apps or control the device, and whether other apps are installed (it names no app). **Not processed ephemerally**: the device service decides only on whether the verdict is present, and keeps it with its labels, sealed, 7 days (up to 90 days for a refused, suspect or paused case) for review of an appeal. **Optional.** **Not shared** (Google acts as a service provider). Purpose: Fraud prevention, security, and compliance. |
| App activity → App interactions | Collected **only while a node is linked**: with each answer of the node, whether the app could answer the network's wake-ups of the epochs before (answered, closed by a swipe, not opened since the device restarted), so the node's owner sees why an epoch was missed. The genesis nodes keep only the node's latest miss and latest answer, each replaced by the next. **Not processed ephemerally.** **Optional.** **Not shared.** Purpose: App functionality. |
| App info and performance → Diagnostics | Collected **only while a node is linked**: with the same answers, when each wake-up was sent, reached the device and was answered, kept the same way. **Not processed ephemerally.** **Optional.** **Not shared.** Purpose: App functionality. |
| Other Personal info / Location / Contacts / Messages / Photos / Files / Audio / Calendar / Health / Web browsing / App activity (other than above) / App info and performance (other than above) | Not collected. No analytics or crash SDK; FCM delivery metrics are off. The in-app browser keeps its recent pages on the device only. |
| Data encrypted in transit | Yes — every connection from the device is HTTPS. |
| Can users request deletion | **Yes**: unlinking the device (requested on the website's Device tab, confirmed on the app's own sheet) deletes the push token and the device's model and ends the device record on every genesis node; support deletes the device service's record on request. Public chain records cannot be deleted; the privacy policy says so. No account, so no account-deletion URL. |
| Independent security review | No. |

The device's platform and model name sent with the binding (only while a node is linked) carry no identifier: they
name the kind of device, not the device or its user, and are kept with the binding and shown in the node's public
status, as the privacy policy says. Play's form has no data type for them, so no row above declares them: they are not
"Device or other IDs" (that type is for identifiers of one device, and a model name is shared by every device of that
model) and not "App info and performance" (they are not crash logs, diagnostics or performance data). The privacy
policy names them, and the App Store table declares them as Other Data Types.

**App Store — App Privacy** (`ios/QNetMobile/PrivacyInfo.xcprivacy` declares the same)

| Data type | Linked to the user | Used for tracking | Purpose |
|---|---|---|---|
| Identifiers → User ID (QNet and Solana addresses) | Yes | No | App Functionality |
| Identifiers → Device ID (push token and the device check, only while a node is linked) | Yes | No | App Functionality |
| Financial Info → Other Financial Info (transactions the user signs) | Yes | No | App Functionality |
| Other Data → Other Data Types (the device's platform and model name, only while a node is linked) | Yes | No | App Functionality |
| Usage Data → Product Interaction (whether the app could answer the node's wake-ups, only while a node is linked) | Yes | No | App Functionality |
| Diagnostics → Other Diagnostic Data (when a wake-up was sent, reached the device and was answered, only while a node is linked) | Yes | No | App Functionality |

"Linked: Yes" — the push token, the device check and the model name are kept with the node id and the wallet address,
and the node id derives from the address. The model name is Other Data Types: it is not Device ID (it identifies no
device) and not Diagnostics (it is shown to the owner, not used to measure the app). The answers' report of the
wake-ups is Product Interaction (what the app could do with them) and Other Diagnostic Data (their times); it is kept
with the node and shown to its owner. Everything else: not collected. `NSPrivacyTracking` is false; no advertising SDK, no
analytics. App Attest and DeviceCheck need no required-reason entry and ask the user nothing.

## Export compliance (App Store Connect)

- `ITSAppUsesNonExemptEncryption` = NO (`ios/QNetMobile/Info.plist`). App Store Connect's encryption questionnaire
  (App Information > App Encryption Documentation), answered "standard encryption algorithms" and "not available in
  France", requires no documentation and tells the developer to declare that in Info.plist. A YES build is refused at
  upload ("Invalid Export Compliance Code") unless it carries the `ITSEncryptionExportComplianceCode` of approved
  documentation.
- France is left out of the App Store availability until the French encryption declaration to ANSSI is made. Then the
  declaration goes into App Store Connect as the app's encryption documentation, Info.plist gets YES with the code
  Apple issues, and France is added.
- The app implements standard algorithms outside Apple's frameworks: ML-DSA-65 (FIPS 204) and SHA-3/SHAKE in its own
  native module; PBKDF2-SHA256 and AES-256-GCM for keys at rest through its bundled native crypto library; in its
  JavaScript crypto libraries X25519 with HKDF-SHA256 and AES-256-GCM for the end-to-end encrypted answers to
  aiqnet.io's requests, and Ed25519 for Solana transfers; the device key of App Attest is Apple's own. In Apple's table that is "industry standard algorithm, not provided within the Apple operating system":
  no CCATS; the French encryption declaration only for the App Store in France.
- The same classification (mass-market encryption, License Exception ENC) carries a US obligation: an annual
  self-classification report to BIS and the ENC Encryption Request Coordinator by 1 February for the previous year.
  Filing it is the publisher's task, not the app's.

## Google Play — Financial features declaration

Declared: **Cryptocurrency wallet** only. A node balance is QNC, a fungible coin, not a tokenized digital asset (NFT);
the app sells, trades and awards no NFTs. Declaring the NFT category as well disables the non-custodial exemption and
demands a crypto licence in every targeted jurisdiction. No build sells anything, and no screen of the app offers a
node, a burn or a code or names a price: a light node is registered on aiqnet.io in a browser or with the QNet browser
extension, a super node with the extension only, and the app only confirms its own wallet's light node on sheets that a
verified link opens. Its SOL and 1DEV sends are ordinary wallet transfers to any address the
user enters or scans, the website's one-time payment address included ("Payments" below). There is no purchase or
payment feature to declare.

Documentation step (all countries targeted): Google lists Bahrain, Canada, the EU, Israel, Japan, the Philippines,
South Africa, South Korea, the UAE, the UK and the US, and in each the app is declared **a non-custodial software
wallet** — keys stay on the device; no exchange, no fiat on-ramp, no custody, no lending. The IARC questionnaire
answers "convertible cryptocurrency rewards: yes" for the node balance. The policy's prohibition on device mining is
not engaged: the device does no hashing and no proof-of-work; it answers status requests with one ML-DSA-65
signature each; blocks are produced by server nodes.

## Google Play — build and package

One Android package, `io.aiqnet.wallet`, with the whole app: Google Play distributes it, and aiqnet.io offers the same
Play-signed file (Play Console → App bundle explorer → the signed universal APK), so both copies are one app with one
signature; the app never updates itself. Running the node needs Google Play's licence for the install: the copy from
aiqnet.io runs the wallet, and its node only once the user accepts Google Play's licence dialog, which needs the Play
listing to be live for that user; until then the Node tab says to install QNet Wallet from Google Play. `com.qnetmobile` stays reserved by a closed developer account. The old site
APK of that package gets one last update (`-PqnetLegacyMove`, `docs/applications/mobile-wallet.md`): the wallet only,
no node, and a notice to install the new app and restore there with the recovery phrase. Both packages are registered in
the Firebase project `qnet-wallet` (`android/app/google-services.json`).

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

- Play: `cd android && ./gradlew bundleRelease` → `app/build/outputs/bundle/release/app-release.aab`. ARM only
  (`armeabi-v7a`, `arm64-v8a`): Play requires every 64-bit library to be 16 KB-aligned; debug builds keep every ABI for
  emulators. A release build first runs the light-client pin gate and the bundle scan (`scripts/release-check.js`,
  `scripts/bundle-check.js`).
- A build signed with the upload key (a local test) runs the whole app; the network marks its device check as a test
  build, which only a testnet node accepts.
- The public store listings name neither the extension nor the burn, and their URLs open the site with its app marker
  (`?from=app`), where the site shows only the explorer and the policies. The App Review notes (not public) describe
  the five QNet Link sheets and where a node comes from, so review is told of every screen the build has (Guideline
  2.3.1).

**App access** (Play Console; the owner pastes the phrases into the credential fields, never into this repository):

1. *Wallet with a node*: "No account. Open the app, accept the terms, tap 'Import Existing Wallet', paste the phrase,
   tap 'Import Wallet', unlock with the screen lock. Node tab: 'The node runs on another device'. Tap 'Use this
   device' and confirm: status Online, 'Answered this epoch: Yes' followed by the time. Node balance is above 1 QNC: 'Move to wallet' moves
   it.
   The node needs a physical, Play-certified phone or tablet; on an emulator the Node tab says 'This device can't run
   a node.' Test network: QNC has no market value."
2. *Wallet without a node*: "Import the phrase. The Node tab says 'This wallet has no node' with nothing to tap. Node
   registrations are made on the QNet website, outside the app; the app sells nothing."
3. *Website request sheets*: "With the wallet of set 1 (the one with a node), on the same device open
   https://aiqnet.io/node in Chrome. Tap 'QNet Wallet on this phone', then 'Open QNet Wallet', and confirm the sheet
   'Share this wallet's addresses' in the app. Back in Chrome, open the Device tab, tap 'Move the node to another device', then 'Open
   QNet Wallet', and confirm the sheet 'Link this wallet's node to this device'. On the Overview, with a node balance
   of 1 QNC or more, 'Move with QNet Wallet', then 'Open QNet Wallet', opens the sheet 'Move node balance to this
   wallet'. Last, on the Device tab, 'Unlink this device', then 'Open QNet Wallet', opens the sheet 'Unlink this wallet's
   node from this device'; after it the Node tab says 'The node does not run on any device now.'"

Owner note, not pasted: set 3's link, move and unlink steps need `CABINET_PHONE_FLOWS=1` on aiqnet.io when the build is
submitted (`docs/applications/explorer.md`; the deploy default is off). If it is off, paste set 3 with only its first
two sentences, the connect sheet: with the flag off the Device tab and the move say the flow "opens soon". The labels
above are the restructured site's (tabs Overview · Device · History); paste them once that site is live, and replace
the set 3 text already in Play Console at the same time. Check the pasted text against the App access field's length.

## Google Play — where review can object

- **Payments.** No build sells anything or has a burn or a code. The SOL and 1DEV sends are ordinary wallet transfers,
  to any address, that the user reviews and confirms. The website's activation page asks the user to send the
  activation amount in 1DEV, plus the SOL the burn needs, from their own wallet to its one-time payment address. It
  shows payment-request QR codes that this app's Solana scan reads. The app fills in only the recipient, token and
  amount, ignores the request's label and message, and shows the transfer like any other: the amount as an ordinary
  transfer amount, with no price or activation text. Nothing in the app links or steers to that page, and the listing names neither the extension nor the burn.
  Residual risk: review may read that transfer as a payment for the node the app then runs (Play Payments policy;
  Apple 3.1.1). The App Review notes disclose it ("WHERE A NODE COMES FROM"); the owner decides whether to accept this
  risk.
- **Cryptomining.** "We don't allow apps that mine cryptocurrency on devices." The listing says it is not mining: no
  hashing and no proof-of-work, one ML-DSA-65 signature per answer, blocks produced by server nodes.
- **Earning claims.** The listing makes none: any node balance is set by the protocol, not guaranteed, and QNC has no
  market value.
- **Privacy policy inside the app.** The terms screen, Settings, the link sheet and "Use this device" link to
  https://aiqnet.io/privacy?from=app (the site's app view).
- **Accuracy of the listing.** Licences (apps Apache-2.0, node BSL 1.1), the cryptography, the network stage (testnet),
  a QR code shown and a QR scan on the Send screens that takes an address (and on Solana a payment request) into the
  form, 11 languages; screenshots show only what the build has.
- **Prices.** None: the app shows no fiat value on any build while QNet is a test network.
- **Permissions.** INTERNET, ACCESS_NETWORK_STATE, USE_BIOMETRIC, USE_FINGERPRINT, WAKE_LOCK, RECEIVE_BOOT_COMPLETED,
  HIDE_OVERLAY_WINDOWS, CAMERA, the FCM receive permission, and SCHEDULE_EXACT_ALARM with maxSdkVersion 33 from
  react-native-background-fetch. CAMERA is asked for only when the user taps the scan icon on a Send screen,
  and the camera is not a required feature (`android.hardware.camera` `required="false"`). POST_NOTIFICATIONS is
  removed from the merged manifest (`tools:node="remove"`) and never asked for; the app shows no notification.
  The manifest removes RECORD_AUDIO, both location permissions, READ_EXTERNAL_STORAGE and WRITE_EXTERNAL_STORAGE even if
  a library asks for them (the camera library asks for both storage permissions).
- **In-app browser.** It opens any https site the user types; it never opens aiqnet.io's home page, its node,
  activation, wallet and link pages (`/node`, `/activate`, `/wallet`, `/l`), its `/docs`, `/dao`, `/testnet` and
  `/qnet-wallet-extension` pages, on aiqnet.io, www.aiqnet.io and explorer.aiqnet.io, nor any link.aiqnet.io link (it
  shows the explorer instead). Every connection, message signature, QNC or token send and contract call is confirmed on
  the app's own sheet.
- **Target API.** 36.

## App Store — age rating (owner)

The in-app browser opens any website, so the age rating questionnaire must answer **Unrestricted Web Access:
Yes**. Apple then gives the app its highest age rating; check the rating the current questionnaire assigns. Answer
Play's IARC questionnaire the same way where it asks about web access.

## Before submission

- Play Console → the app → Play Integrity API: turn on the app-access-risk verdict ("environment details"). The
  network's device check refuses a licensed Android install whose integrity verdict lacks it (`device_desktop`,
  `docs/protocols/light-node-messages.md` section 9), since its presence is what tells a phone or tablet from other
  devices. Answer Data safety as above in the same release (App activity → Installed apps), and
  keep the privacy policy's device-check section saying the same.
- Screenshots from the current build, the six scenes of `app-store-listing.txt` on iPhone, iPad, Android phones and
  7" and 10" Android tablets. Play rejects a side longer than twice the other. Each screenshot folder under
  `fastlane/metadata/android/en-US/images/` (`phoneScreenshots`, `sevenInchScreenshots`, `tenInchScreenshots`) carries
  `build.txt` with the versionCode the images were taken from; `__tests__/StoreListing.test.js` refuses a folder of
  images from any other build, so no tool uploads screenshots of an earlier app (the old top-tab build's four were
  removed from the repository; the Play Console copies stay until they are replaced by hand,
  `google-play-description.txt`).
- Demo wallets, fresh for every submission and separate per store and device class: A (node registered two days
  before, linked to the owner's spare device, node balance above 1 QNC), B (no node), C (optional: no node, no tokens).
  Only their phrases are handed over, inside the store consoles — never in this repository.
- Managed publishing ON in Play and manual release on the App Store, so both go live on the same day, once the web
  cabinet is live.
- The legacy move release (`wallet-1.3.0-20`, the `-PqnetLegacyMove` build) comes last: only after the Play listing is
  public, `WALLET_APK_URL` is set with a working download on https://aiqnet.io/wallet, and that page explains the
  move ("Google Play — build and package" above). Check both targets of its notice right before creating it.
