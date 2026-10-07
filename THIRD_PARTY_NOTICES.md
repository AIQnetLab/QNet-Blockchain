# Third-party notices

This software incorporates components from third-party open-source projects. The lists below cover
the direct dependencies declared by this repository and used by its source code. They are not
exhaustive: the authoritative, complete set of resolved packages and versions is `Cargo.lock` for
the root Rust workspace, the `Cargo.lock` of each Rust workspace of its own (the 1DEV burn contract,
the device oracle and `contracts/`), and the `package-lock.json` of each JavaScript package. Licence identifiers are taken from the package
manifests of the resolved versions; where a manifest offers a choice ("MIT OR Apache-2.0"), the
recipient may pick either. Transitive dependencies are not listed except where noted.

## Rust workspace

### Post-quantum cryptography

| Package | Licence | Used for |
| --- | --- | --- |
| `pqcrypto-mldsa` | MIT OR Apache-2.0 | ML-DSA-65 (FIPS 204, CRYSTALS-Dilithium3) signing and verification on every consensus, identity and gossip path |
| `pqcrypto-traits` | MIT OR Apache-2.0 | Shared key and signature traits for the pqcrypto family |
| `fips204` | MIT OR Apache-2.0 | Deterministic ML-DSA-65 key generation from a seed (`keygen_from_seed`), used to derive node and wallet identities from a 12- or 24-word recovery phrase |
| `pqcrypto` | MIT OR Apache-2.0 | Umbrella crate for the pqcrypto family |
| `pqcrypto-kyber`, `pqcrypto-falcon`, `pqcrypto-sphincsplus` | MIT OR Apache-2.0 | Additional post-quantum algorithm bindings exposed by the `qnet-core` crypto module. Consensus, identity and gossip use ML-DSA-65 only |

### Classical cryptography and hashing

| Package | Licence | Used for |
| --- | --- | --- |
| `sha3` | MIT OR Apache-2.0 | SHA3-256 and SHAKE-256 (FIPS 202): state commitment, address derivation, domain-separated seeds |
| `sha2` | MIT OR Apache-2.0 | SHA-256 / SHA-512, including address derivation and HMAC-SHA512 key derivation |
| `blake3` | CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception | Non-consensus hashing |
| `ed25519-dalek` | BSD-3-Clause | Ed25519: Solana key derivation and burn-ownership proofs, plus batch verification of client transaction signatures |
| `curve25519-dalek` | BSD-3-Clause | Curve arithmetic underlying Ed25519 |
| `hmac` | MIT OR Apache-2.0 | HMAC-SHA512 for hardened key derivation |
| `aes-gcm` | Apache-2.0 OR MIT | AES-256-GCM encryption of key material at rest |
| `chacha20poly1305`, `aead` | Apache-2.0 OR MIT | Authenticated encryption primitives |
| `rsa` | MIT OR Apache-2.0 | RS256 JWT signing for the FCM V1 push API |
| `ring` | Apache-2.0 AND ISC | ECDSA P-256/P-384 and RSA PKCS#1 verification and SHA-2 in `qnet-device-attest` (also pulled in by the TLS stack) |
| `zeroize` | Apache-2.0 OR MIT | Wiping secret material from memory |
| `rand`, `rand_chacha` | MIT OR Apache-2.0 | Random number generation |
| `unicode-normalization` | MIT OR Apache-2.0 | NFKD normalisation of recovery phrases before PBKDF2 |

### Networking and transport

| Package | Licence | Used for |
| --- | --- | --- |
| `quinn` | MIT OR Apache-2.0 | QUIC transport (RFC 9000) for all node-to-node traffic |
| `rustls` | Apache-2.0 OR ISC OR MIT | TLS 1.3 under QUIC, restricted to the `aws_lc_rs` provider |
| `aws-lc-rs` / `aws-lc-sys` (transitive, pulled in by `rustls`'s `aws_lc_rs` feature) | ISC AND (Apache-2.0 OR ISC); `aws-lc-sys` additionally bundles OpenSSL-licensed code | The rustls crypto provider backing the QUIC handshake |
| `rcgen` | MIT OR Apache-2.0 | Generating the node's self-signed QUIC certificate |
| `x509-parser` | MIT OR Apache-2.0 | Parsing peer certificates during the handshake |
| `warp` | MIT | The node's HTTP JSON-RPC and REST server |
| `reqwest` | MIT OR Apache-2.0 | Outbound HTTP, including JSON-RPC calls to Solana (rustls TLS, no OpenSSL) |
| `tokio` | MIT | Async runtime |
| `bytes` | MIT | Buffer management |
| `url` | MIT OR Apache-2.0 | URL parsing |
| `reed-solomon-erasure` | MIT | GF(2^8) erasure coding for block propagation |

### Storage, serialisation and compression

| Package | Licence | Used for |
| --- | --- | --- |
| `rocksdb` | Apache-2.0 | Embedded key-value store for chain and state data |
| `serde`, `serde_json`, `serde_bytes` | MIT OR Apache-2.0 | Serialisation framework and JSON |
| `bincode` | MIT | Canonical binary serialisation on the wire and on disk |
| `zstd` / `zstd-sys` | MIT (bindings; `zstd-sys` is MIT OR Apache-2.0 and vendors the Zstandard C library under BSD-3-Clause, (c) Meta Platforms, Inc.) | Compression of consensus messages and stored data |
| `lz4_flex` | MIT | Fast compression on hot paths |
| `hex`, `base64`, `bs58` | MIT OR Apache-2.0 | Encoding helpers; Base58 is used for Solana addresses and signatures |

### Smart-contract VM

| Package | Licence | Used for |
| --- | --- | --- |
| `wasmi` | MIT OR Apache-2.0 | The deterministic, fuel-metered WASM interpreter that executes contracts. Consensus-critical: a version bump changes execution semantics |
| `wasmparser` | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | Deploy-time module validation, including rejecting floating-point value types and operators |
| `wat` (dev only) | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | Compiling WAT test contracts in unit tests |

### Concurrency, utilities and diagnostics

| Package | Licence | Used for |
| --- | --- | --- |
| `rayon` | MIT OR Apache-2.0 | Data-parallel hashing and parallel signature verification |
| `dashmap` | MIT | Concurrent maps |
| `parking_lot` | MIT OR Apache-2.0 | Locks |
| `async-trait` | MIT OR Apache-2.0 | Async methods in traits |
| `futures` | MIT OR Apache-2.0 | Future combinators and stream utilities |
| `priority-queue` | LGPL-3.0 OR MPL-2.0 | Fee-ordered mempool queue |
| `lru` | MIT | Bounded caches, including the Merkle proof cache |
| `once_cell`, `lazy_static` | MIT OR Apache-2.0 | Lazily initialised globals |
| `thiserror`, `anyhow` | MIT OR Apache-2.0 | Error types |
| `tracing` | MIT | Structured diagnostics |
| `log`, `env_logger` | MIT OR Apache-2.0 | Logging; the node initialises logging with `env_logger` |
| `prometheus` | Apache-2.0 | Metrics |
| `tikv-jemallocator`, `tikv-jemalloc-ctl` | MIT OR Apache-2.0 (bindings; `tikv-jemalloc-sys` vendors the jemalloc C library under BSD-2-Clause) | The node's memory allocator on Linux, and its heap statistics |
| `chrono` | MIT OR Apache-2.0 | Time formatting (block timestamps are slot-anchored, not wall-clock derived) |
| `clap` | MIT OR Apache-2.0 | Command-line argument parsing for `qnet-node` and the load-test harness |
| `dirs` | MIT OR Apache-2.0 | Platform data directories |
| `tempfile` | MIT OR Apache-2.0 | Temporary files |
| `pyo3`, `pyo3-asyncio` (optional, `python` feature) | MIT OR Apache-2.0 | Python bindings; the feature is off by default |
| `colored` | MPL-2.0 | Terminal colouring in the audit suite |
| `criterion`, `proptest`, `pretty_assertions` | MIT OR Apache-2.0 | Benchmarking and property-based testing. Regular dependencies of the `qnet-audit` crate; dev-dependencies elsewhere |
| `quickcheck` | Unlicense OR MIT | Property-based testing; a regular dependency of the `qnet-audit` crate |
| `serial_test`, `test-case` (dev only) | MIT | Sequential and parameterised test harnesses |
| `proptest-derive` (dev only) | MIT OR Apache-2.0 | Derive macros for property tests |

A number of crates are declared in `Cargo.toml` but are not referenced by any source file
(`actix-web`, `actix-cors`, `argon2`, `atty`, `base64ct`, `borsh`, `crossbeam`, `fcm`, `flate2`,
`indexmap`, `multiaddr`, `tracing-subscriber`). They are pending removal and are not documented
individually above.

## 1DEV burn contract (`development/qnet-contracts/1dev-burn-contract`)

This crate declares its own `[workspace]` and is not a member of the root Cargo workspace, so its
dependencies do not appear in the root `Cargo.lock`.

| Package | Licence | Used for |
| --- | --- | --- |
| `anchor-lang` | Apache-2.0 | Solana program framework: account validation, instruction dispatch |
| `anchor-spl` | Apache-2.0 | SPL token account and burn instruction helpers |
| `blake3` | CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception | Hashing |
| `bs58` | MIT OR Apache-2.0 | Base58 encoding of Solana addresses |

## Developer SDK (`development/qnet-sdk`)

A TypeScript package outside both the Cargo workspace and `applications/`, licensed Apache-2.0.

| Package | Licence | Used for |
| --- | --- | --- |
| `@noble/hashes`, `@noble/post-quantum` | MIT | SHA-2, SHA-3 and ML-DSA-65 |
| `@scure/base`, `@scure/bip39` | MIT | Base58 and the recovery-phrase word list |
| `hash-wasm` | MIT | Argon2id for the key files |
| `js-sha3` (dev only, compiled into `dist/`) | MIT | SHA-3 in the shared wallet sources |
| `esbuild`, `@types/node` (dev only) | MIT | Build and Node types |
| `typescript` (dev only) | Apache-2.0 | Type checking and declarations |

## Device oracle (`development/qnet-device-oracle`)

A Rust crate with a workspace of its own, built into its own image and never linked into the node.
It uses the root workspace's `qnet-device-attest` by path.

| Package | Licence | Used for |
| --- | --- | --- |
| `rustls` | Apache-2.0 OR ISC OR MIT | The oracle's mutual-TLS 1.3 server, restricted to the `aws_lc_rs` provider, hybrid post-quantum key exchange preferred |
| `aws-lc-rs` / `aws-lc-sys` | ISC AND (Apache-2.0 OR ISC); `aws-lc-sys` additionally bundles OpenSSL-licensed code | The TLS crypto provider; AES-256-GCM sealing of evidence; unwrapping and checking Play Integrity tokens; ES256 and RS256 tokens for the Apple and Google APIs |
| `pqcrypto-mldsa`, `pqcrypto-traits` | MIT OR Apache-2.0 | ML-DSA-65 signatures of lease statements and revocation snapshots |
| `httparse` | MIT OR Apache-2.0 | HTTP/1.1 request parsing in the oracle's server |
| `reqwest` | MIT OR Apache-2.0 | Calls to the Apple and Google services, and the standby's replication client (rustls TLS) |
| `rocksdb` | Apache-2.0 | The lease database and its replication log |
| `serde`, `serde_json`, `base64`, `hex` | MIT OR Apache-2.0 | Serialisation and encoding |
| `bincode` | MIT | Stored records and replication log entries |
| `sha3` | MIT OR Apache-2.0 | SHA3-256 of device keys, tags and statements |
| `parking_lot` | MIT OR Apache-2.0 | Locks |
| `tempfile`, `rcgen` (dev only) | MIT OR Apache-2.0 | Test databases and test certificates |

## WASM contracts (`contracts/`)

A Cargo workspace of its own. The helper crate `qnet-contract` and the templates have no third-party
dependencies. The build and check tool links the node's `core/qnet-vm` by path, whose dependencies are
listed under the Rust workspace above.

| Package | Licence | Used for |
| --- | --- | --- |
| `wasmparser` | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | The import and export checks of a module |
| `serde_json` | MIT OR Apache-2.0 | Reading the build's metadata and compiler messages |
| `sha3` | MIT OR Apache-2.0 | The address checksum of address-valued build variables |
| `wat` (dev only) | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | Compiling WAT test modules |

## Test data and pinned certificates

`core/qnet-device-attest/tests/testdata/android/` holds certificate chains Google publishes as test data
of its key attestation verifier (github.com/android/keyattestation, Apache License 2.0), and
`tests/testdata/apple/` the sample values of Apple's Attestation Object Validation Guide; each folder
has a NOTICE with the details. `core/qnet-device-attest/roots/` holds the public root certificates
Apple and Google publish for App Attest, App Attest receipts and Android key attestation.

## Vendored source

`applications/qnet-mobile/android/app/src/main/cpp/mldsa65/` and the accompanying `common/fips202.c`
contain the ML-DSA-65 reference implementation vendored from PQClean (the symbols carry the
`PQCLEAN_MLDSA65_CLEAN_` prefix). No licence file is vendored alongside this copy; the applicable
terms are those published by upstream PQClean for its `clean` reference implementations, and the
maintainer should add the upstream licence text to that directory.

## Mobile application (`applications/qnet-mobile`)

The direct dependencies of `applications/qnet-mobile/package.json`.

| Package | Licence | Used for |
| --- | --- | --- |
| `react-native`, `react`, `react-test-renderer` | MIT | Application framework |
| `react-native-webview` | MIT | The in-app browser's web view (pinned version, patched by `patches/react-native-webview+14.0.1.patch`) |
| `@noble/post-quantum` | MIT | ML-DSA-65 signatures of off-chain messages in JavaScript |
| `@noble/curves`, `@noble/hashes`, `@noble/ciphers` | MIT | X25519, HKDF and AES-256-GCM of QNet Link answers; elliptic-curve and hash primitives |
| `@scure/bip32`, `bip39`, `ed25519-hd-key` | MIT (`bip39`: ISC) | Mnemonic handling and hierarchical key derivation |
| `@solana/web3.js` | MIT | Solana key derivation (the key pair of the wallet's Solana address) |
| `tweetnacl` | Unlicense | Ed25519 primitives |
| `js-sha3` | MIT | SHA3-256 / SHAKE256 in JavaScript |
| `react-native-quick-crypto` | MIT | Native hashing, HMAC and WebCrypto on device |
| `react-native-keychain` | MIT | OS-backed secure storage for key material |
| `react-native-get-random-values`, `react-native-quick-base64` | MIT | Secure randomness and Base64 |
| `@react-native-async-storage/async-storage` | MIT | Local persistence |
| `@react-native-firebase/app`, `@react-native-firebase/messaging` | Apache-2.0 | Silent data messages that wake a linked light node; the app shows no notification |
| `react-native-background-fetch` | MIT | Background execution for Light node pings |
| `com.google.android.play:integrity` (Android library) | Play Integrity API Terms of Service | The integrity token and Google Play's dialogs in a light node's device check |
| `androidx.biometric:biometric` (Android library) | Apache-2.0 | The system biometric prompt that unlocks the vault's biometric key on Android |
| `react-native-svg`, `react-native-qrcode-svg` | MIT | Vector rendering and QR codes |
| `react-native-camera-kit` | MIT | The camera view of the QR scan on the QNet Send screen (pinned version, patched by `patches/react-native-camera-kit+18.0.1.patch`) |
| `com.google.zxing:core` 3.5.4 (Android library of `react-native-camera-kit`, put in by that patch) | Apache-2.0 (Copyright ZXing authors; the library ships no NOTICE file) | Decoding the QR code on the device on Android |
| `buffer`, `readable-stream`, `stream-browserify`, `process`, `events` | MIT | Node.js API shims |
| `react-native-safe-area-context`, `@react-native-clipboard/clipboard`, `react-native-nitro-modules`, `@react-native/new-app-screen` | MIT | Layout insets, clipboard access, the native-module bridge and the starter screen |
| `jest`, `eslint`, `prettier`, `typescript`, `patch-package` (dev only) | MIT (`typescript`: Apache-2.0) | Testing and tooling |

## Browser extension wallet (`applications/qnet-wallet`)

The direct dependencies of `tools/crypto-bundle/package.json`, compiled into the extension's one crypto
module, `dist/lib/qnet-core.js`.

| Package | Licence | Used for |
| --- | --- | --- |
| `@noble/post-quantum` | MIT | ML-DSA-65 signing and verification |
| `@noble/curves`, `@noble/hashes` | MIT | Ed25519 of the Solana account; SHA-2, SHA-3, BLAKE3, HMAC and PBKDF2 |
| `@scure/base`, `@scure/bip39` | MIT | Base58 and the recovery phrase |
| `hash-wasm` | MIT | Argon2id of the vault |
| `js-sha3` | MIT | SHA3-256 / SHAKE256 in the light client compiled from the mobile app |
| `buffer` | MIT | The Node.js `Buffer` API for that light client; it includes `base64-js` (MIT) and `ieee754` (BSD-3-Clause) |
| `esbuild` (dev only) | MIT | Bundling |

## Explorer (`applications/qnet-explorer`)

The direct dependencies of `frontend/package.json`.

| Package | Licence | Used for |
| --- | --- | --- |
| `next`, `react`, `react-dom` | MIT | Web framework and UI runtime |
| `pg` | MIT | PostgreSQL client |
| `ws` | MIT | The indexer's WebSocket client |
| `@noble/curves`, `@noble/hashes`, `@noble/post-quantum` | MIT | Ed25519 and X25519, SHA-2 and BLAKE3, and ML-DSA-65 verification in the node cabinet and QNet Link |
| `bs58` | MIT | Base58 of Solana addresses and signatures |
| `js-sha3` | MIT | SHA3-256 in the browser |
| `tweetnacl` | Unlicense | Ed25519 signature check of DAO votes |
| `next-themes` | MIT | Theming |
| `tailwindcss-animate`, `autoprefixer`, `postcss-selector-parser`, and `tailwindcss`, `postcss` (dev only) | MIT | Styling |
| `@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-label`, `@radix-ui/react-slot`, `@radix-ui/react-tabs` | MIT | UI primitives |
| `clsx`, `tailwind-merge`, `date-fns` | MIT | Utility helpers |
| `class-variance-authority` | Apache-2.0 | Component variants |
| `lucide-react` | ISC | Icons |
| `@biomejs/biome` (dev only) | MIT OR Apache-2.0 | Formatting and linting |
| `eslint`, `eslint-config-next`, `@eslint/eslintrc`, `@types/*` (dev only) | MIT | Linting and types |
| `@swc/helpers`, `typescript` (dev only) | Apache-2.0 | Build helpers and type checking |

## CLI (`applications/qnet-cli`)

| Package | Licence | Used for |
| --- | --- | --- |
| `click` | BSD-3-Clause | Command-line interface |
| `requests` | Apache-2.0 | HTTP calls to a node's RPC endpoint |

---

For the full licence text of any dependency, consult that package's repository or the copy in your
local package cache. QNet's own licence terms are in [LICENSE](LICENSE); see
[CONTRIBUTING.md](CONTRIBUTING.md) for which directories are covered by which licence.
