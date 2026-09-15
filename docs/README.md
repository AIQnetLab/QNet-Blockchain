# QNet documentation

This directory is the documentation set for the QNet blockchain: the protocol the node implements,
the economics it enforces, how to run a node, and the interfaces applications build against. Every
document here was written against the source tree in this repository. Where a document and the code
disagree, the code is authoritative — report the discrepancy rather than trusting the document.

## The system in short

A single elected producer streams microblocks on a one-second slot. Producer rotation happens every
`ROTATION_INTERVAL_BLOCKS = 30` blocks. Finality comes from Checkpoint-BFT v2: a checkpoint is taken
every `CHECKPOINT_INTERVAL = 30` microblocks and certified by a quorum certificate, and a checkpoint
is committed by the two-chain rule; each `MACROBLOCK_INTERVAL = 90`-microblock window seals its
macroblock on that commit. Every consensus, identity and gossip signature is ML-DSA-65
(FIPS 204, CRYSTALS-Dilithium3). Bulk block and consensus traffic runs over QUIC; the node
additionally makes HTTP-over-TCP node-to-node calls for block fetch, peer authentication and health
probes, so TCP 9876/9877/8001 are required alongside UDP 10876. State is a flat account model
over 45-character EON addresses, committed in a sparse Merkle tree. The protocol defines two node
types, `Light` and `Super`.

## Understand the protocol

| Document | Covers |
| --- | --- |
| [Whitepaper](../QNet_Whitepaper.md) | The protocol as a whole, in one document |
| [Architecture overview](architecture/overview.md) | Components, crate layout, and how a block moves through the node |
| [Consensus](architecture/consensus.md) | Microblock production, producer rotation, Checkpoint-BFT finality, failover |
| [Cryptography](architecture/cryptography.md) | Signature scheme, hashes, address derivation, transport security |
| [State](architecture/state.md) | Accounts, the state commitment, RocksDB storage layout, transaction types |
| [Networking](architecture/networking.md) | QUIC transport, handshake and peer identity, message types, discovery |

## Economics

| Document | Covers |
| --- | --- |
| [Economics overview](economics/overview.md) | Emission schedule, reward pools, claims, transaction fees |
| [Node activation](economics/node-activation.md) | Phase 1 and Phase 2 activation, node registration, node types |
| [1DEV token](economics/tokenomics-1dev.md) | The external 1DEV token on Solana and its role in Phase 1 |

## Run a node

| Document | Covers |
| --- | --- |
| [Running a node](operators/running-a-node.md) | Requirements, install, and starting a node |
| [Configuration](operators/configuration.md) | Environment variables, ports, and data directories |
| [Maintenance](operators/maintenance.md) | Monitoring, upgrades, restart behaviour, recovery |

## Build on it

| Document | Covers |
| --- | --- |
| [RPC API](developers/rpc-api.md) | The HTTP JSON-RPC and REST surface exposed by a node |
| [Smart contracts](developers/smart-contracts.md) | The WASM contract VM, deploy-time validation, token standards |
| [SDK](developers/sdk.md) | Client-side protocol definitions and how to build and sign transactions |
| [1DEV burn contract](developers/1dev-burn-contract.md) | The Solana Anchor program behind Phase 1 activation burns |

## Use the applications

| Document | Covers |
| --- | --- |
| [Mobile wallet](applications/mobile-wallet.md) | The React Native wallet and Light node client |
| [Browser wallet](applications/browser-wallet.md) | The browser extension wallet |
| [Explorer](applications/explorer.md) | The block explorer front end and its backend |
| [CLI](applications/cli.md) | The command-line tool |

## Repository documents

| Document | Covers |
| --- | --- |
| [README](../README.md) | Repository entry point |
| [Contributing](../CONTRIBUTING.md) | Prerequisites, build and test commands, PR expectations |
| [Security](../SECURITY.md) | Vulnerability disclosure policy and scope |
| [Third-party notices](../THIRD_PARTY_NOTICES.md) | Third-party dependencies and their licences |
| [Licence](../LICENSE) | Business Source License 1.1 for the node software |

## Suggested reading order

If you are new to the codebase, read [architecture/overview.md](architecture/overview.md) first, then
[architecture/consensus.md](architecture/consensus.md) and
[architecture/state.md](architecture/state.md). Operators can go straight to
[operators/running-a-node.md](operators/running-a-node.md) and
[operators/configuration.md](operators/configuration.md). Application developers generally need only
[developers/rpc-api.md](developers/rpc-api.md) and [developers/sdk.md](developers/sdk.md).

## Conventions used here

- Constants are given by their code name and value, for example `MACROBLOCK_INTERVAL = 90`. If a
  document states a constant, that constant exists in the source under that name.
- Limits and operating parameters are stated plainly where the mechanism they bound is described.
- Credentials, private keys and endpoint addresses are operator-supplied and are referred to by
  their variable name only.
