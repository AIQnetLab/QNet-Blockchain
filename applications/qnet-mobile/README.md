# QNet Mobile Wallet

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![F-Droid](https://img.shields.io/badge/F--Droid-Compatible-green.svg)](https://f-droid.org)

This is the official mobile wallet for QNet Blockchain, built with [**React Native**](https://reactnative.dev) and bootstrapped using [`@react-native-community/cli`](https://github.com/react-native-community/cli).

## 📜 License

This mobile application is licensed under **Apache License 2.0** - fully open-source and F-Droid compatible.

**Important**: The QNet blockchain node software (in the parent repository) uses BSL 1.1 license. However, this mobile app:
- ✅ Contains **NO blockchain node code**
- ✅ Contains **NO Rust dependencies**
- ✅ Connects to nodes via **HTTP API only**
- ✅ Is **100% Apache 2.0 licensed**

See [LICENSE](LICENSE) for full terms.

---

## 🔐 Security & Cryptography

### Transaction Signing

QNet Mobile Wallet signs all transactions with pure **ML-DSA-65 (Dilithium3)**:

- ✅ **Post-quantum**: NIST-standardized lattice signatures (FIPS 204)
- ✅ **Quantum-resistant**: Level 3 security, safe against quantum attacks
- ✅ **Uniform**: Same signature scheme used across wallet and node consensus
- ✅ **Deterministic**: Reproducible signing for consensus safety

### Key Management

- **BIP39 Mnemonic**: 12-word recovery phrase
- **HD Derivation**: Hierarchical deterministic keys
- **Secure Storage**: AES-256-GCM encrypted
- **No Cloud**: Keys never leave your device

### Transaction Types

#### 1. Transfer (sendQNC)
```javascript
// Client signs: "transfer:from:to:amount:1:10000"
// Server verifies ML-DSA-65 (Dilithium3) signature
// Transaction recorded on blockchain
```

#### 2. Reward Claims
```javascript
// Client signs: "claim_rewards:node_id:wallet_address"
// Server verifies ML-DSA-65 (Dilithium3) signature
// Creates RewardDistribution transaction
// All nodes verify and record on blockchain
```

### Why pure ML-DSA-65 (Dilithium3)?

| Aspect | ML-DSA-65 (Dilithium3) |
|--------|------------------------|
| Security | Post-quantum, NIST Level 3 (FIPS 204) |
| Signature size | ~3.3 KB |
| Standardization | NIST-standardized lattice signatures |
| Quantum resistance | ✅ Safe against quantum attacks |

**Note**: QNet uses pure ML-DSA-65 (Dilithium3) everywhere — both client transactions and node consensus — so the entire system is quantum-resistant with no classical-crypto weak link. (Ed25519 is not used by QNet; it appears only as the Solana-side signature required to burn 1DEV during node activation.)

---

# Getting Started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

## Step 1: Start Metro

First, you will need to run **Metro**, the JavaScript build tool for React Native.

To start the Metro dev server, run the following command from the root of your React Native project:

```sh
# Using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Build and run your app

With Metro running, open a new terminal window/pane from the root of your React Native project, and use one of the following commands to build and run your Android or iOS app:

### Android

```sh
# Using npm
npm run android

# OR using Yarn
yarn android
```

### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to be run on first clone or after updating native deps).

The first time you create a new project, run the Ruby bundler to install CocoaPods itself:

```sh
bundle install
```

Then, and every time you update your native dependencies, run:

```sh
bundle exec pod install
```

For more information, please visit [CocoaPods Getting Started guide](https://guides.cocoapods.org/using/getting-started.html).

```sh
# Using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up correctly, you should see your new app running in the Android Emulator, iOS Simulator, or your connected device.

This is one way to run your app — you can also build it directly from Android Studio or Xcode.

## Step 3: Modify your app

Now that you have successfully run the app, let's make changes!

Open `App.tsx` in your text editor of choice and make some changes. When you save, your app will automatically update and reflect these changes — this is powered by [Fast Refresh](https://reactnative.dev/docs/fast-refresh).

When you want to forcefully reload, for example to reset the state of your app, you can perform a full reload:

- **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Dev Menu**, accessed via <kbd>Ctrl</kbd> + <kbd>M</kbd> (Windows/Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (macOS).
- **iOS**: Press <kbd>R</kbd> in iOS Simulator.

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [docs](https://reactnative.dev/docs/getting-started).

# Troubleshooting

If you're having issues getting the above steps to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.
