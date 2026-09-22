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

- **Transactions the user signs** — public blockchain data by design.
- **Addresses in read queries** (balances, history) to network nodes and the explorer — answered in
  real time, nothing retained beyond ordinary server logs.
- **Light node registration** — node identifier, the wallet address that receives rewards, and a push
  channel: a Firebase Cloud Messaging token (Android and iOS) or a UnifiedPush endpoint. The genesis
  nodes **store the push token** (`fcm_tokens` column family) and use it to send the status request.
  This is the one thing the software retains anywhere other than the device.

Therefore:

**Google Play — Data safety**

| Question | Answer |
|---|---|
| Does the app collect or share user data? | Collects: yes. Shares: no. |
| Device or other IDs | Collected (the push token). Purpose: App functionality. Not shared. Optional: no when a light node is activated. Ephemeral: no. |
| User IDs | Collected (the wallet address bound to a registered node). Purpose: App functionality. Not shared. |
| Financial info / Personal info / Location / Contacts / App activity / Diagnostics | Not collected. |
| Data encrypted in transit | Yes — every connection is HTTPS: the nodes by their public names (`src/config/nodes.js`), the explorer, the Solana RPC. |
| Can users request deletion | Yes — support@aiqnet.io deletes the push token and node registration on request; on-chain data cannot be deleted by anyone, and the policy says so. |
| Independent security review | No. |

**App Store — App Privacy** (`ios/QNetMobile/PrivacyInfo.xcprivacy` declares the same)

| Data type | Linked to the user | Used for tracking | Purpose |
|---|---|---|---|
| Identifiers → Device ID (push token) | No | No | App Functionality |
| Identifiers → User ID (wallet address bound to a node) | No | No | App Functionality |

Everything else: not collected. `NSPrivacyTracking` is false; there is no advertising SDK and no analytics.

## Export compliance (App Store Connect)

- `ITSAppUsesNonExemptEncryption` = YES (`ios/QNetMobile/Info.plist`).
- The app implements standard algorithms — ML-DSA-65 (FIPS 204), ML-KEM-768 (FIPS 203), AES (FIPS 197),
  SHA-3 — in its own native module rather than calling only Apple's frameworks. In Apple's table that is
  "industry standard algorithm, not provided within the Apple operating system": no CCATS; a French
  encryption declaration only if the app is offered in France.
- The same classification (mass-market encryption, License Exception ENC) carries a US obligation: an
  annual self-classification report to BIS and the ENC Encryption Request Coordinator by 1 February for
  the previous year. Filing it is the publisher's task, not the app's.

## Google Play — Financial features declaration

Declare **Cryptocurrency wallet**. The wallet is non-custodial, which Google's cryptocurrency exchanges
and software wallets policy places out of scope of its licensing requirements; no exchange, no fiat
on-ramp, no custody, no lending. The blockchain-based content policy's prohibition on device mining is
not engaged: the device signs a status request and computes nothing.

## Before submission

- Screenshots from the current build for every required device class.
- The test wallet for review: a funded wallet with an activated light node, its seed (and, for Google, the
  Android password) handed over inside the store consoles only — never in this repository.
- Node connections are HTTPS-only already (public names, no cleartext exception on Android), which is
  what App Transport Security on iOS requires and what the "encrypted in transit" answer rests on.
