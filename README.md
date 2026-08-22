# QNet

QNet is a post-quantum layer-1 blockchain. Every consensus vote, block signature, node identity
and transaction on the chain is authenticated with ML-DSA-65 (CRYSTALS-Dilithium3, FIPS 204). The
external Solana burn credential presented at node activation is verified with its own native
Ed25519 signature.
Blocks are produced in two tiers — a single elected producer streams microblocks on a fixed
one-second slot and rotates every 30 blocks, while a Checkpoint-BFT committee certifies a
finality checkpoint every 30 blocks and seals a macroblock every 90 — so irreversibility comes
from an explicit quorum certificate rather than block depth. The protocol defines two node types:
Super nodes, which participate in consensus and serve the network's HTTP/RPC surface, and Light
nodes, which are mobile clients that store no chain data. Node participation is paid for by proof
of burn, and consensus reputation is binary (70 or 0, dropping to 0 only on a cryptographically
proven equivocation).

## Project status

Pre-launch and experimental. The software is under active development. Consensus and economic
parameters such as `CHECKPOINT_INTERVAL`, `COMMITTEE_SIZE` and `VIEW_TIMEOUT_MS` are compile-time
constants rather than operator settings, so changing any of them means rebuilding and relaunching
the whole network. Expect chain resets during this period, and run nodes, hold value and deploy
contracts at your own risk. See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Key properties

| Property | Value |
| --- | --- |
| Signature scheme | ML-DSA-65 / CRYSTALS-Dilithium3 (FIPS 204) — 1952-byte public key, 3309-byte signature |
| Hash function | SHA3-256 (domain-separated per structure) |
| Address format | 45 ASCII chars: 19 lowercase hex, the literal `eon`, 15 hex, 8-hex checksum |
| Microblock slot | `MICROBLOCK_INTERVAL_SECS = 1`; `block_ts = genesis_ts + height x 1s`, so the wall clock is never a consensus input |
| Producer rotation | `ROTATION_INTERVAL_BLOCKS = 30`; leader is a public, deterministic SHA3-256 selection over the roster of macroblock N-2 |
| Macroblock / epoch | `MACROBLOCK_INTERVAL = 90` microblocks (3 producer rotations per window) |
| Finality | Checkpoint-BFT quorum certificates at `CHECKPOINT_INTERVAL = 30` microblocks, 2-chain commit rule |
| Quorum | `quorum_size(n) = n - floor((n-1)/3)`, equal to 2f+1 when n = 3f+1 |
| Committee | `COMMITTEE_SIZE = COMMITTEE_THRESHOLD = 1000`, sampled from the eligible-producer set of macroblock N-2 |
| Producer failover | Signed timeout votes forming an n-f timeout certificate; `MAX_FAILOVER_ROUND = 50` |
| Node types | `Light`, `Super` |
| Reputation | Binary `{70.0, 0.0}`; `INITIAL_REPUTATION = MIN_CONSENSUS_REPUTATION = 70.0` |
| State model | Account-based, committed in a state merkle root; RocksDB persistence |
| Native token | QNC, 9 decimals; `MAX_QNC_SUPPLY = 4_294_967_296` QNC (2^32); genesis supply 0, no premine |
| Emission | One emission every `EMISSION_BLOCK_INTERVAL = 14_400` microblocks, split 25% operators / 75% light nodes when both cohorts are non-empty; when either cohort is empty the other receives the whole emission. Rewards are pull-only via signed claims |
| Transaction fees | Credited in full to the block producer's registered wallet |
| Smart contracts | WASM contracts execute on the apply path in the deterministic `qnet-vm` interpreter (fuel-metered, float-free), so contract state is part of the state root. QRC-20 and QRC-721 are native transaction arms in the state crate |
| P2P transport | QUIC over TLS 1.3 on the aws-lc-rs provider. Peer identity is proved by an ML-DSA-65 signature bound to the session through exported keying material; the negotiated key-exchange group is the provider default. Block fetch, peer authentication and health probes run over HTTP/TCP |

## Node types

| | Super | Light |
| --- | --- | --- |
| Consensus | Produces microblocks, votes in Checkpoint-BFT, votes in producer failover | Wallet and reward client only |
| Consensus key | Publishes a 1952-byte ML-DSA-65 `vrf_pk` in its on-chain registration row | None |
| Chain data | Stores and serves chain state, and may take on archival duty | Stores no blocks, headers or state |
| Producer eligibility | From `ACTIVATION_WARMUP_BLOCKS = 180` blocks past its registration height; genesis identities are eligible immediately | Not applicable |
| Reward eligibility | On-chain heartbeat subwindow popcount >= 9 for the epoch and never banned | Per-epoch eligibility bitmaps published on chain by genesis nodes |
| Where it runs | Servers and desktops, via Docker | Mobile devices, inside the wallet app; at most 3 devices per Light node |
| Registration | Created server-side by the node itself | Created client-side by the mobile wallet |

Five pinned genesis identities (`genesis_node_001` through `genesis_node_005`) form the consensus
committee at network start, and the committee is sampled from the on-chain roster thereafter.

## Node activation

Running a node requires an activation code, obtained by paying the network's entry cost. Two
phases exist. In Phase 1 the payment is a burn of the external 1DEV token on Solana; the price is
identical for both node types and falls as more of the 1DEV supply is burned, following
`max(1500 - 150 x floor(burn% / 10), 300)` whole 1DEV. In Phase 2 the payment is QNC transferred
on-chain rather than burned, with base costs of 10,000 QNC for a Light node and 7,500 QNC for a
Super node before a network-size multiplier. The transition happens when 90% of the 1DEV supply
has been burned or five years have passed since the genesis block, whichever comes first; Phase 1
is the active path today. Every burn is cryptographically bound to one node identity and
re-verified at block apply. See
[docs/economics/node-activation.md](docs/economics/node-activation.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `core/` | Rust workspace crates: `qnet-consensus` (Checkpoint-BFT, reputation), `qnet-state` (accounts, blocks, transactions, storage model), `qnet-mempool`, `qnet-core` (crypto primitives, merkle), `qnet-vm` (deterministic WASM interpreter used for contract execution, plus its deploy-time determinism validator) |
| `development/` | The production node and developer tooling: `qnet-integration` (the Rust node binary, P2P, RPC, block pipeline, storage), `qnet-contracts`, `qnet-sdk`, `qnet-proto`, `qnet-loadtest`, `qnet-security`, Dockerfiles |
| `applications/` | Client applications, licensed Apache-2.0: `qnet-mobile` (mobile wallet and Light node), `qnet-wallet` (browser extension), `qnet-explorer`, `qnet-cli` |
| `infrastructure/` | nginx and configuration templates |
| `deployment/` | Deployment scripts and environment templates |
| `monitoring/` | Prometheus scrape configuration |
| `audit/` | Rust audit test-suite crate (storage, reputation, consensus, activation security) |
| `governance/` | DAO design material |
| `testing/` | Standalone test material outside the Cargo workspace |
| `scripts/` | Node install and helper scripts |
| `docs/` | The documentation set indexed below |

## Quick start

Full prerequisites, activation, firewall rules, key handling and migration are in
[docs/operators/running-a-node.md](docs/operators/running-a-node.md). The minimal Super-node
invocation, from the repository root:

```bash
docker build -f development/qnet-integration/Dockerfile.production -t qnet-production .

docker run -d --name my-qnet-node --restart=always \
  -e QNET_PRODUCTION=1 \
  -e DOCKER_ENV=1 \
  -e QNET_ACTIVATION_CODE="<your activation code>" \
  -e QNET_BURN_TX_HASH="<your Solana burn transaction signature>" \
  -e QNET_BURN_AMOUNT="<exact 1DEV amount burned>" \
  -e QNET_WALLET_SEED="<your BIP39 mnemonic>" \
  -p 9876:9876 -p 9877:9877 -p 8001:8001 -p 10876:10876/udp \
  -v "$(pwd)/super_node_data:/app/data" \
  qnet-production
```

To build the node binary directly instead of in Docker, the workspace produces `qnet-node` from
`development/qnet-integration`:

```bash
cargo build --release -p qnet-integration --bin qnet-node
```

The production image builds with `--profile release-fast`, which sets `overflow-checks = false`,
while `--release` leaves overflow checks on. Build with `--profile release-fast` to reproduce the
image binary.

All values above are operator-supplied and must never be committed to a repository. TCP 9876,
9877 and 8001 plus UDP 10876 must be reachable; the QUIC port is the HTTP port plus
`QUIC_PORT_OFFSET = 2875`. `DOCKER_ENV=1` pins the P2P port to 9876, the port the command
publishes, and makes the node retry that bind and exit rather than move to another port. Light nodes run inside the mobile application; see
[docs/applications/mobile-wallet.md](docs/applications/mobile-wallet.md).

## Documentation

| Document | Covers |
| --- | --- |
| [docs/README.md](docs/README.md) | Documentation index |
| [docs/architecture/overview.md](docs/architecture/overview.md) | System overview and component map |
| [docs/architecture/consensus.md](docs/architecture/consensus.md) | Block production, rotation, finality, failover |
| [docs/architecture/cryptography.md](docs/architecture/cryptography.md) | Signatures, hashes, addresses, transport security |
| [docs/architecture/state.md](docs/architecture/state.md) | Accounts, state commitment, storage, transaction types |
| [docs/architecture/networking.md](docs/architecture/networking.md) | P2P transport, message types, peer discovery |
| [docs/economics/overview.md](docs/economics/overview.md) | Emission schedule, reward pools, claims, fees |
| [docs/economics/node-activation.md](docs/economics/node-activation.md) | Phase 1 / Phase 2 activation and on-chain registration |
| [docs/economics/tokenomics-1dev.md](docs/economics/tokenomics-1dev.md) | The external 1DEV token on Solana |
| [docs/operators/running-a-node.md](docs/operators/running-a-node.md) | Installing and running a node |
| [docs/operators/configuration.md](docs/operators/configuration.md) | Environment variables and ports |
| [docs/operators/maintenance.md](docs/operators/maintenance.md) | Monitoring, upgrades, restart, recovery |
| [docs/developers/rpc-api.md](docs/developers/rpc-api.md) | HTTP/RPC reference |
| [docs/developers/smart-contracts.md](docs/developers/smart-contracts.md) | WASM contracts and token standards |
| [docs/developers/sdk.md](docs/developers/sdk.md) | SDK and protocol definitions |
| [docs/developers/1dev-burn-contract.md](docs/developers/1dev-burn-contract.md) | The Solana burn program used in Phase 1 activation |
| [docs/applications/mobile-wallet.md](docs/applications/mobile-wallet.md) | Mobile wallet and Light node |
| [docs/applications/browser-wallet.md](docs/applications/browser-wallet.md) | Browser extension wallet |
| [docs/applications/explorer.md](docs/applications/explorer.md) | Block explorer |
| [docs/applications/cli.md](docs/applications/cli.md) | Command-line tool |
| [QNet_Whitepaper.md](QNet_Whitepaper.md) | Protocol whitepaper |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |
| [SECURITY.md](SECURITY.md) | Vulnerability disclosure |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Third-party licences |

## Licensing

The node software is licensed under the Business Source License 1.1 (see [LICENSE](LICENSE)).
BSL 1.1 is not an open-source licence, but this deployment of it carries an Additional Use Grant
that permits production and commercial use for everything an operator or builder actually needs,
with no separate agreement, registration or fee:

- running one or more QNet nodes of any type that participate in the network, including earning
  network rewards for doing so;
- operating public endpoints from such a node — RPC, API, WebSocket, explorers, faucets,
  dashboards and similar services — for yourself or for the public, free or paid;
- developing, deploying and operating smart contracts, tokens, wallets, SDKs, bots, indexers,
  bridges and any other application that interacts with the network;
- internal business use, evaluation, testing, research, education and security research.

The restrictions are narrow and aimed at cloning rather than usage. You may not use the licensed
work or a derivative of it to operate a blockchain network other than QNet; you may not offer the
licensed work itself to third parties as a managed or hosted product where the customer's node is
the deliverable (running your own nodes and serving their endpoints publicly is expressly
permitted); you may not redistribute modified versions as a substitute for the original; and you
may not remove or alter copyright, licence or attribution notices. The licence is perpetual with
no change date, and production use beyond the Additional Use Grant requires a separate commercial
licence from the licensor.

Scope: BSL 1.1 covers `core/`, `development/` (except `development/qnet-sdk/`), `audit/`,
`governance/`, `deployment/`, `infrastructure/`, `testing/` and `monitoring/`. The client
applications under `applications/` — mobile wallet, browser extension, explorer and CLI — each
carry their own Apache-2.0 `LICENSE` file. `development/qnet-sdk/` is licensed under Apache-2.0 by
the Scope section of the root [LICENSE](LICENSE) and has no `LICENSE` file of its own. None of
these contain protocol code, and they reach the network over its HTTP API only. Third-party dependency licences are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing and security

Contribution workflow, commit conventions and the review checklist are in
[CONTRIBUTING.md](CONTRIBUTING.md). Security vulnerabilities must be reported privately following
[SECURITY.md](SECURITY.md) — please do not open a public issue for a security defect, and never
include credentials, private keys or mnemonics in any report, issue or commit.
