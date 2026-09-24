# Store listing

What the two stores are told about QNet Wallet, in one place, so the answers stay consistent with each
other and with the code. The privacy policy and the terms are not kept here: the canonical texts are
the pages the stores link to.

| Item | Where |
|---|---|
| Google Play listing text | `google-play-description.txt` |
| App Store listing text and review notes | `app-store-listing.txt` |
| Privacy policy | https://aiqnet.io/privacy (`applications/qnet-explorer/frontend/src/app/privacy/page.tsx`) |
| Terms of use | https://aiqnet.io/terms |
| Support page | https://aiqnet.io/support · support@aiqnet.io |
| Icon and feature graphic | `app-icon-512.png`, `feature-graphic.png` |

## Data declarations

Both stores ask what the app collects. The truthful answer follows from what the code sends off the
device and what is kept there — "collected" in both stores' vocabulary means transmitted to servers the
publisher operates and retained, not merely shown on screen.

What leaves the device:

- **Transactions the user signs** — transfers, token calls, reward claims, node registration: public
  blockchain data by design. A registration links the Solana address that burned 1DEV to the QNet address.
- **Addresses in read queries** — the QNet address to network nodes and the explorer, automatically while
  the app is open (balances every 15 s, history); the Solana address to the nodes in the `X-QNet-Wallet`
  header while the wallet holds no activation. Answered in real time, nothing retained beyond server logs.
- **Solana RPC** — the Solana address goes to public Solana RPC endpoints automatically: balances, and a
  scan for an activation burn made from it. These endpoints are third parties with no contract with the
  publisher.
- **Firebase** — at every launch the app asks Firebase Cloud Messaging for a push token, which also issues
  a Firebase installation ID, whether or not a node is active.
- **Light node registration** — node identifier, the reward wallet, burn transaction, an app-generated
  `device_id`, ping keys and the push channel (FCM token or UnifiedPush endpoint). The genesis nodes
  **store the push token** (`fcm_tokens` column family, copied to every genesis node) and use it to send the
  status request; a hash of the token travels in light-node gossip between nodes.
- **CoinGecko and GitHub** — SOL and 1DEV price quotes and token logos; no address, the IP address only.

Therefore:

**Google Play — Data safety**

| Question | Answer |
|---|---|
| Does the app collect or share user data? | Yes. |
| Personal info → User IDs | Collected and **shared**: the QNet and Solana addresses; the Solana address reaches public Solana RPC endpoints automatically. Purpose: App functionality. Required. Not ephemeral. |
| Financial info → Purchase history (and Other financial info) | Collected: the transactions the user signs reach the nodes and stay on the public chain. Not shared (user-initiated). Purpose: App functionality. Required. |
| Device or other IDs | Collected and **shared**: Firebase installation ID and push token at every launch, `device_id` at registration; a hash of the push token travels in node gossip. Google is a service provider. Purpose: App functionality. Required. |
| Other Personal info / Location / Contacts / Messages / Photos / Files / Audio / Calendar / Health / Web browsing / App activity / App info and performance | Not collected. No analytics or crash SDK; FCM delivery metrics are off. |
| Data encrypted in transit | Yes — every connection from the device is HTTPS: the nodes by their public names (`src/config/nodes.js`), the explorer, Solana RPC, Firebase, CoinGecko, GitHub. |
| Can users request deletion | **No** in the form: there is no deletion mechanism for the stored push token yet (no deregistration endpoint), and blockchain records cannot be deleted; the privacy policy says the same. The app has no accounts, so no account-deletion URL applies. |
| Independent security review | No. |

**App Store — App Privacy** (`ios/QNetMobile/PrivacyInfo.xcprivacy` declares the same)

| Data type | Linked to the user | Used for tracking | Purpose |
|---|---|---|---|
| Identifiers → Device ID (push token, issued at every launch) | No | No | App Functionality |
| Identifiers → User ID (QNet and Solana addresses) | No | No | App Functionality |
| Financial Info → Other Financial Info (transactions the user signs) | No | No | App Functionality |

"Linked: No" — the addresses are pseudonymous and the app has no account, name or contact detail to tie
them to. Everything else: not collected. `NSPrivacyTracking` is false; there is no advertising SDK and no analytics.

## Export compliance (App Store Connect)

- `ITSAppUsesNonExemptEncryption` = YES (`ios/QNetMobile/Info.plist`).
- The app implements standard algorithms outside Apple's frameworks: ML-DSA-65 (FIPS 204) and SHA-3/SHAKE in
  its own native module, AES-256-GCM for keys at rest through its JavaScript crypto library. In Apple's table that is
  "industry standard algorithm, not provided within the Apple operating system": no CCATS; a French
  encryption declaration only if the app is offered in France.
- The same classification (mass-market encryption, License Exception ENC) carries a US obligation: an
  annual self-classification report to BIS and the ENC Encryption Request Coordinator by 1 February for
  the previous year. Filing it is the publisher's task, not the app's.

## Google Play — Financial features declaration

Declared: **Cryptocurrency wallet** only. Light-node rewards are QNC, a fungible coin, not a tokenized digital
asset (NFT); the app sells, trades and awards no NFTs. Declaring the NFT category as well disables the
non-custodial exemption and demands a crypto licence in every targeted jurisdiction.

Documentation step (all countries targeted): Google lists Bahrain, Canada, the EU, Israel, Japan, the Philippines,
South Africa, South Korea, the UAE, the UK and the US, and in each the app is declared **a non-custodial software
wallet** — keys stay on the device; no exchange, no fiat on-ramp, no custody, no lending. For "all countries or
regions" the publisher accepts Google's terms that any licence local law requires is held and that changes in
legal status are reported. The IARC questionnaire answers "convertible cryptocurrency rewards: yes" for the
node rewards. The policy's prohibition on device mining is not engaged: the device signs status requests and
one attestation per epoch, and computes nothing else.

## Google Play — build and package

The Play build is the `play` flavor, package `io.aiqnet.wallet`: Google keeps a package name forever and
`com.qnetmobile` stays reserved by a closed developer account. The `site` flavor keeps `com.qnetmobile`, so the
APK on aiqnet.io and GitHub still updates over installed copies. Both are registered in the Firebase project
`qnet-wallet` (`android/app/google-services.json` carries one client per package).

- Play: `cd android && ./gradlew bundlePlayRelease` → `app/build/outputs/bundle/playRelease/app-play-release.aab`.
  ARM only (`armeabi-v7a`, `arm64-v8a`): Play requires every 64-bit library to be 16 KB-aligned; ours links
  with `max-page-size=16384`, and react-native-keychain 8 ships a 4 KB-aligned x86_64 `libconceal.so`.
- The Play build does not start a node activation (`src/config/store.js`); an Android build that cannot name
  its flavor behaves the same way.
- Site: `./gradlew assembleSiteRelease` → `app/build/outputs/apk/site/release/app-site-release.apk`.

## Google Play — where review can object

Checked against the policy texts on 23.09.2026 (support.google.com/googleplay/android-developer, answers
9858738, 13607354, 16329703, 13849271, 10144311).

- **Payments.** "Play-distributed apps requiring or accepting payment for access to in-app features … must
  use Google Play's billing system." The 1DEV burn is the site and iOS builds' activation; the Play build
  starts none. Its Activate tab only recovers an activation the wallet already holds and never mentions
  another version; the only burn references left are the transaction of a super node's existing activation in
  its recovered code. Nothing steers to a payment outside Play.
- **Cryptomining.** "We don't allow apps that mine cryptocurrency on devices." A light node earns rewards from
  a phone, which a reviewer can mistake for mining; the listing states that the device only signs status
  requests and one attestation per epoch.
- **Earning claims.** "You may not promote or glamorize any potential earning." The listing says rewards are
  decided by the protocol and not guaranteed, and that tokens may have no monetary value.
- **Privacy policy inside the app.** Required in the Play Console field and within the app; the terms screen
  links to https://aiqnet.io/privacy and https://aiqnet.io/terms.
- **Accuracy of the listing.** Everything stated must hold: licences (apps Apache-2.0, node BSL 1.1), the
  cryptography, the network stage (testnet), a QR code shown (the app has no camera scanner), partial
  translations. Screenshots and the feature graphic show only what the Play build has.
- **Prices.** Dollar values appear only for a quoted price on Solana mainnet; unquoted tokens and devnet show a dash.
- **Permissions.** INTERNET, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS (declared, not requested), USE_BIOMETRIC,
  USE_FINGERPRINT, WAKE_LOCK, RECEIVE_BOOT_COMPLETED, the FCM receive permission, and SCHEDULE_EXACT_ALARM with
  maxSdkVersion 33 from react-native-background-fetch. No USE_EXACT_ALARM, no location, no foreground service,
  no battery-optimisation exemption — nothing that needs a separate declaration.
- **Target API.** 36.

## Before submission

- Screenshots from the current build: at least two phone screenshots; Play rejects a side longer than twice
  the other, so a tall 20:9 capture has to be cropped to 2:1. `fastlane/metadata/android/en-US/images/phoneScreenshots`
  holds the current set (wallet, receive, send, result).
- The test wallet for review: a wallet dedicated to review, funded, with an activation on chain. Only its
  seed is handed over, inside the store consoles — never in this repository; the reviewer sets the app
  password when importing. Registering its node on the reviewer's device moves that node's pings there.
- Node connections are HTTPS-only already (public names, no cleartext exception on Android), which is
  what App Transport Security on iOS requires and what the "encrypted in transit" answer rests on.
