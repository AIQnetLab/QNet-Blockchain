# Contributing to QNet

This document describes how to build, test and change the code in this repository. QNet is a Rust
Cargo workspace (the node and its libraries) plus several JavaScript and Python applications. There
is no formal RFC or design-review process: substantial changes start as a GitHub issue describing
the problem, and everything else goes straight to a pull request.

Security vulnerabilities must not be filed as public issues or pull requests. Follow
[SECURITY.md](SECURITY.md) instead.

## Prerequisites

| Component | Requirement |
| --- | --- |
| Rust | A recent stable toolchain. The workspace pins no `rust-toolchain.toml`, but dependencies set the floor: `wasmi` 0.47 declares `rust-version = "1.86"`, so anything older will not build. Add the `rustfmt` and `clippy` components. |
| Build tools (Linux) | `build-essential`, `pkg-config`, `libssl-dev`. These are what CI installs, and RocksDB needs a C/C++ toolchain. |
| Node.js | The mobile app declares `engines.node >= 20`. The explorer front end is built on Node 18 in CI. |
| Python | Required by `applications/qnet-cli`, which declares `python_requires >= 3.8`, and by any Cargo command that enables the `python` feature — including `--all-features`, which pulls in `pyo3` (and `pyo3-asyncio` in `qnet-consensus`) and needs a discoverable Python 3 interpreter at build time. |

```bash
rustup default stable
rustup component add rustfmt clippy
```

## Workspace layout

The root `Cargo.toml` declares these members:

| Crate | Path | Role |
| --- | --- | --- |
| `qnet-core` | `core/qnet-core` | Core primitives and the cryptography layer |
| `qnet-consensus` | `core/qnet-consensus` | Checkpoint-BFT, committees, rewards |
| `qnet-mempool` | `core/qnet-mempool` | Transaction pool |
| `qnet-state` | `core/qnet-state` | Accounts, transactions, state commitment, RocksDB |
| `qnet-sharding` | `core/qnet-sharding` | Shard coordinator and parallel validator. The shard coordinator is pinned off in the node behind an `if false` guard (`development/qnet-integration/src/node.rs`), so only `ParallelValidator` is live |
| `qnet-vm` | `core/qnet-vm` | Deterministic WASM contract VM (`wasmi`) and deploy-time validator |
| `qnet-integration` | `development/qnet-integration` | The node binary `qnet-node`, P2P, RPC |
| `qnet-loadtest` | `development/qnet-loadtest` | External load-test harness |
| `qnet-audit` | `audit` | Security and correctness test suites |

Applications live outside the workspace under `applications/`: `qnet-mobile` (React Native),
`qnet-wallet` (browser extension), `qnet-explorer` (Next.js), `qnet-cli` (Python). Two more
components sit outside it as well: `development/qnet-sdk` (a TypeScript client package) and
`development/qnet-contracts/1dev-burn-contract` (a Solana program that declares its own Cargo
workspace).

## Build and test

Run from the repository root.

```bash
cargo build --workspace                 # debug build of every crate
cargo build --workspace --release       # release profile: LTO, codegen-units = 1, panic = abort
cargo test --workspace --lib            # the unit-test set CI gates on
cargo test --workspace                  # adds integration tests under */tests
```

Formatting and lints:

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
```

`--all-features` enables the optional `python` feature and its `pyo3` bindings. Without a Python
toolchain on the machine, run `cargo clippy --all-targets -- -D warnings` instead.

CI runs both steps with `continue-on-error`, so they do not currently block a merge. Treat them as
required anyway — a PR that adds new formatting or clippy noise will be asked to fix it.

Applications:

```bash
cd applications/qnet-mobile        && npm install && npm test      # jest, react-native preset
cd applications/qnet-mobile        && npm run lint                 # eslint
cd applications/qnet-explorer/frontend && npm install && npm run lint && npm run build
cd applications/qnet-wallet        && npm install && npm run build  # esbuild bundle
```

Two notes. The mobile app runs `patch-package` on `postinstall`, and `.gitattributes` forces `*.patch`
to LF — on Windows, do not let `core.autocrlf` rewrite those files or `npm install` will fail. The
explorer's `lint` script shells out to `bunx` for Biome and `tsc`, so it needs `bun` on PATH.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `master`, `develop` and `testnet`, and on pull requests
targeting `master` and `testnet`. It builds the workspace, runs `cargo test --workspace --lib`, and
builds the explorer front end. It also has its own `cargo audit` and `npm audit` job.

`.github/workflows/security.yml` runs a Trivy filesystem scan, GitLeaks secret scanning,
`cargo audit`, GitHub dependency review, and a Docker image build-and-scan. It triggers on pushes to
`master` and `develop`, on pull requests targeting `master`, and weekly. A pull request targeting
`testnet` does not trigger it.

## Code style

- Code and comments are written in English, without exception.
- Rust follows `rustfmt` defaults. Do not hand-format around it.
- Comments explain what the code does and why, in a line or two. Do not put incident history,
  changelog entries, version tags or dated status notes into comments or documentation — that is
  what the git log is for.
- Name constants and reference them by name. A magic number in consensus code will be questioned.
- Documentation under `docs/` is reference material: state the behaviour the code has, in the
  present tense. Describe what the system does, not what it does not do — a mechanism that does not
  run belongs in no document, and neither do defect lists, throughput figures or marketing.

## Changes that affect consensus

Anything that changes block or transaction hashing, canonical serialisation, signature message
construction, consensus constants, or the WASM VM (including a `wasmi` version bump) changes what
nodes accept and is a hard fork. Such changes need an issue first, must state the compatibility
impact in the pull request description, and must come with tests that pin the new behaviour
byte-for-byte. Do not introduce environment variables that let an operator change consensus or
safety parameters at runtime.

## Commits and pull requests

- Branch from the branch you intend to target; `master` is the default branch, `testnet` carries
  pre-release work.
- Commit subjects in this repository are predominantly `subsystem: short imperative summary`, for
  example `consensus: bound seal-frontier outrun`. Conventional-commit prefixes (`feat:`, `fix:`)
  appear occasionally. No format is enforced — match the surrounding history and keep the subject
  under roughly 72 characters.
- One logical change per pull request. Describe what changed, why, and how you verified it. Link
  the issue if there is one.
- Never commit secrets: mnemonics, private keys, API keys, `.pem` files, node data directories, or
  operator IP addresses. GitLeaks runs in CI, but the reviewer is the real gate.
- Do not commit build artefacts, logs, or `node_modules`.

## Licensing of contributions

The repository is dual-licensed and contributions inherit the licence of the directory they land in.
Code under `core/`, `development/`, `audit/`, `governance/`, `deployment/`, `infrastructure/`,
`testing/` and `monitoring/` is covered by the [Business Source License 1.1](LICENSE), with one
exception: `development/qnet-sdk/` is Apache License 2.0. Code under `applications/` is also Apache
License 2.0. [LICENSE](LICENSE) carries the authoritative scope list; read it rather than this
summary if a directory is ambiguous.
By opening a pull request you agree that your contribution is licensed accordingly. If you add a
third-party dependency, update [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) in the same PR.

## Where to ask

Open a GitHub issue on the repository for questions, bug reports and feature proposals. Include the
commit you are on, your OS and toolchain versions, the exact command you ran, and the relevant log
output. For anything security-sensitive, use the private process in [SECURITY.md](SECURITY.md).
